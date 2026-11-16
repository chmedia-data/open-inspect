/**
 * The bot's durable state in one SQLite file under `DATA_DIR`: the KV
 * namespace the bot reads and writes, the ingress replay ledger, and the
 * bot's own queue. `node:sqlite` is synchronous, so each method below is a
 * single statement or transaction that no other request can interleave
 * with; that is what makes the replay claim atomic.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Cloudflare KV's own floor; a shorter TTL fails here exactly as it fails there. */
const KV_MIN_TTL_SECONDS = 60;

export function openBotDatabase(dataDir: string, now: () => number = Date.now): BotDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "bot.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  return new BotDatabase(db, now);
}

export class BotDatabase {
  constructor(
    readonly db: DatabaseSync,
    readonly now: () => number
  ) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS replay (
        identity TEXT PRIMARY KEY,
        binding TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        visible_at INTEGER NOT NULL,
        dead_at INTEGER,
        last_error TEXT
      );
    `);
  }

  /** Drop expired KV entries and replay records; reads already ignore them. */
  sweepExpired(): void {
    const now = this.now();
    this.db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM replay WHERE expires_at <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}

/** The `KVNamespace` methods the bots call, and only those. */
export class SqliteKv {
  constructor(private readonly store: BotDatabase) {}

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const row = this.store.db
      .prepare("SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(key, this.store.now()) as { value: string } | undefined;
    if (row === undefined) return null;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (typeof value !== "string") throw new TypeError("KV values must be strings");
    let expiresAt: number | null = null;
    if (options?.expirationTtl !== undefined) {
      if (!(options.expirationTtl >= KV_MIN_TTL_SECONDS)) {
        throw new RangeError(`expirationTtl must be at least ${KV_MIN_TTL_SECONDS} seconds`);
      }
      expiresAt = this.store.now() + options.expirationTtl * 1000;
    }
    this.store.db
      .prepare(
        "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
      )
      .run(key, value, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.store.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  /**
   * Live keys under `prefix`, in key order. ponytail: one page with no
   * cursor, which is what the only caller (Slack branch preferences) reads;
   * add `limit`/`cursor` when a caller pages.
   */
  async list(options?: { prefix?: string }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: true;
    cacheStatus: null;
  }> {
    const prefix = options?.prefix ?? "";
    const rows = this.store.db
      .prepare(
        "SELECT key, expires_at FROM kv WHERE substr(key, 1, ?) = ? " +
          "AND (expires_at IS NULL OR expires_at > ?) ORDER BY key"
      )
      .all(prefix.length, prefix, this.store.now()) as { key: string; expires_at: number | null }[];
    return {
      keys: rows.map((row) =>
        row.expires_at === null
          ? { name: row.key }
          : { name: row.key, expiration: Math.floor(row.expires_at / 1000) }
      ),
      list_complete: true,
      cacheStatus: null,
    };
  }
}

/** What a replay claim found: the identity is new, or the binding it was first seen with. */
export type ReplayClaim = { fresh: true } | { fresh: false; binding: string };

/**
 * Authenticated request identities the ingress has accepted. A claim is one
 * INSERT, so of two concurrent requests with the same identity exactly one
 * is fresh, and the record outlives restarts.
 */
export class ReplayLedger {
  constructor(private readonly store: BotDatabase) {}

  claim(identity: string, binding: string, ttlMs: number): ReplayClaim {
    const now = this.store.now();
    const { db } = this.store;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM replay WHERE identity = ? AND expires_at <= ?").run(identity, now);
      const inserted = db
        .prepare(
          "INSERT INTO replay (identity, binding, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
        )
        .run(identity, binding, now + ttlMs);
      const claim: ReplayClaim =
        inserted.changes === 1
          ? { fresh: true }
          : {
              fresh: false,
              binding: (
                db.prepare("SELECT binding FROM replay WHERE identity = ?").get(identity) as {
                  binding: string;
                }
              ).binding,
            };
      db.exec("COMMIT");
      return claim;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A message as the queue hands it to the consumer. */
export interface QueuedMessage {
  id: number;
  body: unknown;
  /** Deliveries so far, this one included, as Cloudflare counts them. */
  attempts: number;
}

/**
 * The bot's own durable queue: the stand-in for a Cloudflare Queue the bot
 * both produces to and consumes. A message out of attempts is kept as dead,
 * the counterpart of the dead-letter queue.
 */
export class SqliteQueue {
  constructor(private readonly store: BotDatabase) {}

  send(body: unknown, delayMs = 0): void {
    this.store.db
      .prepare("INSERT INTO queue (body, visible_at) VALUES (?, ?)")
      .run(JSON.stringify(body), this.store.now() + delayMs);
  }

  /** Take the next due message, hiding it for `leaseMs` so a crash redelivers it. */
  claimNext(leaseMs: number): QueuedMessage | null {
    const now = this.store.now();
    const row = this.store.db
      .prepare(
        "UPDATE queue SET attempts = attempts + 1, visible_at = ? WHERE id = (" +
          "SELECT id FROM queue WHERE dead_at IS NULL AND visible_at <= ? ORDER BY visible_at, id LIMIT 1" +
          ") RETURNING id, body, attempts"
      )
      .get(now + leaseMs, now) as { id: number; body: string; attempts: number } | undefined;
    return row ? { id: row.id, body: JSON.parse(row.body), attempts: row.attempts } : null;
  }

  ack(id: number): void {
    this.store.db.prepare("DELETE FROM queue WHERE id = ?").run(id);
  }

  retry(id: number, delayMs: number): void {
    this.store.db
      .prepare("UPDATE queue SET visible_at = ? WHERE id = ?")
      .run(this.store.now() + delayMs, id);
  }

  deadLetter(id: number, error: string): void {
    this.store.db
      .prepare("UPDATE queue SET dead_at = ?, last_error = ? WHERE id = ?")
      .run(this.store.now(), error, id);
  }

  /** When the next live message is due, or null when nothing is waiting. */
  nextVisibleAt(): number | null {
    const row = this.store.db
      .prepare("SELECT MIN(visible_at) AS at FROM queue WHERE dead_at IS NULL")
      .get() as { at: number | null };
    return row.at;
  }

  deadCount(): number {
    return (
      this.store.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE dead_at IS NOT NULL").get() as {
        n: number;
      }
    ).n;
  }
}
