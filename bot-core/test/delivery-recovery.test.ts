import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { removeScopedSchema } from "./legacy-schema.js";
import { OutboxStore } from "../src/state/outbox.js";
import { DeliveryWorker } from "../src/state/deliveries.js";
import { RemindersStore, TellStore } from "../src/state/repos.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  const store = new OutboxStore(db);
  db.prepare("INSERT INTO outbox (chat_id, body, available_at, created_at) VALUES (?,?,0,0)").run("private-chat", "private body");
  return { db, store };
}
function exhaust(store: OutboxStore, start = 0) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = start + attempt * 1_000_000;
    store.failed(store.claim(now)!, new Error("sensitive host and message text"), now);
  }
}

describe("failed delivery recovery", () => {
  it("retains sanitized attempt metadata and does not expose contents, identities, tokens or raw errors", () => {
    const { store } = setup();
    exhaust(store);
    expect(store.listFailed(1, 42)).toEqual({
      deliveries: [{ id: 1, attempts: 5, retryCount: 0, failedAt: 4_000_000, failureKind: "send-error" }],
      total: 1, page: 1, pageSize: 50, sampledAt: 42,
    });
    const history = store.history(1)!;
    expect(history.attempts).toHaveLength(5);
    expect(history.attempts[0]).toEqual({
      id: 5, retryCount: 0, startedAt: 4_000_000, finishedAt: 4_000_000, outcome: "failed", failureKind: "send-error",
    });
    const json = JSON.stringify([store.listFailed(1), history]);
    for (const secret of ["private", "sensitive", "claim_token", "last_error", "chat_id", "body"]) expect(json).not.toContain(secret);
  });

  it("allows exactly one additional send per confirmation, without restarting automatic retries", async () => {
    const { db, store } = setup();
    exhaust(store);
    expect(store.retryFailed(1, 0, 5_000_000)).toBe(true);
    expect(store.retryFailed(1, 0, 5_000_000)).toBe(false);
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const worker = new DeliveryWorker(store, send, pino({ level: "silent" }));
    try {
      await worker.flush();
      await worker.flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(store.listFailed(1).deliveries[0]).toMatchObject({ attempts: 5, retryCount: 1 });
      expect(store.history(1)!.attempts[0]).toMatchObject({ retryCount: 1, outcome: "failed" });
      expect(store.retryFailed(1, 0)).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });
    } finally { await worker.stop(); }
  });

  it("rejects retries for missing, pending, sending, sent and cancelled rows", () => {
    const { store } = setup();
    expect(store.retryFailed(999, 0)).toBe(false);
    expect(store.retryFailed(1, 0)).toBe(false);
    const first = store.claim(0)!;
    expect(store.retryFailed(1, 0)).toBe(false);
    store.sent(first);
    expect(store.retryFailed(1, 0)).toBe(false);
    const { db } = setup();
    db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = 1").run();
    expect(new OutboxStore(db).retryFailed(1, 0)).toBe(false);
  });

  it("does not accept stale acknowledgements or failures after retry and reclaim", () => {
    const { db, store } = setup();
    const stale = store.claim(0)!;
    store.failed(stale, "error", 0);
    for (let i = 1; i < 5; i++) store.failed(store.claim(i * 1_000_000)!, "error", i * 1_000_000);
    expect(store.retryFailed(1, 0, 5_000_000)).toBe(true);
    const current = store.claim(5_000_000)!;
    store.sent(stale);
    store.failed(stale, "stale error", 5_000_001);
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "sending", attempts: 5 });
    expect(store.history(1)!.attempts[0].outcome).toBe("sending");
    store.sent(current);
    expect(store.history(1)!.attempts[0].outcome).toBe("sent");
  });

  it("records timeout and expired-lease outcomes, including an exhausted manual attempt", () => {
    const { store } = setup();
    let claim = store.claim(0)!;
    store.failed(claim, new Error("Delivery timed out"), 1);
    expect(store.history(1)!.attempts[0].failureKind).toBe("timeout");
    for (let i = 1; i < 5; i++) {
      claim = store.claim(i * 1_000_000)!;
    }
    expect(store.claim(5_000_000)).toBeUndefined();
    expect(store.listFailed(1).deliveries[0].failureKind).toBe("lease-expired");
    expect(store.retryFailed(1, 0, 5_000_000)).toBe(true);
    store.claim(5_000_000);
    expect(store.claim(5_300_000)).toBeUndefined();
    expect(store.history(1)!.attempts[0]).toMatchObject({ retryCount: 1, outcome: "lease-expired" });
  });

  it("preserves transport readiness and defer/cancel pet safeguards on manual retries", async () => {
    const { db, store } = setup();
    exhaust(store);
    store.retryFailed(1, 0);
    const send = vi.fn();
    let ready = false;
    let decision: boolean | "defer" = "defer";
    const worker = new DeliveryWorker(store, send, pino({ level: "silent" }), () => ready,
      { canSend: () => decision, onSent: vi.fn() });
    try {
      await worker.flush();
      expect(store.history(1)!.total).toBe(5);
      ready = true;
      await worker.flush();
      expect(store.history(1)!.attempts[0].outcome).toBe("deferred");
      expect(db.prepare("SELECT attempts, status FROM outbox").get()).toEqual({ attempts: 4, status: "pending" });
      db.prepare("UPDATE outbox SET available_at=0").run();
      decision = false;
      await worker.flush();
      expect(send).not.toHaveBeenCalled();
      expect(store.history(1)!.attempts[0].outcome).toBe("cancelled");
    } finally { await worker.stop(); }
  });

  it("rolls back outbox changes when writing attempt history fails", () => {
    const { db, store } = setup();
    db.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON delivery_attempts BEGIN SELECT RAISE(ABORT, 'history failed'); END");
    expect(() => store.claim(0)).toThrow("history failed");
    expect(db.prepare("SELECT status, attempts, claim_token FROM outbox").get()).toEqual({ status: "pending", attempts: 0, claim_token: null });
  });

  it("retains only the latest 50 claims per delivery and cascades history with pruned deliveries", () => {
    const { db, store } = setup();
    for (let i = 0; i < 60; i++) {
      const claim = store.claim(i * 20_000)!;
      store.defer(claim, i * 20_000);
    }
    const history = store.history(1)!;
    expect(history.total).toBe(50);
    expect(history.attempts.map((a) => a.id)).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i));
    db.prepare("DELETE FROM outbox WHERE id=1").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_attempts").get()).toEqual({ count: 0 });
  });

  it("paginates every failed row, including old rows without a last failure timestamp", () => {
    const { db, store } = setup();
    db.prepare("UPDATE outbox SET status='sent'").run();
    const insert = db.prepare("INSERT INTO outbox (chat_id, body, status, attempts, available_at, created_at) VALUES ('chat','body','failed',5,0,0)");
    for (let i = 0; i < 51; i++) insert.run();
    expect(store.listFailed(1).deliveries).toHaveLength(50);
    expect(store.listFailed(2).deliveries).toEqual([{ id: 2, attempts: 5, retryCount: 0, failedAt: null, failureKind: "unknown" }]);
    expect(store.listFailed(3)).toMatchObject({ deliveries: [], total: 51 });
  });

  it("migrates schema five additively and persists retry/history/cancellation after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-recovery-"));
    const path = join(dir, "bot.db");
    let db = openDatabase(path);
    cleanup.push(() => {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    });
    new TellStore(db).add("chat", "alice", "Alice", "Bob", "keep");
    new TellStore(db).add("chat", "bob", "Bob", "Alice", "cancel");
    new RemindersStore(db).add("chat", null, "keep", 9999999999999);
    db.exec(`INSERT INTO outbox (chat_id,body,status,attempts,available_at,created_at,last_error,last_failure_at)
      VALUES ('chat','keep','failed',5,0,0,'old error',1);
      DROP TABLE admin_audit; DROP TABLE delivery_attempts; ALTER TABLE outbox DROP COLUMN manual_retry_count; PRAGMA user_version = 5;`);
    removeScopedSchema(db);
    const before = db.prepare("SELECT * FROM outbox").get();
    db.close();
    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM outbox").get()).toEqual({ ...before as object, manual_retry_count: 0 });
    let store = new OutboxStore(db);
    expect(store.history(1)!.attempts).toEqual([]);
    expect(store.retryFailed(1, 0, 10)).toBe(true);
    store.sent(store.claim(10)!);
    expect(new TellStore(db).remove(2)).toBe(true);
    db.close();
    db = openDatabase(path);
    store = new OutboxStore(db);
    expect(store.history(1)!.attempts[0]).toMatchObject({ retryCount: 1, outcome: "sent" });
    expect(store.retryFailed(1, 0)).toBe(false);
    expect(new TellStore(db).list(1).tells.map((tell) => tell.id)).toEqual([1]);
    expect(new RemindersStore(db).list(1).total).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
