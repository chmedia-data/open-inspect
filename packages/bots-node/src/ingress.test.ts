import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { createLogger } from "@open-inspect/shared/logger";
import { describe, expect, it, vi } from "vitest";
import {
  createIngressGate,
  DEFAULT_INGRESS_LIMITS,
  GITHUB_INGRESS,
  LINEAR_INGRESS,
  SLACK_INGRESS,
  type IngressLimits,
  type WebhookIngress,
} from "./ingress";
import { openBotDatabase, ReplayLedger } from "./store";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const ENV = {
  GITHUB_WEBHOOK_SECRET: "gh-secret",
  GITHUB_APP_INSTALLATION_ID: "1234",
  SLACK_SIGNING_SECRET: "slack-secret",
  SLACK_ALLOWED_TEAM_IDS: "T111, T222",
  LINEAR_WEBHOOK_SECRET: "linear-secret",
  LINEAR_ALLOWED_ORGANIZATION_IDS: "org-1",
};

function setup(routes: readonly WebhookIngress[], limits: Partial<IngressLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bots-node-ingress-"));
  const ledger = new ReplayLedger(openBotDatabase(dir, () => NOW));
  const gate = createIngressGate({
    routes,
    env: ENV,
    ledger,
    limits: { ...DEFAULT_INGRESS_LIMITS, ...limits },
    log: createLogger("test", {}, "error"),
    now: () => NOW,
  });
  const forwarded: { text: string; headers: Headers }[] = [];
  const forward = vi.fn(async (request: Request) => {
    forwarded.push({ text: await request.text(), headers: request.headers });
    return Response.json({ ok: true });
  });
  const send = (request: Request) => {
    const route = gate.match(request);
    if (!route) throw new Error("no route");
    return gate.handle(route, request, forward);
  };
  return { send, forward, forwarded, gate };
}

async function githubRequest(
  payload: unknown,
  options: {
    delivery?: string;
    event?: string;
    secret?: string;
    body?: string | ReadableStream<Uint8Array>;
  } = {}
): Promise<Request> {
  const text = JSON.stringify(payload);
  const signature = await computeHmacHex(text, options.secret ?? ENV.GITHUB_WEBHOOK_SECRET);
  return new Request("http://bot/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${signature}`,
      "X-GitHub-Event": options.event ?? "issue_comment",
      "X-GitHub-Delivery": options.delivery ?? "11111111-2222-3333-4444-555555555555",
    },
    body: options.body ?? text,
    ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

const githubPayload = { action: "created", installation: { id: 1234 }, comment: { body: "hi" } };

/** A body that records whether anything read it, and never ends on its own. */
function watchedBody() {
  const state = { pulled: false, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      state.pulled = true;
      return new Promise(() => undefined);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("GitHub ingress", () => {
  it("forwards a signed delivery with the exact bytes it verified", async () => {
    const { send, forwarded } = setup([GITHUB_INGRESS]);
    const response = await send(await githubRequest(githubPayload));
    expect(response.status).toBe(200);
    expect(forwarded[0].text).toBe(JSON.stringify(githubPayload));
  });

  it("verifies the signature over the bytes received, not their decoded text", async () => {
    const { send, forwarded } = setup([GITHUB_INGRESS]);
    // A UTF-8 byte order mark, which decoding to text drops.
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(JSON.stringify(githubPayload)),
    ]);
    const request = (signature: string) =>
      new Request("http://bot/webhooks/github", {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": `sha256=${signature}`,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "aaaa-bbbb",
        },
        body: bytes,
      });
    const overText = await computeHmacHex(JSON.stringify(githubPayload), ENV.GITHUB_WEBHOOK_SECRET);
    expect((await send(request(overText))).status).toBe(401);
    const overBytes = await computeHmacHex(bytes, ENV.GITHUB_WEBHOOK_SECRET);
    expect((await send(request(overBytes))).status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  it("rejects a forged signature without forwarding", async () => {
    const { send, forward } = setup([GITHUB_INGRESS]);
    const response = await send(await githubRequest(githubPayload, { secret: "wrong" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("rejects malformed signature headers before reading the body", async () => {
    const { send } = setup([GITHUB_INGRESS]);
    for (const header of ["", "sha256=", "sha1=abc", `sha256=${"g".repeat(64)}`]) {
      const { stream, state } = watchedBody();
      const request = new Request("http://bot/webhooks/github", {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": header,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "d-1",
        },
        body: stream,
        duplex: "half",
      } as RequestInit);
      const response = await send(request);
      expect(response.status).toBe(401);
      expect(state.pulled).toBe(false);
    }
  });

  it("refuses a declared oversized body without reading it", async () => {
    const { send } = setup([GITHUB_INGRESS], { maxBodyBytes: 16 });
    const request = await githubRequest(githubPayload);
    const response = await send(
      new Request(request, {
        headers: { ...Object.fromEntries(request.headers), "content-length": "17" },
      })
    );
    expect(response.status).toBe(413);
  });

  it("stops reading a chunked body at the cap and cancels it", async () => {
    const { send, forward } = setup([GITHUB_INGRESS], { maxBodyBytes: 1024 });
    const state = { chunks: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.chunks++;
        controller.enqueue(new Uint8Array(512));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const response = await send(await githubRequest(githubPayload, { body: stream }));
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.chunks).toBeLessThanOrEqual(4);
    expect(forward).not.toHaveBeenCalled();
  });

  it("gives up on a body that does not arrive within the deadline", async () => {
    const { send } = setup([GITHUB_INGRESS], { bodyTimeoutMs: 20 });
    const { stream, state } = watchedBody();
    const response = await send(await githubRequest(githubPayload, { body: stream }));
    expect(response.status).toBe(408);
    expect(state.cancelled).toBe(true);
  });

  it("turns away reads beyond the concurrency bound", async () => {
    const { send } = setup([GITHUB_INGRESS], { maxConcurrentReads: 1, bodyTimeoutMs: 50 });
    const slow = send(await githubRequest(githubPayload, { body: watchedBody().stream }));
    const response = await send(await githubRequest(githubPayload, { delivery: "0000-0003" }));
    expect(response.status).toBe(503);
    expect((await slow).status).toBe(408);
  });

  it("refuses a delivery for another installation, and one naming none", async () => {
    const { send, forward } = setup([GITHUB_INGRESS]);
    const other = await send(
      await githubRequest(
        { ...githubPayload, installation: { id: 999 } },
        { delivery: "0000-0004" }
      )
    );
    const none = await send(await githubRequest({ action: "created" }, { delivery: "0000-0005" }));
    expect(other.status).toBe(403);
    expect(none.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("lets GitHub's ping through without an installation", async () => {
    const { send } = setup([GITHUB_INGRESS]);
    const response = await send(await githubRequest({ zen: "hi" }, { event: "ping" }));
    expect(response.status).toBe(200);
  });

  it("passes a redelivery of the same delivery to the bot, which dedupes it", async () => {
    const { send, forward } = setup([GITHUB_INGRESS]);
    expect((await send(await githubRequest(githubPayload))).status).toBe(200);
    expect((await send(await githubRequest(githubPayload))).status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("refuses a captured body replayed under a new delivery id", async () => {
    const { send, forward } = setup([GITHUB_INGRESS]);
    await send(await githubRequest(githubPayload, { delivery: "0000-0001" }));
    const replay = await send(await githubRequest(githubPayload, { delivery: "0000-0002" }));
    expect(replay.status).toBe(409);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("holds a concurrent duplicate while the first is being handled", async () => {
    const { gate } = setup([GITHUB_INGRESS]);
    let release!: () => void;
    const forward = vi.fn(
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response("ok"))))
    );
    const first = await githubRequest(githubPayload);
    const pending = gate.handle(GITHUB_INGRESS, first, forward);
    await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(1));
    const duplicate = await gate.handle(
      GITHUB_INGRESS,
      await githubRequest(githubPayload),
      forward
    );
    expect(duplicate.status).toBe(503);
    release();
    expect((await pending).status).toBe(200);
  });
});

async function slackRequest(
  path: "/events" | "/interactions",
  body: string,
  options: { timestamp?: number; secret?: string } = {}
): Promise<Request> {
  const timestamp = String(options.timestamp ?? Math.floor(NOW / 1000));
  const signature = await computeHmacHex(
    `v0:${timestamp}:${body}`,
    options.secret ?? ENV.SLACK_SIGNING_SECRET
  );
  return new Request(`http://bot${path}`, {
    method: "POST",
    headers: { "X-Slack-Signature": `v0=${signature}`, "X-Slack-Request-Timestamp": timestamp },
    body,
  });
}

describe("Slack ingress", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const event = JSON.stringify({ type: "event_callback", team_id: "T111", event_id: "Ev1" });

  it("forwards a signed event from an allowed workspace", async () => {
    const { send } = setup(SLACK_INGRESS);
    expect((await send(await slackRequest("/events", event))).status).toBe(200);
  });

  it("rejects a forged signature, and a stale timestamp before reading the body", async () => {
    const { send, forward } = setup(SLACK_INGRESS);
    expect((await send(await slackRequest("/events", event, { secret: "x" }))).status).toBe(401);
    const signed = await slackRequest("/events", event, { timestamp: NOW / 1000 - 301 });
    const { stream, state } = watchedBody();
    const response = await send(
      new Request(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: stream,
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "stale_timestamp" });
    expect(state.pulled).toBe(false);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses an event or interaction from another workspace", async () => {
    const { send } = setup(SLACK_INGRESS);
    const otherEvent = JSON.stringify({ type: "event_callback", team_id: "T999", event_id: "Ev2" });
    const otherInteraction = new URLSearchParams({
      payload: JSON.stringify({ type: "block_actions", team: { id: "T999" } }),
    }).toString();
    expect((await send(await slackRequest("/events", otherEvent))).status).toBe(403);
    expect((await send(await slackRequest("/interactions", otherInteraction))).status).toBe(403);
  });

  it("accepts an interaction from an allowed workspace", async () => {
    const { send } = setup(SLACK_INGRESS);
    const body = new URLSearchParams({
      payload: JSON.stringify({ type: "block_actions", team: { id: "T222" } }),
    }).toString();
    expect((await send(await slackRequest("/interactions", body))).status).toBe(200);
  });

  it("answers only a signed URL verification", async () => {
    const { send } = setup(SLACK_INGRESS);
    const challenge = JSON.stringify({ type: "url_verification", challenge: "c" });
    expect((await send(await slackRequest("/events", challenge))).status).toBe(200);
    const unsigned = new Request("http://bot/events", { method: "POST", body: challenge });
    expect((await send(unsigned)).status).toBe(401);
  });

  it("refuses a replayed signed request", async () => {
    const { send, forward } = setup(SLACK_INGRESS);
    expect((await send(await slackRequest("/events", event))).status).toBe(200);
    expect((await send(await slackRequest("/events", event))).status).toBe(409);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

async function linearRequest(
  payload: Record<string, unknown>,
  options: { secret?: string; delivery?: string } = {}
): Promise<Request> {
  const text = JSON.stringify(payload);
  const signature = await computeHmacHex(text, options.secret ?? ENV.LINEAR_WEBHOOK_SECRET);
  return new Request("http://bot/webhook", {
    method: "POST",
    headers: {
      "Linear-Signature": signature,
      "Linear-Delivery": options.delivery ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    body: text,
  });
}

describe("Linear ingress", () => {
  const payload = { type: "AgentSessionEvent", organizationId: "org-1", webhookTimestamp: NOW };

  it("forwards a fresh signed webhook from the pinned organization", async () => {
    const { send } = setup([LINEAR_INGRESS]);
    expect((await send(await linearRequest(payload))).status).toBe(200);
  });

  it("rejects a forged signature", async () => {
    const { send } = setup([LINEAR_INGRESS]);
    expect((await send(await linearRequest(payload, { secret: "x" }))).status).toBe(401);
  });

  it("rejects a stale or missing webhookTimestamp", async () => {
    const { send } = setup([LINEAR_INGRESS]);
    const stale = await send(await linearRequest({ ...payload, webhookTimestamp: NOW - 301_000 }));
    const missing = await send(await linearRequest({ ...payload, webhookTimestamp: undefined }));
    expect(stale.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it("refuses another organization", async () => {
    const { send } = setup([LINEAR_INGRESS]);
    const response = await send(await linearRequest({ ...payload, organizationId: "org-2" }));
    expect(response.status).toBe(403);
  });

  it("refuses a replay, even under a new Linear-Delivery header", async () => {
    const { send, forward } = setup([LINEAR_INGRESS]);
    await send(await linearRequest(payload, { delivery: "1-1" }));
    const replay = await send(await linearRequest(payload, { delivery: "2-2" }));
    expect(replay.status).toBe(409);
    expect(forward).toHaveBeenCalledTimes(1);
  });
  it("gives the claim back when the bot fails, so the provider's retry gets through", async () => {
    const { send, forward } = setup([LINEAR_INGRESS]);
    forward.mockImplementationOnce(async () => new Response("down", { status: 502 }));
    forward.mockImplementationOnce(async () => {
      throw new Error("bot crashed");
    });
    expect((await send(await linearRequest(payload))).status).toBe(502);
    await expect(send(await linearRequest(payload))).rejects.toThrow("bot crashed");
    expect((await send(await linearRequest(payload))).status).toBe(200);
    expect((await send(await linearRequest(payload))).status).toBe(409);
    expect(forward).toHaveBeenCalledTimes(3);
  });

  it("keeps the claim when the bot answers below 500", async () => {
    const { send, forward } = setup([LINEAR_INGRESS]);
    forward.mockImplementationOnce(async () => new Response("bad", { status: 400 }));
    expect((await send(await linearRequest(payload))).status).toBe(400);
    expect((await send(await linearRequest(payload))).status).toBe(409);
  });
});
