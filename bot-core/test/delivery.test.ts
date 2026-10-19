import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { OutboxStore } from "../src/state/outbox.js";
import { DeliveryWorker } from "../src/state/deliveries.js";
import { RemindersStore, TellStore } from "../src/state/repos.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const reminders = new RemindersStore(db);
  const store = new OutboxStore(db);
  reminders.add("chat", "Alice", "hello", 0);
  return { db, reminders, store };
}

describe("durable delivery", () => {
  it("preserves existing reminders when migrating a version-zero database", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-migration-"));
    const path = join(directory, "bot.db");
    const old = new Database(path);
    old.exec("CREATE TABLE reminders (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, target_name TEXT, text TEXT NOT NULL, due_ts INTEGER NOT NULL, created_ts INTEGER NOT NULL); INSERT INTO reminders VALUES (1, 'chat', 'Alice', 'keep me', 0, 0)");
    old.close();
    let migrated: ReturnType<typeof openDatabase> | undefined;
    try {
      migrated = openDatabase(path);
      expect(migrated.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(new RemindersStore(migrated).due(100)[0].text).toBe("keep me");
    } finally {
      migrated?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not consume retry attempts during a known disconnect", async () => {
    const { db, store } = setup();
    let ready = false;
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = new DeliveryWorker(store, send, pino({ level: "silent" }), () => ready);
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect(db.prepare("SELECT attempts FROM outbox").get()).toEqual({ attempts: 0 });
    ready = true;
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("preserves existing outbox claims when upgrading a version-one database for pets", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-pet-migration-"));
    const path = join(directory, "bot.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, available_at INTEGER NOT NULL,
      lease_until INTEGER, claim_token TEXT, last_error TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO outbox VALUES (1,'chat','keep me','sending',1,0,300000,'old-claim',NULL,0);
    PRAGMA user_version = 1;`);
    old.close();
    let migrated: ReturnType<typeof openDatabase> | undefined;
    try {
      migrated = openDatabase(path);
      const store = new OutboxStore(migrated);
      expect(store.claim(299999)).toBeUndefined();
      expect(store.claim(300001)).toMatchObject({
        id: 1, chat_id: "chat", body: "keep me", attempts: 2, pet_event_id: null,
      });
      expect(migrated.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM pets").get()).toEqual({ count: 0 });
    } finally {
      migrated?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back source deletion if the outbox insertion fails", () => {
    const { db, reminders, store } = setup();
    db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => store.enqueueReminders(100)).toThrow("write failed");
    expect(reminders.due(100)).toHaveLength(1);
    const tells = new TellStore(db);
    tells.add("chat", "alice", "Alice", "Bob", "keep me");
    expect(() => tells.enqueueFor("alice", "chat", "Alice")).toThrow("write failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tells").get()).toEqual({ count: 1 });
  });

  it("atomically moves due reminders and does not enqueue twice", () => {
    const { store, reminders } = setup();
    store.enqueueReminders(100);
    store.enqueueReminders(100);
    expect(reminders.due(100)).toHaveLength(0);
    expect(store.claim(100)?.body).toContain("hello");
    expect(store.claim(100)).toBeUndefined();
  });

  it("recovers expired claims and rejects stale acknowledgments", () => {
    const { db, store } = setup();
    store.enqueueReminders(100);
    const first = store.claim(100)!;
    const recovered = store.claim(300_101)!;
    expect(recovered.id).toBe(first.id);
    store.sent(first);
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sending" });
    store.sent(recovered);
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sent" });
  });

  it("retains failed sends and retries after backoff", async () => {
    vi.useFakeTimers();
    const { db, store } = setup();
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const worker = new DeliveryWorker(store, send, pino({ level: "silent" }));
    await worker.flush();
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "pending", attempts: 1 });
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5001);
    await worker.flush();
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "sent", attempts: 2 });
    await worker.stop();
  });

  it("keeps exhausted jobs for inspection", () => {
    const { db, store } = setup();
    store.enqueueReminders(0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = attempt * 1_000_000;
      store.failed(store.claim(now)!, new Error("offline"), now);
    }
    expect(store.claim(10_000_000)).toBeUndefined();
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "failed", attempts: 5 });
  });

  it("persists tells in the outbox before removing the original", () => {
    const { db, store } = setup();
    const tells = new TellStore(db);
    tells.add("chat", "alice", "Alice", "Bob", "call me");
    tells.enqueueFor("alice", "chat", "Alice");
    tells.enqueueFor("alice", "chat", "Alice");
    const delivery = store.claim(Date.now())!;
    expect(delivery.body).toContain("call me");
    expect(store.claim(Date.now())).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tells").get()).toEqual({ count: 0 });
  });
});