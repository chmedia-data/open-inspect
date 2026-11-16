/**
 * Process entry: `BOT` picks the bot, the rest of the environment is its
 * Worker's configuration under the same names, plus this host's settings.
 */

import { createLogger, parseLogLevel } from "@open-inspect/shared/logger";
import { BOTS, isBotName } from "./bots";
import { readBotHostSettings } from "./config";
import { startBotHost } from "./host";

/** Past the drain budget, how much longer the process gets before it is forced down. */
const FORCE_EXIT_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const name = process.env.BOT;
  if (!isBotName(name)) {
    throw new Error(`BOT must be one of ${Object.keys(BOTS).join(", ")}; got ${name ?? "nothing"}`);
  }
  const settings = readBotHostSettings(process.env);
  const host = await startBotHost({ bot: BOTS[name], env: process.env, settings });

  const stop = (signal: NodeJS.Signals): void => {
    log.info("host.signal", { signal });
    setTimeout(() => {
      log.error("host.shutdown_forced", {});
      process.exit(1);
    }, settings.shutdownTimeoutMs + FORCE_EXIT_GRACE_MS).unref();
    host.shutdown().then(
      ({ clean }) => (process.exitCode = clean ? 0 : 1),
      (error: unknown) => {
        log.error("host.shutdown_failed", {
          error: error instanceof Error ? error : String(error),
        });
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const log = createLogger("bots-node", {}, parseLogLevel(process.env.LOG_LEVEL), "bots-node");

main().catch((error: unknown) => {
  log.error("host.boot_failed", { error: error instanceof Error ? error : String(error) });
  process.exit(1);
});
