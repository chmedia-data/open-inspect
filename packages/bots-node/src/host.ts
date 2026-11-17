/**
 * The Node host for one bot Worker: the Worker's `fetch` (and `queue`)
 * served over HTTP with its Cloudflare bindings stood in for.
 *
 * - `CONTROL_PLANE`: an HTTP fetcher to `CONTROL_PLANE_URL`. The bots sign
 *   their requests exactly as on Workers; only the origin changes.
 * - KV: the bot's namespace in SQLite under `DATA_DIR` (src/store.ts).
 * - `ctx.waitUntil`: promises tracked, logged when they fail, and awaited on
 *   shutdown.
 * - Queues: the GitHub bot's Autofix queue is the control plane's, reached
 *   through a signed internal route; Slack's completion queue is its own,
 *   kept in SQLite and consumed here.
 *
 * Two listeners. The public one serves `/health` and the bot's webhook
 * routes, each behind the ingress gate (src/ingress.ts), and nothing else.
 * The internal one, for the control plane on a private network, serves the
 * same plus the bot's `internalRoutes` (the callbacks the control plane
 * makes), each body read under the same cap and deadline. Every other route
 * the Worker has is served by neither. Both refuse a path that is not in
 * canonical form (any `%`), since the Worker's router would decode it into
 * a route these checks did not see.
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, parseLogLevel, type Logger } from "@open-inspect/shared/logger";
import {
  createServiceUrlFetcher,
  signedControlPlaneFetch,
} from "@open-inspect/shared/service-auth";
import type { BotDefinition } from "./bots";
import { createIngressGate, readBounded, type IngressLimits } from "./ingress";
import { openBotDatabase, ReplayLedger, SqliteKv, SqliteQueue } from "./store";

export interface BotHostSettings {
  host: string;
  port: number;
  internalPort: number;
  dataDir: string;
  shutdownTimeoutMs: number;
  limits: IngressLimits;
}

export interface BotHostOptions {
  bot: BotDefinition;
  /** The process environment: the bot's variables under its Worker's names. */
  env: Record<string, string | undefined>;
  settings: BotHostSettings;
  /** Outbound fetch for the control plane; tests point it at a fake. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface BotHost {
  readonly publicAddress: AddressInfo;
  readonly internalAddress: AddressInfo;
  /** Stop listening, wait for requests and background work within the budget, close the store. */
  shutdown(): Promise<{ clean: boolean }>;
}

/** How long a claimed queue message stays hidden before it is redelivered. */
const QUEUE_LEASE_MS = 5 * 60 * 1000;
/** How often the queue looks for due work when nothing wakes it sooner. */
const QUEUE_POLL_MS = 1_000;
/** How often expired KV entries and replay records are deleted. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Tracked `waitUntil` work: logged on failure, awaited on shutdown. */
class BackgroundWork {
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly log: Logger) {}

  get size(): number {
    return this.running.size;
  }

  track(promise: Promise<unknown>): void {
    const tracked: Promise<unknown> = Promise.resolve(promise)
      .catch((error: unknown) => this.log.error("wait_until.failed", { error: errorOf(error) }))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /** Wait for everything running, including work started meanwhile; false at the deadline. */
  async drain(deadline: number): Promise<boolean> {
    while (this.running.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...this.running]).then(() => false),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), remaining))),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
    }
    return true;
  }

  context(): ExecutionContext {
    return {
      waitUntil: (promise) => this.track(promise),
      passThroughOnException: () => undefined,
      props: {},
    };
  }
}

/**
 * A path the Worker's router will see exactly as written: no percent-encoding to decode
 * (`/%6Fauth/` would route to `/oauth/`), and unchanged by URL normalization.
 */
function isCanonicalPath(pathname: string): boolean {
  return !pathname.includes("%") && new URL(pathname, "http://host").pathname === pathname;
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

export async function startBotHost(options: BotHostOptions): Promise<BotHost> {
  const { bot, settings } = options;
  const log = createLogger(
    "bots-node",
    { bot: bot.name },
    parseLogLevel(options.env.LOG_LEVEL),
    bot.service
  );
  const missing = bot.requiredEnv.filter((name) => !options.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration for the ${bot.name} bot: ${missing.join(", ")}`
    );
  }

  const store = openBotDatabase(settings.dataDir, options.now);
  const background = new BackgroundWork(log);
  const controlPlane = createServiceUrlFetcher(
    options.env.CONTROL_PLANE_URL as string,
    options.fetchImpl
  );
  const queue = bot.queue ? new SqliteQueue(store) : undefined;

  const env: Record<string, unknown> = {
    ...options.env,
    CONTROL_PLANE: controlPlane,
    [bot.kvBinding]: new SqliteKv(store),
  };
  if (bot.queue && queue) {
    env[bot.queue.binding] = {
      async send(body: unknown, sendOptions?: { delaySeconds?: number }) {
        queue.send(body, (sendOptions?.delaySeconds ?? 0) * 1000);
        wakeQueue();
      },
    };
  }
  if (bot.controlPlaneQueue) {
    const { path } = bot.controlPlaneQueue;
    env[bot.controlPlaneQueue.binding] = {
      async send(body: unknown) {
        const response = await signedControlPlaneFetch(
          bot.service,
          { SERVICE_AUTH_SECRET: options.env.SERVICE_AUTH_SECRET, CONTROL_PLANE: controlPlane },
          { method: "POST", url: `https://internal${path}`, body: JSON.stringify(body) }
        );
        if (!response.ok) {
          // The bot answers GitHub 503, which GitHub does not retry: it needs a manual redelivery.
          log.error("autofix.refused", { http_status: response.status });
          throw new Error(`Control plane refused the job: ${response.status}`);
        }
      },
    };
  }

  const gate = createIngressGate({
    routes: bot.ingress,
    env: options.env,
    ledger: new ReplayLedger(store),
    limits: settings.limits,
    log,
    now: options.now,
  });

  const callWorker = async (request: Request): Promise<Response> =>
    bot.worker.fetch(request, env as never, background.context());

  const health = (): Response =>
    Response.json(
      {
        status: draining ? "draining" : "healthy",
        service: `open-inspect-${bot.service}`,
        background_tasks: background.size,
        ...(queue ? { queue_dead: queue.deadCount() } : {}),
      },
      { status: draining ? 503 : 200, headers: { "Cache-Control": "no-store" } }
    );

  const notFound = (): Response => new Response("Not Found", { status: 404 });
  const isInternalRoute = (pathname: string): boolean =>
    bot.internalRoutes.some((entry) =>
      entry.endsWith("/") ? pathname.startsWith(entry) : pathname === entry
    );

  /** An internal route's body, read under the gate's cap and deadline before the Worker runs. */
  const callWorkerBounded = async (request: Request): Promise<Response> => {
    const bytes = await readBounded(request, settings.limits);
    if (!(bytes instanceof Uint8Array)) {
      log.warn("internal.rejected", { http_status: bytes.status, reject_reason: bytes.reason });
      return Response.json({ error: bytes.reason }, { status: bytes.status });
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return callWorker(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? bytes : undefined,
      })
    );
  };

  const handler =
    (scope: "public" | "internal") =>
    async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      if (!isCanonicalPath(pathname)) {
        await request.body?.cancel().catch(() => undefined);
        return notFound();
      }
      if (request.method === "GET" && pathname === "/health") return health();
      const route = gate.match(request);
      if (route) return gate.handle(route, request, callWorker);
      if (scope === "internal" && isInternalRoute(pathname)) return callWorkerBounded(request);
      await request.body?.cancel().catch(() => undefined);
      return notFound();
    };

  const serve = (scope: "public" | "internal"): Server =>
    createServer(
      getRequestListener((request) =>
        handler(scope)(request).catch((error: unknown) => {
          log.error("http.unhandled", { scope, error: errorOf(error) });
          return Response.json({ error: "Internal error" }, { status: 500 });
        })
      )
    );

  // The Slack completion consumer: one message at a time, as the Queue's batch_size = 1.
  // ponytail: no concurrency; the Queue allows 5 consumers. Add a bound if completions back up.
  let draining = false;
  let queueTimer: NodeJS.Timeout | undefined;
  let consuming: Promise<void> | undefined;
  const consumeDue = async (): Promise<void> => {
    if (!bot.queue || !queue) return;
    for (let message = queue.claimNext(QUEUE_LEASE_MS); message;) {
      const settled: { outcome: "ack" | { delayMs: number } } = {
        outcome: { delayMs: bot.queue.retryDelayMs },
      };
      const current = message;
      const retryDelayMs = bot.queue.retryDelayMs;
      const batch: MessageBatch<unknown> = {
        queue: bot.queue.binding,
        messages: [
          {
            id: String(current.id),
            timestamp: new Date(),
            body: current.body,
            attempts: current.attempts,
            ack: () => (settled.outcome = "ack"),
            retry: (retry) =>
              (settled.outcome = {
                delayMs:
                  retry?.delaySeconds === undefined ? retryDelayMs : retry.delaySeconds * 1000,
              }),
          },
        ],
        ackAll: () => (settled.outcome = "ack"),
        retryAll: () => (settled.outcome = { delayMs: retryDelayMs }),
      };
      let failure: string | undefined;
      try {
        await bot.queue.consume(batch, env as never, background.context());
      } catch (error) {
        failure = errorOf(error).message;
        settled.outcome = { delayMs: retryDelayMs };
        log.error("queue.consume_failed", { message_id: current.id, error: errorOf(error) });
      }
      const { outcome } = settled;
      if (outcome === "ack") queue.ack(current.id);
      else if (current.attempts >= bot.queue.maxAttempts) {
        queue.deadLetter(current.id, failure ?? "retry requested on the last attempt");
        log.error("queue.dead_lettered", { message_id: current.id, attempts: current.attempts });
      } else queue.retry(current.id, outcome.delayMs);
      message = draining ? null : queue.claimNext(QUEUE_LEASE_MS);
    }
  };
  const wakeQueue = (): void => {
    if (!queue || draining || consuming) return;
    consuming = consumeDue()
      .catch((error: unknown) => log.error("queue.poll_failed", { error: errorOf(error) }))
      .finally(() => (consuming = undefined));
  };
  if (queue) queueTimer = setInterval(wakeQueue, QUEUE_POLL_MS);
  const sweepTimer = setInterval(() => {
    try {
      store.sweepExpired();
    } catch (error) {
      log.error("store.sweep_failed", { error: errorOf(error) });
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const publicServer = serve("public");
  const internalServer = serve("internal");
  const publicAddress = await listen(publicServer, settings.host, settings.port);
  const internalAddress = await listen(internalServer, settings.host, settings.internalPort);
  log.info("host.started", {
    public_port: publicAddress.port,
    internal_port: internalAddress.port,
    webhook_routes: bot.ingress.map((route) => `${route.method} ${route.path}`),
  });

  let shutdown: Promise<{ clean: boolean }> | undefined;
  return {
    publicAddress,
    internalAddress,
    shutdown() {
      shutdown ??= (async () => {
        draining = true;
        clearInterval(queueTimer);
        clearInterval(sweepTimer);
        const deadline = Date.now() + settings.shutdownTimeoutMs;
        await Promise.all([close(publicServer), close(internalServer)]);
        if (consuming) await consuming;
        const clean = await background.drain(deadline);
        if (!clean) log.warn("host.shutdown_abandoned", { background_tasks: background.size });
        store.close();
        log.info("host.stopped", { clean });
        return { clean };
      })();
      return shutdown;
    },
  };
}
