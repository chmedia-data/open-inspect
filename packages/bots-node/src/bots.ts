/**
 * The bots this host serves, each described once: the Worker it runs, the
 * bindings that Worker expects, and its public webhook routes. One process
 * serves one bot, so each keeps its Worker's environment contract as is
 * (every bot reads `SERVICE_AUTH_SECRET`, `DEFAULT_MODEL`, `LOG_LEVEL` under
 * the same names) and holds only its own credentials.
 */

import type { ServiceName } from "@open-inspect/shared/service-auth";
import githubBot from "../../github-bot/src/index";
import linearBot from "../../linear-bot/src/index";
import slackBot from "../../slack-bot/src/index";
import { GITHUB_INGRESS, LINEAR_INGRESS, SLACK_INGRESS, type WebhookIngress } from "./ingress";

/** What a Worker module exports, as this host calls it. */
interface WorkerFetch {
  fetch(request: Request, env: never, ctx: ExecutionContext): Response | Promise<Response>;
}

interface BotQueue {
  /** The env binding the bot produces to. */
  binding: string;
  consume(batch: MessageBatch<unknown>, env: never, ctx: ExecutionContext): Promise<void>;
  /** Deliveries before a message is dead: the Queue consumer's `max_retries` plus one. */
  maxAttempts: number;
  /** The Queue consumer's `retry_delay`. */
  retryDelayMs: number;
}

export interface BotDefinition {
  name: BotName;
  service: ServiceName;
  worker: WorkerFetch;
  kvBinding: string;
  ingress: readonly WebhookIngress[];
  /** Variables the host or the gate cannot run without. */
  requiredEnv: readonly string[];
  /**
   * What the internal listener serves besides the webhook routes: the paths the control
   * plane calls on this bot. An entry ending in `/` is a prefix; any other is exact.
   */
  internalRoutes: readonly string[];
  queue?: BotQueue;
  /** A Queue the bot produces to that the control plane consumes, sent over HTTP instead. */
  controlPlaneQueue?: { binding: string; path: string };
}

export type BotName = "github" | "slack" | "linear";

const COMMON_ENV = ["CONTROL_PLANE_URL", "SERVICE_AUTH_SECRET", "DEPLOYMENT_NAME"] as const;

export const BOTS: Record<BotName, BotDefinition> = {
  github: {
    name: "github",
    service: "github-bot",
    worker: githubBot as unknown as WorkerFetch,
    kvBinding: "GITHUB_KV",
    ingress: [GITHUB_INGRESS],
    requiredEnv: [
      ...COMMON_ENV,
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_BOT_USERNAME",
      "DEFAULT_MODEL",
    ],
    // The control plane calls nothing on the GitHub bot.
    internalRoutes: [],
    // The control plane consumes Autofix jobs; on this host they reach it as a signed POST.
    controlPlaneQueue: { binding: "AUTOFIX_QUEUE", path: "/internal/github-autofix" },
  },
  slack: {
    name: "slack",
    service: "slack-bot",
    worker: slackBot as unknown as WorkerFetch,
    kvBinding: "SLACK_KV",
    ingress: SLACK_INGRESS,
    requiredEnv: [
      ...COMMON_ENV,
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_ALLOWED_TEAM_IDS",
      "WEB_APP_URL",
      "DEFAULT_MODEL",
    ],
    internalRoutes: ["/callbacks/", "/internal/thread-context", "/internal/channel-info"],
    queue: {
      binding: "SLACK_COMPLETION_QUEUE",
      consume: slackBot.queue as unknown as BotQueue["consume"],
      // terraform/environments/production/workers-slack.tf: max_retries = 1, retry_delay = 15.
      maxAttempts: 2,
      retryDelayMs: 15_000,
    },
  },
  linear: {
    name: "linear",
    service: "linear-bot",
    worker: linearBot as unknown as WorkerFetch,
    kvBinding: "LINEAR_KV",
    ingress: [LINEAR_INGRESS],
    requiredEnv: [
      ...COMMON_ENV,
      "LINEAR_WEBHOOK_SECRET",
      "LINEAR_CLIENT_ID",
      "LINEAR_CLIENT_SECRET",
      "LINEAR_ALLOWED_ORGANIZATION_IDS",
      "WEB_APP_URL",
      "DEFAULT_MODEL",
    ],
    // Not `/oauth/`: the Worker's install flow has no OAuth state or owner check, so this
    // host does not serve it at all; see the package README for installing the Linear app.
    internalRoutes: ["/callbacks/"],
  },
};

export function isBotName(value: string | undefined): value is BotName {
  return value !== undefined && Object.hasOwn(BOTS, value);
}
