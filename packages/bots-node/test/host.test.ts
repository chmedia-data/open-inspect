/**
 * The host's own behavior with stand-in Workers (queue consumption, waitUntil,
 * the listener split), and the Slack and Linear Workers served under it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOTS, type BotDefinition } from "../src/bots";
import { startBotHost, type BotHost } from "../src/host";
import { DEFAULT_INGRESS_LIMITS } from "../src/ingress";

const hosts: BotHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
});

async function start(bot: BotDefinition, env: Record<string, string> = {}) {
  const host = await startBotHost({
    bot,
    env: {
      CONTROL_PLANE_URL: "http://127.0.0.1:9",
      SERVICE_AUTH_SECRET: "service-secret",
      DEPLOYMENT_NAME: "test",
      LOG_LEVEL: "error",
      ...env,
    },
    settings: {
      host: "127.0.0.1",
      port: 0,
      internalPort: 0,
      dataDir: mkdtempSync(join(tmpdir(), "bots-node-host-")),
      shutdownTimeoutMs: 2_000,
      limits: DEFAULT_INGRESS_LIMITS,
    },
  });
  hosts.push(host);
  return {
    host,
    publicUrl: `http://127.0.0.1:${host.publicAddress.port}`,
    internalUrl: `http://127.0.0.1:${host.internalAddress.port}`,
  };
}

function fakeBot(overrides: Partial<BotDefinition>): BotDefinition {
  return {
    name: "github",
    service: "github-bot",
    worker: { fetch: async () => new Response("from worker") },
    kvBinding: "TEST_KV",
    ingress: [],
    requiredEnv: [],
    blockedPathPrefixes: [],
    ...overrides,
  };
}

describe("the host", () => {
  it("refuses to start without the bot's required configuration", async () => {
    await expect(start(fakeBot({ requiredEnv: ["NEEDED"] }))).rejects.toThrow(
      "Missing required configuration for the github bot: NEEDED"
    );
  });

  it("serves the Worker's other routes on the internal listener only, minus blocked ones", async () => {
    const { publicUrl, internalUrl } = await start(fakeBot({ blockedPathPrefixes: ["/oauth/"] }));
    expect((await fetch(`${publicUrl}/callbacks/complete`, { method: "POST" })).status).toBe(404);
    const internal = await fetch(`${internalUrl}/callbacks/complete`, { method: "POST" });
    expect(await internal.text()).toBe("from worker");
    expect((await fetch(`${internalUrl}/oauth/authorize`)).status).toBe(404);
    expect((await fetch(`${publicUrl}/health`)).status).toBe(200);
  });

  it("gives the Worker a durable KV and a tracked waitUntil", async () => {
    const failed = vi.fn();
    const bot = fakeBot({
      worker: {
        async fetch(_request, env, ctx) {
          const kv = (env as unknown as { TEST_KV: KVNamespace }).TEST_KV;
          const count = Number((await kv.get("count")) ?? 0) + 1;
          await kv.put("count", String(count));
          ctx.waitUntil(Promise.reject(new Error("background failure")).catch(failed));
          return new Response(String(count));
        },
      },
    });
    const { internalUrl } = await start(bot);
    expect(await (await fetch(`${internalUrl}/x`)).text()).toBe("1");
    expect(await (await fetch(`${internalUrl}/x`)).text()).toBe("2");
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(2));
  });

  it("consumes its own queue: acks, retries, and dead-letters at the limit", async () => {
    const deliveries: { body: unknown; attempts: number }[] = [];
    const bot = fakeBot({
      worker: {
        async fetch(request, env) {
          const queue = (env as unknown as { JOBS: Queue }).JOBS;
          await queue.send(await request.json());
          return new Response("queued");
        },
      },
      queue: {
        binding: "JOBS",
        maxAttempts: 2,
        retryDelayMs: 0,
        async consume(batch) {
          for (const message of batch.messages) {
            deliveries.push({ body: message.body, attempts: message.attempts });
            if ((message.body as { fail: boolean }).fail) message.retry();
            else message.ack();
          }
        },
      },
    });
    const { internalUrl } = await start(bot);
    const send = (body: unknown) =>
      fetch(`${internalUrl}/enqueue`, { method: "POST", body: JSON.stringify(body) });
    await send({ fail: false });
    await send({ fail: true });

    await vi.waitFor(() => expect(deliveries).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(deliveries).toEqual([
      { body: { fail: false }, attempts: 1 },
      { body: { fail: true }, attempts: 1 },
      { body: { fail: true }, attempts: 2 },
    ]);
    const health = await (await fetch(`${internalUrl}/health`)).json();
    expect(health).toMatchObject({ queue_dead: 1 });
  });
});

describe("the Slack bot under the host", () => {
  const env = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_ALLOWED_TEAM_IDS: "T111",
    WEB_APP_URL: "https://inspect.example",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
  };

  async function slackPost(url: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await computeHmacHex(`v0:${timestamp}:${body}`, env.SLACK_SIGNING_SECRET);
    return fetch(url, {
      method: "POST",
      headers: { "X-Slack-Signature": `v0=${signature}`, "X-Slack-Request-Timestamp": timestamp },
      body,
    });
  }

  it("answers a signed URL verification and refuses another workspace", async () => {
    const { publicUrl } = await start(BOTS.slack, env);
    const challenge = await slackPost(
      `${publicUrl}/events`,
      JSON.stringify({ type: "url_verification", challenge: "abc" })
    );
    expect(await challenge.json()).toEqual({ challenge: "abc" });

    const other = await slackPost(
      `${publicUrl}/events`,
      JSON.stringify({ type: "event_callback", team_id: "T999", event_id: "Ev1" })
    );
    expect(other.status).toBe(403);
  });

  it("keeps control-plane callbacks off the public listener", async () => {
    const { publicUrl, internalUrl } = await start(BOTS.slack, env);
    expect((await fetch(`${publicUrl}/callbacks/complete`, { method: "POST" })).status).toBe(404);
    // Reaches the Worker, which refuses the unsigned callback itself.
    const internal = await fetch(`${internalUrl}/callbacks/complete`, {
      method: "POST",
      body: "{}",
    });
    expect([400, 401]).toContain(internal.status);
  });
});

describe("the Linear bot under the host", () => {
  const env = {
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "client-secret",
    LINEAR_ALLOWED_ORGANIZATION_IDS: "org-1",
    WEB_APP_URL: "https://inspect.example",
    WORKER_URL: "https://linear-bot.example",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
  };

  it("does not serve the OAuth installation routes on either listener", async () => {
    const { publicUrl, internalUrl } = await start(BOTS.linear, env);
    for (const base of [publicUrl, internalUrl]) {
      expect((await fetch(`${base}/oauth/authorize`, { redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${base}/oauth/callback?code=x`)).status).toBe(404);
    }
  });

  it("passes a fresh signed webhook from the pinned organization to the Worker", async () => {
    const { publicUrl } = await start(BOTS.linear, env);
    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    });
    const response = await fetch(`${publicUrl}/webhook`, {
      method: "POST",
      headers: {
        "Linear-Signature": await computeHmacHex(body, env.LINEAR_WEBHOOK_SECRET),
        "Linear-Delivery": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      body,
    });
    expect(await response.json()).toMatchObject({ ok: true, skipped: true });
  });
});
