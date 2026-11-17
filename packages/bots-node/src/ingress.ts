/**
 * The webhook ingress gate: what stands between the public internet and a
 * bot's webhook handler on this host. In order, it
 *
 * 1. rejects a request whose signature headers are malformed (or, where the
 *    timestamp is signed, stale) before reading a byte of its body;
 * 2. reads the body as a stream under a byte cap and a deadline, cancelling
 *    it at either, so an oversized or trickled body costs at most the cap;
 * 3. verifies the provider's HMAC over exactly the bytes it read;
 * 4. checks freshness and the tenant (installation, workspace, organization)
 *    the deployment is pinned to;
 * 5. claims the request's authenticated identity in the durable replay
 *    ledger, so a captured request cannot be replayed, even with its
 *    unsigned delivery header changed, and even across restarts.
 *
 * Only then does the bot see the request, rebuilt from the bytes that were
 * verified. The bot verifies the signature again itself; that is the Worker
 * code running unchanged, not a second line of defense this gate relies on.
 */

import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared/auth";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { Logger } from "@open-inspect/shared/logger";
import type { ReplayLedger } from "./store";

/** Why the gate turned a request away, as logged and as answered. */
export type Rejection = { status: 401 | 403 | 408 | 409 | 413 | 503; reason: string };

/** What the gate needs from the bot's configuration; read once at boot. */
export type IngressEnv = Record<string, string | undefined>;

/** A request whose body has been read and authenticated. */
interface VerifiedWebhook {
  /** The body exactly as received; signatures are checked over these bytes. */
  bytes: Uint8Array<ArrayBuffer>;
  /** The body decoded as UTF-8, for reading the payload once it is authenticated. */
  text: string;
  headers: Headers;
  env: IngressEnv;
  nowMs: number;
}

/** One public webhook route and how its provider authenticates it. */
export interface WebhookIngress {
  method: "POST";
  path: string;
  /** Header syntax (and signed-timestamp freshness), checked before the body is read. */
  precheck(headers: Headers, nowMs: number): string | null;
  /** The provider's signature over exactly `bytes`. */
  verify(request: VerifiedWebhook): Promise<boolean>;
  /** Freshness and tenant checks on the authenticated payload. */
  admit(request: VerifiedWebhook): string | null;
  /**
   * The request's authenticated identity, and the unsigned value it must
   * stay bound to. A repeat with the same binding is let through within
   * `repeatWindowMs` of the first sighting (a provider's own redelivery);
   * any other repeat is a replay. 0 refuses every repeat.
   */
  replay(request: VerifiedWebhook): {
    identity: string;
    binding: string;
    /** How long the identity is remembered; at least `repeatWindowMs`. */
    ttlMs: number;
    repeatWindowMs: number;
  };
}

export interface IngressLimits {
  maxBodyBytes: number;
  bodyTimeoutMs: number;
  maxConcurrentReads: number;
}

export const DEFAULT_INGRESS_LIMITS: IngressLimits = {
  maxBodyBytes: 1024 * 1024,
  bodyTimeoutMs: 10_000,
  maxConcurrentReads: 32,
};

const HEX_64 = /^[0-9a-f]{64}$/;
/** Slack's own window, kept from `verifySlackSignature`. */
const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;
/** Linear asks receivers to reject a `webhookTimestamp` further off than this. */
const LINEAR_MAX_SKEW_MS = 5 * 60 * 1000;
/** Longer than any window above, so a replay is caught for as long as it would verify. */
const SIGNED_TIMESTAMP_REPLAY_TTL_MS = 2 * SLACK_MAX_SKEW_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a GitHub delivery is remembered. GitHub signs no timestamp, so a captured
 * delivery verifies forever; past this it would be fresh again.
 */
export const GITHUB_REPLAY_TTL_MS = 90 * DAY_MS;
/**
 * How long after its first sighting a GitHub delivery may arrive again under the same
 * delivery id: GitHub's own window for redelivering a delivery. Later, it is a replay.
 */
export const GITHUB_REDELIVERY_WINDOW_MS = 3 * DAY_MS;

/** Comma-separated identities; empty entries are ignored. */
function parseIdList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export const GITHUB_INGRESS: WebhookIngress = {
  method: "POST",
  path: "/webhooks/github",
  precheck(headers) {
    const signature = headers.get("x-hub-signature-256") ?? "";
    if (!signature.startsWith("sha256=") || !HEX_64.test(signature.slice(7))) {
      return "malformed_signature";
    }
    if (!/^[a-z_]{1,64}$/.test(headers.get("x-github-event") ?? "")) return "malformed_event";
    if (!/^[0-9a-f-]{1,64}$/i.test(headers.get("x-github-delivery") ?? "")) {
      return "malformed_delivery";
    }
    return null;
  },
  async verify({ bytes, headers, env }) {
    const secret = env.GITHUB_WEBHOOK_SECRET ?? "";
    const expected = (headers.get("x-hub-signature-256") ?? "").slice(7);
    return timingSafeEqual(expected, await computeHmacHex(bytes, secret));
  },
  admit({ text, headers, env }) {
    const payload = parseJsonObject(text);
    if (payload === null) return "malformed_payload";
    // A ping is GitHub testing the hook; it names no installation.
    if (headers.get("x-github-event") === "ping") return null;
    const installation = field(payload, "installation", "id");
    if (String(installation) !== env.GITHUB_APP_INSTALLATION_ID) return "wrong_installation";
    return null;
  },
  replay({ headers }) {
    return {
      // The signature is an HMAC of the body: the authenticated identity of its content.
      identity: `github:${(headers.get("x-hub-signature-256") ?? "").slice(7)}`,
      // GitHub redelivers with the same delivery id; the same body under another id is a replay.
      binding: headers.get("x-github-delivery") ?? "",
      ttlMs: GITHUB_REPLAY_TTL_MS,
      repeatWindowMs: GITHUB_REDELIVERY_WINDOW_MS,
    };
  },
};

function slackIngress(path: "/events" | "/interactions"): WebhookIngress {
  return {
    method: "POST",
    path,
    precheck(headers, nowMs) {
      const signature = headers.get("x-slack-signature") ?? "";
      if (!signature.startsWith("v0=") || !HEX_64.test(signature.slice(3))) {
        return "malformed_signature";
      }
      const timestamp = headers.get("x-slack-request-timestamp") ?? "";
      if (!/^\d{1,12}$/.test(timestamp)) return "malformed_timestamp";
      if (Math.abs(nowMs - Number(timestamp) * 1000) > SLACK_MAX_SKEW_MS) return "stale_timestamp";
      return null;
    },
    async verify({ bytes, headers, env }) {
      // Slack signs `v0:<timestamp>:<body>`; the timestamp's freshness was checked in precheck.
      const prefix = new TextEncoder().encode(`v0:${headers.get("x-slack-request-timestamp")}:`);
      const signed = new Uint8Array(prefix.length + bytes.length);
      signed.set(prefix);
      signed.set(bytes, prefix.length);
      return timingSafeEqual(
        (headers.get("x-slack-signature") ?? "").slice(3),
        await computeHmacHex(signed, env.SLACK_SIGNING_SECRET ?? "")
      );
    },
    admit({ text, env }) {
      const payload =
        path === "/events"
          ? parseJsonObject(text)
          : parseJsonObject(new URLSearchParams(text).get("payload") ?? "");
      if (payload === null) return "malformed_payload";
      // Slack's URL check names no team; it is answered only once signed.
      if (payload.type === "url_verification") return null;
      const team = path === "/events" ? payload.team_id : field(payload, "team", "id");
      if (typeof team !== "string" || !parseIdList(env.SLACK_ALLOWED_TEAM_IDS).has(team)) {
        return "wrong_workspace";
      }
      return null;
    },
    replay({ headers }) {
      return {
        identity: `slack:${headers.get("x-slack-signature")}`,
        binding: "",
        ttlMs: SIGNED_TIMESTAMP_REPLAY_TTL_MS,
        repeatWindowMs: 0,
      };
    },
  };
}

export const SLACK_INGRESS = [slackIngress("/events"), slackIngress("/interactions")];

export const LINEAR_INGRESS: WebhookIngress = {
  method: "POST",
  path: "/webhook",
  precheck(headers) {
    if (!HEX_64.test(headers.get("linear-signature") ?? "")) return "malformed_signature";
    if (!/^[0-9a-f-]{1,64}$/i.test(headers.get("linear-delivery") ?? "")) {
      return "malformed_delivery";
    }
    return null;
  },
  async verify({ bytes, headers, env }) {
    const secret = env.LINEAR_WEBHOOK_SECRET ?? "";
    return timingSafeEqual(
      headers.get("linear-signature") ?? "",
      await computeHmacHex(bytes, secret)
    );
  },
  admit({ text, env, nowMs }) {
    const payload = parseJsonObject(text);
    if (payload === null) return "malformed_payload";
    const sentAt = payload.webhookTimestamp;
    if (typeof sentAt !== "number" || Math.abs(nowMs - sentAt) > LINEAR_MAX_SKEW_MS) {
      return "stale_timestamp";
    }
    const organization = payload.organizationId;
    if (
      typeof organization !== "string" ||
      !parseIdList(env.LINEAR_ALLOWED_ORGANIZATION_IDS).has(organization)
    ) {
      return "wrong_organization";
    }
    return null;
  },
  replay({ headers }) {
    return {
      // The signed body carries webhookTimestamp, so its HMAC is unique per send.
      identity: `linear:${headers.get("linear-signature")}`,
      binding: "",
      ttlMs: SIGNED_TIMESTAMP_REPLAY_TTL_MS,
      repeatWindowMs: 0,
    };
  },
};

/** Read `body` under the cap and the deadline; the stream is cancelled at either. */
export async function readBounded(
  request: Request,
  limits: IngressLimits
): Promise<Uint8Array<ArrayBuffer> | Rejection> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limits.maxBodyBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { status: 413, reason: "body_too_large" };
  }
  const deadline = AbortSignal.timeout(limits.bodyTimeoutMs);
  try {
    const bytes = await readBodyCapped(request.body, limits.maxBodyBytes, { signal: deadline });
    return bytes ?? { status: 413, reason: "body_too_large" };
  } catch (error) {
    if (deadline.aborted) return { status: 408, reason: "body_timeout" };
    throw error;
  }
}

export interface IngressGate {
  /** The route this request is for, or undefined when it is not a webhook route. */
  match(request: Request): WebhookIngress | undefined;
  /**
   * Authenticate `request` for `route` and, if it passes, hand the request
   * rebuilt from the verified bytes to `forward` (the bot).
   */
  handle(
    route: WebhookIngress,
    request: Request,
    forward: (request: Request) => Promise<Response>
  ): Promise<Response>;
}

export function createIngressGate(options: {
  routes: readonly WebhookIngress[];
  env: IngressEnv;
  ledger: ReplayLedger;
  limits: IngressLimits;
  log: Logger;
  now?: () => number;
}): IngressGate {
  const now = options.now ?? Date.now;
  let reading = 0;
  /** Identities the bot is handling now; a concurrent repeat waits for the provider's retry. */
  const inFlight = new Set<string>();

  const refuse = (route: WebhookIngress, rejection: Rejection): Response => {
    // A 503 is a delivery the provider will not retry on its own: someone has to redeliver it.
    const level = rejection.status === 503 ? "error" : "warn";
    options.log[level]("ingress.rejected", {
      http_path: route.path,
      http_status: rejection.status,
      reject_reason: rejection.reason,
    });
    return Response.json({ error: rejection.reason }, { status: rejection.status });
  };

  return {
    match(request) {
      const { pathname } = new URL(request.url);
      return options.routes.find(
        (route) => route.path === pathname && route.method === request.method
      );
    },

    async handle(route, request, forward) {
      const malformed = route.precheck(request.headers, now());
      if (malformed !== null) {
        await request.body?.cancel().catch(() => undefined);
        return refuse(route, { status: 401, reason: malformed });
      }

      if (reading >= options.limits.maxConcurrentReads) {
        await request.body?.cancel().catch(() => undefined);
        return refuse(route, { status: 503, reason: "too_many_concurrent_reads" });
      }
      reading++;
      let bytes: Uint8Array<ArrayBuffer> | Rejection;
      try {
        bytes = await readBounded(request, options.limits);
      } finally {
        reading--;
      }
      if (!(bytes instanceof Uint8Array)) return refuse(route, bytes);

      const verified: VerifiedWebhook = {
        bytes,
        text: new TextDecoder().decode(bytes),
        headers: request.headers,
        env: options.env,
        nowMs: now(),
      };
      if (!(await route.verify(verified))) {
        return refuse(route, { status: 401, reason: "invalid_signature" });
      }
      const inadmissible = route.admit(verified);
      if (inadmissible !== null) {
        const status = inadmissible === "stale_timestamp" ? 401 : 403;
        return refuse(route, { status, reason: inadmissible });
      }

      const replay = route.replay(verified);
      const claim = options.ledger.claim(replay.identity, replay.binding, replay.ttlMs);
      const redelivery =
        !claim.fresh &&
        claim.binding === replay.binding &&
        verified.nowMs - claim.firstSeenAt < replay.repeatWindowMs;
      if (!claim.fresh && !redelivery) {
        return refuse(route, { status: 409, reason: "replayed_request" });
      }
      if (inFlight.has(replay.identity)) {
        return refuse(route, { status: 503, reason: "delivery_in_flight" });
      }

      inFlight.add(replay.identity);
      // A refused repeat can only be the provider's retry if the first attempt failed, so a
      // failed attempt gives its claim back; it had no effect a replay could repeat.
      const release = () => {
        if (replay.repeatWindowMs === 0) options.ledger.release(replay.identity);
      };
      try {
        const response = await forward(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: bytes,
          })
        );
        if (response.status >= 500) release();
        return response;
      } catch (error) {
        release();
        throw error;
      } finally {
        inFlight.delete(replay.identity);
      }
    },
  };
}
