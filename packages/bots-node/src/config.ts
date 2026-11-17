/**
 * This host's own settings from the environment; the bot's variables are
 * passed through to it untouched.
 */

import type { BotHostSettings } from "./host";
import { DEFAULT_INGRESS_LIMITS } from "./ingress";

type Source = Record<string, string | undefined>;

function integer(source: Source, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return Number(raw);
}

export function readBotHostSettings(source: Source): BotHostSettings {
  const dataDir = source.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is required: the directory that holds the bot's store");
  return {
    host: source.HOST || "0.0.0.0",
    port: integer(source, "PORT", 8080),
    internalPort: integer(source, "INTERNAL_PORT", 8081),
    dataDir,
    shutdownTimeoutMs: integer(source, "SHUTDOWN_TIMEOUT_MS", 30_000),
    limits: {
      maxBodyBytes: integer(source, "WEBHOOK_MAX_BODY_BYTES", DEFAULT_INGRESS_LIMITS.maxBodyBytes),
      bodyTimeoutMs: integer(
        source,
        "WEBHOOK_BODY_TIMEOUT_MS",
        DEFAULT_INGRESS_LIMITS.bodyTimeoutMs
      ),
      maxConcurrentReads: integer(
        source,
        "WEBHOOK_MAX_CONCURRENT_READS",
        DEFAULT_INGRESS_LIMITS.maxConcurrentReads
      ),
    },
  };
}
