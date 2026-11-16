import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openBotDatabase, ReplayLedger, SqliteKv, SqliteQueue } from "./store";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bots-node-store-"));
  const clock = { now: 1_000_000 };
  const db = openBotDatabase(dir, () => clock.now);
  return { dir, clock, db, kv: new SqliteKv(db) };
}

describe("SqliteKv", () => {
  it("round-trips text and json, and deletes", async () => {
    const { kv } = setup();
    await kv.put("a", JSON.stringify({ x: 1 }));
    expect(await kv.get("a")).toBe('{"x":1}');
    expect(await kv.get("a", "json")).toEqual({ x: 1 });
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
    expect(await kv.get("missing", "json")).toBeNull();
  });

  it("expires entries after expirationTtl and overwrites the TTL on put", async () => {
    const { kv, clock } = setup();
    await kv.put("k", "v", { expirationTtl: 60 });
    clock.now += 59_999;
    expect(await kv.get("k")).toBe("v");
    clock.now += 1;
    expect(await kv.get("k")).toBeNull();

    await kv.put("k", "v", { expirationTtl: 60 });
    await kv.put("k", "forever");
    clock.now += 10 * 60_000;
    expect(await kv.get("k")).toBe("forever");
  });

  it("rejects a TTL under KV's 60-second floor, as Cloudflare does", async () => {
    const { kv } = setup();
    await expect(kv.put("k", "v", { expirationTtl: 59 })).rejects.toThrow(RangeError);
  });

  it("lists live keys under a prefix only", async () => {
    const { kv, clock } = setup();
    await kv.put("pref:b", "1");
    await kv.put("pref:a", "1", { expirationTtl: 60 });
    await kv.put("pref:gone", "1", { expirationTtl: 60 });
    await kv.put("prefix-other", "1");
    await kv.put("other", "1");
    clock.now += 30_000;
    await kv.put("pref:gone", "1", { expirationTtl: 60 });
    clock.now += 31_000;

    const listed = await kv.list({ prefix: "pref:" });
    expect(listed.keys.map((key) => key.name)).toEqual(["pref:b", "pref:gone"]);
    expect(listed.list_complete).toBe(true);
  });

  it("does not treat LIKE wildcards in a prefix as wildcards", async () => {
    const { kv } = setup();
    await kv.put("a_b", "1");
    await kv.put("axb", "1");
    expect((await kv.list({ prefix: "a_" })).keys.map((key) => key.name)).toEqual(["a_b"]);
  });

  it("survives reopening the data directory, in a private file", async () => {
    const { dir, db, kv } = setup();
    await kv.put("durable", "yes");
    db.close();
    const reopened = new SqliteKv(openBotDatabase(dir));
    expect(await reopened.get("durable")).toBe("yes");
    expect(statSync(join(dir, "bot.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("sweeps expired rows", async () => {
    const { db, kv, clock } = setup();
    await kv.put("k", "v", { expirationTtl: 60 });
    clock.now += 61_000;
    db.sweepExpired();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM kv").get()).toEqual({ n: 0 });
  });
});

describe("ReplayLedger", () => {
  it("is fresh once, then reports the binding it was first claimed with", () => {
    const { db } = setup();
    const ledger = new ReplayLedger(db);
    expect(ledger.claim("id", "delivery-1", 60_000)).toEqual({ fresh: true });
    expect(ledger.claim("id", "delivery-2", 60_000)).toEqual({
      fresh: false,
      binding: "delivery-1",
    });
  });

  it("forgets an identity after its TTL", () => {
    const { db, clock } = setup();
    const ledger = new ReplayLedger(db);
    ledger.claim("id", "", 60_000);
    clock.now += 60_000;
    expect(ledger.claim("id", "", 60_000)).toEqual({ fresh: true });
  });

  it("remembers claims across a restart", () => {
    const { dir, db, clock } = setup();
    new ReplayLedger(db).claim("id", "b", 60_000);
    db.close();
    const reopened = openBotDatabase(dir, () => clock.now);
    expect(new ReplayLedger(reopened).claim("id", "b", 60_000).fresh).toBe(false);
  });
});

describe("SqliteQueue", () => {
  it("delivers in order, hides a claimed message for its lease, and redelivers it after", () => {
    const { db, clock } = setup();
    const queue = new SqliteQueue(db);
    queue.send({ n: 1 });
    queue.send({ n: 2 });

    const first = queue.claimNext(1_000);
    expect(first).toMatchObject({ body: { n: 1 }, attempts: 1 });
    expect(queue.claimNext(1_000)).toMatchObject({ body: { n: 2 } });
    expect(queue.claimNext(1_000)).toBeNull();

    clock.now += 1_000;
    expect(queue.claimNext(1_000)).toMatchObject({ body: { n: 1 }, attempts: 2 });
  });

  it("acks, retries after a delay, and dead-letters", () => {
    const { db, clock } = setup();
    const queue = new SqliteQueue(db);
    queue.send("a");
    queue.send("b", 5_000);
    expect(queue.nextVisibleAt()).toBe(clock.now);

    const a = queue.claimNext(60_000)!;
    queue.retry(a.id, 2_000);
    expect(queue.claimNext(60_000)).toBeNull();
    clock.now += 2_000;
    const again = queue.claimNext(60_000)!;
    expect(again.attempts).toBe(2);
    queue.deadLetter(again.id, "boom");
    expect(queue.deadCount()).toBe(1);

    clock.now += 3_000;
    const b = queue.claimNext(60_000)!;
    queue.ack(b.id);
    expect(queue.nextVisibleAt()).toBeNull();
  });
});
