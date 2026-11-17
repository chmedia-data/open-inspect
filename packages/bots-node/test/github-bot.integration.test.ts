/**
 * The GitHub bot end to end under this host: real listeners, a signed
 * webhook in, and a fake control plane on its own HTTP port that verifies
 * every request's sig1 signature as the real one would. GitHub's API is the
 * only thing stubbed in-process.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOTS } from "../src/bots";
import { DEFAULT_INGRESS_LIMITS } from "../src/ingress";
import { startBotHost, type BotHost } from "../src/host";

const WEBHOOK_SECRET = "webhook-secret";
const SERVICE_SECRET = "github-bot-service-secret";
const INSTALLATION_ID = "4242";
const realFetch = globalThis.fetch;

interface ReceivedRequest {
  method: string;
  path: string;
  body: string;
  service: string | null;
  verified: boolean;
}

/** The control plane's side: every request must carry a valid github-bot signature. */
function startFakeControlPlane(
  respond: (request: ReceivedRequest) => Promise<Response> | Response
) {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = `http://${req.headers.host}${req.url}`;
    const verified = await verifyServiceSignature({
      signatureHeader: String(req.headers[SERVICE_SIGNATURE_HEADER.toLowerCase()] ?? ""),
      service: "github-bot",
      secret: SERVICE_SECRET,
      method: req.method ?? "GET",
      url,
      bodySha256Hex: await sha256Hex(body),
      actor: String(req.headers[ACTOR_HEADER.toLowerCase()] ?? ""),
    });
    const request: ReceivedRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "",
      body,
      service: (req.headers[SERVICE_HEADER.toLowerCase()] as string | undefined) ?? null,
      verified: verified.ok,
    };
    received.push(request);
    const response = verified.ok
      ? await respond(request)
      : new Response("bad signature", { status: 401 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise<{ server: Server; url: string; received: ReceivedRequest[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, received });
    });
  });
}

function controlPlaneResponses(request: ReceivedRequest): Response {
  if (request.path.startsWith("/github/route?")) {
    return Response.json({ teamId: null, via: "workspace" });
  }
  if (request.path.startsWith("/integration-settings/github/resolved/")) {
    return Response.json({ config: null });
  }
  if (request.path.endsWith("/metadata"))
    return Response.json({ repo: "acme/widgets", metadata: null });
  if (request.path.startsWith("/model-preferences")) return Response.json({ enabledModels: [] });
  if (request.path === "/sessions")
    return Response.json({ sessionId: "session-1", status: "created" });
  if (request.path.endsWith("/prompt")) return Response.json({ messageId: "message-1" });
  if (request.path === "/internal/github-autofix") return new Response(null, { status: 202 });
  if (request.path === "/internal/github-event") return Response.json({ ok: true });
  return new Response("unexpected", { status: 404 });
}

/** GitHub's API, as the bot calls it with the installation token. */
const githubApi: string[] = [];
function stubGitHubApi() {
  githubApi.length = 0;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
      githubApi.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (url.includes("/collaborators/")) return Response.json({ permission: "write" });
      return Response.json({ id: 1 }, { status: 201 });
    }
  );
}

async function signedWebhook(
  host: BotHost,
  event: string,
  payload: unknown,
  delivery: string,
  secret = WEBHOOK_SECRET
): Promise<Response> {
  const body = JSON.stringify(payload);
  return realFetch(`http://127.0.0.1:${host.publicAddress.port}/webhooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": `sha256=${await computeHmacHex(body, secret)}`,
    },
    body,
  });
}

const repository = { id: 99, owner: { login: "acme" }, name: "widgets", private: true };
const sender = { login: "alice", id: 1001, avatar_url: "https://avatars.example/u/1001" };
const pullRequest = {
  number: 7,
  title: "Add widgets",
  body: null,
  user: { login: "alice" },
  head: { ref: "feature", sha: "abc123" },
  base: { ref: "main" },
};

describe("the GitHub bot under the Node host", () => {
  let controlPlane: Awaited<ReturnType<typeof startFakeControlPlane>>;
  let host: BotHost;
  let respond: (request: ReceivedRequest) => Promise<Response> | Response;

  beforeEach(async () => {
    stubGitHubApi();
    respond = controlPlaneResponses;
    controlPlane = await startFakeControlPlane((request) => respond(request));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    host = await startBotHost({
      bot: BOTS.github,
      env: {
        CONTROL_PLANE_URL: controlPlane.url,
        SERVICE_AUTH_SECRET: SERVICE_SECRET,
        DEPLOYMENT_NAME: "test",
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
        GITHUB_BOT_USERNAME: "inspect-bot[bot]",
        DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
        LOG_LEVEL: "error",
      },
      settings: {
        host: "127.0.0.1",
        port: 0,
        internalPort: 0,
        dataDir: mkdtempSync(join(tmpdir(), "bots-node-github-")),
        shutdownTimeoutMs: 5_000,
        limits: DEFAULT_INGRESS_LIMITS,
      },
      fetchImpl: realFetch,
    });
  });

  afterEach(async () => {
    await host.shutdown();
    await new Promise((resolve) => controlPlane.server.close(resolve));
    vi.unstubAllGlobals();
  });

  it("forwards a closed pull request to the control plane as a signed internal event", async () => {
    const response = await signedWebhook(
      host,
      "pull_request",
      {
        action: "closed",
        repository,
        sender: { login: "alice" },
        installation: { id: Number(INSTALLATION_ID) },
        pull_request: {
          ...pullRequest,
          state: "closed",
          draft: false,
          merged: true,
          html_url: "https://github.com/acme/widgets/pull/7",
          created_at: "2026-11-10T10:00:00Z",
          updated_at: "2026-11-14T11:00:00Z",
          merged_at: "2026-11-14T10:59:00Z",
          closed_at: "2026-11-14T11:00:00Z",
          labels: [],
          head: { ref: "feature", sha: "abc123", repo: { id: 99 } },
          base: { ref: "main", repo: { id: 99 } },
        },
      },
      "00000000-0000-4000-8000-000000000009"
    );
    expect(response.status).toBe(200);

    await vi.waitFor(() =>
      expect(controlPlane.received.map((request) => request.path)).toContain(
        "/internal/github-event"
      )
    );
    const [forwarded] = controlPlane.received;
    expect(forwarded).toMatchObject({ method: "POST", service: "github-bot", verified: true });
    expect(JSON.parse(forwarded.body)).toMatchObject({
      eventType: "pull_request.closed",
      repoOwner: "acme",
      repoName: "widgets",
      pullRequest: { number: 7, merged: true },
    });
  });

  it("starts a review session for a review request, every call signed", async () => {
    const response = await signedWebhook(
      host,
      "pull_request",
      {
        action: "review_requested",
        pull_request: pullRequest,
        requested_reviewer: { login: "inspect-bot[bot]" },
        repository,
        sender,
        installation: { id: Number(INSTALLATION_ID) },
      },
      "00000000-0000-4000-8000-000000000001"
    );
    expect(response.status).toBe(200);

    await vi.waitFor(() =>
      expect(controlPlane.received.map((request) => request.path)).toContain(
        "/sessions/session-1/prompt"
      )
    );
    expect(controlPlane.received.every((request) => request.verified)).toBe(true);
    expect(controlPlane.received.every((request) => request.service === "github-bot")).toBe(true);
    expect(githubApi).toContain("POST /app/installations/4242/access_tokens");
  });

  it("starts a session for an @mention in a PR comment", async () => {
    const response = await signedWebhook(
      host,
      "issue_comment",
      {
        action: "created",
        issue: {
          number: 7,
          title: "Add widgets",
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
          user: { login: "alice" },
        },
        comment: { id: 555, body: "@inspect-bot[bot] please summarize", user: { login: "alice" } },
        repository,
        sender,
        installation: { id: Number(INSTALLATION_ID) },
      },
      "00000000-0000-4000-8000-000000000002"
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(controlPlane.received.map((request) => request.path)).toContain(
        "/sessions/session-1/prompt"
      )
    );
    expect(controlPlane.received.some((r) => r.path === "/internal/github-autofix")).toBe(false);
  });

  it("hands a plain PR comment to the control plane's Autofix queue", async () => {
    const response = await signedWebhook(
      host,
      "issue_comment",
      {
        action: "created",
        issue: {
          number: 7,
          title: "Add widgets",
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
          user: { login: "alice" },
        },
        comment: { id: 556, body: "nit: rename this", user: { login: "bob" } },
        repository,
        sender,
        installation: { id: Number(INSTALLATION_ID) },
      },
      "00000000-0000-4000-8000-000000000003"
    );
    expect(response.status).toBe(200);
    const autofix = controlPlane.received.find((r) => r.path === "/internal/github-autofix");
    expect(autofix?.verified).toBe(true);
    expect(JSON.parse(autofix!.body)).toMatchObject({
      version: 1,
      deliveryId: "00000000-0000-4000-8000-000000000003",
      eventType: "issue_comment",
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 7,
      providerObject: { kind: "pr_comment", id: "556" },
    });
  });

  it("answers 503 when the control plane refuses the Autofix job, so GitHub can redeliver", async () => {
    respond = (request) =>
      request.path === "/internal/github-autofix"
        ? new Response(null, { status: 500 })
        : controlPlaneResponses(request);
    const response = await signedWebhook(
      host,
      "issue_comment",
      {
        action: "created",
        issue: {
          number: 7,
          title: "x",
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
          user: { login: "alice" },
        },
        comment: { id: 557, body: "please fix", user: { login: "bob" } },
        repository,
        sender,
        installation: { id: Number(INSTALLATION_ID) },
      },
      "00000000-0000-4000-8000-000000000004"
    );
    expect(response.status).toBe(503);
  });

  it("refuses a forged webhook and never calls the control plane", async () => {
    const response = await signedWebhook(
      host,
      "pull_request",
      { action: "closed", repository, installation: { id: Number(INSTALLATION_ID) } },
      "00000000-0000-4000-8000-000000000005",
      "not-the-secret"
    );
    expect(response.status).toBe(401);
    expect(controlPlane.received).toEqual([]);
  });

  it("starts one session for a duplicate delivery and refuses its body under another id", async () => {
    const payload = {
      action: "review_requested",
      pull_request: pullRequest,
      requested_reviewer: { login: "inspect-bot[bot]" },
      repository,
      sender,
      installation: { id: Number(INSTALLATION_ID) },
    };
    const delivery = "00000000-0000-4000-8000-000000000006";
    expect((await signedWebhook(host, "pull_request", payload, delivery)).status).toBe(200);
    await vi.waitFor(() =>
      expect(controlPlane.received.some((r) => r.path.endsWith("/prompt"))).toBe(true)
    );
    const again = await signedWebhook(host, "pull_request", payload, delivery);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const forged = await signedWebhook(
      host,
      "pull_request",
      payload,
      "00000000-0000-4000-8000-000000000007"
    );
    expect(forged.status).toBe(409);
    expect(controlPlane.received.filter((r) => r.path === "/sessions")).toHaveLength(1);
  });

  it("serves only health and the webhook publicly", async () => {
    const base = `http://127.0.0.1:${host.publicAddress.port}`;
    expect((await realFetch(`${base}/health`)).status).toBe(200);
    expect((await realFetch(`${base}/webhooks/github`)).status).toBe(404);
    expect((await realFetch(`${base}/anything`, { method: "POST" })).status).toBe(404);
  });

  it("waits for background work on shutdown", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve));
    let promptAnswered = false;
    respond = async (request) => {
      if (request.path.endsWith("/prompt")) {
        await promptGate;
        promptAnswered = true;
      }
      return controlPlaneResponses(request);
    };
    await signedWebhook(
      host,
      "pull_request",
      {
        action: "review_requested",
        pull_request: pullRequest,
        requested_reviewer: { login: "inspect-bot[bot]" },
        repository,
        sender,
        installation: { id: Number(INSTALLATION_ID) },
      },
      "00000000-0000-4000-8000-000000000008"
    );
    await vi.waitFor(() =>
      expect(controlPlane.received.some((r) => r.path.endsWith("/prompt"))).toBe(true)
    );

    const stopping = host.shutdown();
    setTimeout(releasePrompt, 50);
    expect(await stopping).toEqual({ clean: true });
    expect(promptAnswered).toBe(true);
  });
});
