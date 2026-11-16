/**
 * Process entry: `BOT` picks the bot, the rest of the environment is its
 * Worker's configuration under the same names, plus this host's settings.
 */

import { createLogger, parseLogLevel } from "@open-inspect/shared/logger";
import { BOTS, isBotName } from "./bots";
import { readBotHostSettings } from "./config";
import { startBotHost } from "./host";
import { openBotDatabase, SqliteKv } from "./store";

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

/**
 * `node main.js kv get|put|delete|list [key] [value]`: the operator's
 * stand-in for `wrangler kv key`, for the operator-managed keys a bot reads
 * (the Linear bot's `config:*`, for one). Run it in the bot's container.
 */
async function kv(args: string[]): Promise<void> {
  const [command, key = "", value] = args;
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is required");
  const store = new SqliteKv(openBotDatabase(dataDir));
  if (command === "get") console.log((await store.get(key)) ?? "");
  else if (command === "put" && value !== undefined) await store.put(key, value);
  else if (command === "delete") await store.delete(key);
  else if (command === "list") {
    for (const entry of (await store.list({ prefix: key })).keys) console.log(entry.name);
  } else throw new Error("usage: kv get <key> | put <key> <value> | delete <key> | list [prefix]");
}

(process.argv[2] === "kv" ? kv(process.argv.slice(3)) : main()).catch((error: unknown) => {
  log.error("host.boot_failed", { error: error instanceof Error ? error : String(error) });
  process.exit(1);
});
