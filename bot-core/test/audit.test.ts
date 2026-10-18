import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import Fastify from "fastify";
import { openDatabase } from "../src/state/db.js";
import { removeScopedSchema } from "./legacy-schema.js";
import { AuditStore, AUDIT_MAX_ENTRIES, AUDIT_RETENTION_DAYS } from "../src/state/audit.js";
import { RetentionWorker } from "../src/state/retention.js";
import { registerAudit } from "../src/api/audit.js";
import { OutboxStore } from "../src/state/outbox.js";
import { RemindersStore } from "../src/state/repos.js";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((close) => close()); vi.restoreAllMocks(); });
const DAY = 86_400_000;
const NOW = 200 * DAY;
function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  const store = new AuditStore(db);
  return { db, store };
}

describe("administrative audit persistence", () => {
  it("records explicit unknown outcomes until completed, with HTTP outcome metadata and deterministic pagination", () => {
    const { store } = setup();
    const first = store.begin("reminder.cancel", "42", "authenticated-api", NOW);
    expect(store.list(1, NOW)).toEqual({
      entries: [{ id: first, action: "reminder.cancel", targetId: "42", actor: "authenticated-api",
        startedAt: NOW, completedAt: null, outcome: "unknown", statusCode: null }],
      total: 1, page: 1, pageSize: 50, sampledAt: NOW, retentionDays: 90, maxEntries: 10000,
    });
    store.complete(first, "reminder.cancel", "42", 200, NOW + 1);
    const rejected = store.begin("tell.cancel", null, "authenticated-api", NOW);
    store.complete(rejected, "tell.cancel", null, 409, NOW + 2);
    const failed = store.begin("config.save", null, "authenticated-api", NOW);
    store.complete(failed, "config.save", null, 500, NOW + 3);
    expect(store.list(1).entries.map((entry) => entry.outcome)).toEqual(["failed", "rejected", "succeeded"]);
    expect(() => store.complete(first, "tell.cancel", null, 200)).toThrow("completion could not be recorded");
    for (let i = 0; i < 48; i++) store.begin("siesta.cancel", null, "authenticated-api", NOW);
    expect(store.list(1).entries).toHaveLength(50);
    expect(store.list(2).entries.map((entry) => entry.id)).toEqual([first]);
    expect(store.list(3)).toMatchObject({ entries: [], total: 51 });
  });

  it("enforces the exact age cutoff and hard 10000-row cap on every new action", () => {
    const { db, store } = setup();
    const insert = db.prepare(`INSERT INTO admin_audit (action, actor, started_at, outcome)
      VALUES ('config.save','authenticated-api',?,'unknown')`);
    insert.run(NOW - AUDIT_RETENTION_DAYS * DAY - 1);
    insert.run(NOW - AUDIT_RETENTION_DAYS * DAY);
    store.begin("config.save", null, "authenticated-api", NOW);
    expect(store.list(1).entries.map((entry) => entry.id)).toEqual([3, 2]);
    db.transaction(() => { for (let i = 0; i < AUDIT_MAX_ENTRIES; i++) insert.run(NOW); })();
    const id = store.begin("siesta.cancel", null, "authenticated-api", NOW);
    const data = store.list(1);
    expect(data.total).toBe(AUDIT_MAX_ENTRIES);
    expect(data.entries[0].id).toBe(id);
    expect(db.prepare("SELECT MIN(id) AS id FROM admin_audit").get()).toEqual({ id: 5 });
  });

  it("prunes at startup/daily independently of analytics retention and leaves protected bot state untouched", () => {
    const { db, store } = setup();
    store.begin("config.save", null, "authenticated-api", 0);
    db.exec("INSERT INTO complaints (ts,sender,message) VALUES (0,'keep','keep')");
    new RemindersStore(db).add("chat", null, "keep", 0);
    const logger = pino({ level: "silent" });
    const info = vi.spyOn(logger, "info");
    new RetentionWorker(db, () => ({ retentionEnabled: false, analyticsRetentionDays: 90, deliveryRetentionDays: 30 }), logger).run(NOW);
    expect(store.list(1).total).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS total FROM complaints").get()).toEqual({ total: 1 });
    expect(new RemindersStore(db).list(1).total).toBe(1);
    expect(info).toHaveBeenCalledWith({ removed: 1 }, "Administrative audit retention cleanup completed");
  });

  it("rolls back audit and analytics cleanup together on a cleanup failure", () => {
    const { db, store } = setup();
    store.begin("config.save", null, "authenticated-api", 0);
    db.exec(`INSERT INTO complaints (ts,sender,message) VALUES (0,'keep','keep');
      CREATE TRIGGER fail_retention BEFORE DELETE ON complaints BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    const logger = pino({ level: "silent" });
    const error = vi.spyOn(logger, "error");
    new RetentionWorker(db, () => ({ retentionEnabled: true, analyticsRetentionDays: 90, deliveryRetentionDays: 30 }), logger).run(NOW);
    expect(store.list(1).total).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }),
      "Retention cleanup failed; transaction rolled back, retrying next daily pass");
  });

  it("fails begin atomically if pruning is unavailable, preserving prior audit records", () => {
    const { db, store } = setup();
    store.begin("config.save", null, "authenticated-api", 0);
    db.exec("CREATE TRIGGER fail_audit_prune BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect(() => store.begin("tell.cancel", "1", "authenticated-api", NOW)).toThrow("blocked");
    expect(store.list(1).entries.map((entry) => entry.action)).toEqual(["config.save"]);
  });

  it("rejects future mutation routes missing an audit action while leaving read routes alone", async () => {
    const { store } = setup();
    const app = Fastify();
    try {
      registerAudit(app, store, "test");
      expect(() => app.post("/api/untracked", async () => ({}))).toThrow("missing an audit action");
      expect(() => app.get("/api/read-only", async () => ({}))).not.toThrow();
    } finally { await app.close(); }
  });

  it("migrates schema six without changing state and preserves completed/unknown records across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "admin-audit-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    cleanup.push(() => {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    });
    const reminders = new RemindersStore(db);
    reminders.add("chat", null, "keep", 0);
    new OutboxStore(db).enqueueReminders(0);
    const claim = new OutboxStore(db).claim(1)!;
    db.exec("INSERT INTO kv VALUES ('test','keep'); DROP TABLE admin_audit; PRAGMA user_version=6;");
    removeScopedSchema(db);
    const tables = ["outbox", "delivery_attempts", "kv", "pets", "reminders", "tells"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    db.close();
    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    const audit = new AuditStore(db);
    const id = audit.begin("delivery.retry", "1", "authenticated-api", NOW);
    audit.complete(id, "delivery.retry", "1", 200, NOW + 1);
    audit.begin("connection.relink", null, "authenticated-api", NOW);
    new OutboxStore(db).sent(claim);
    const expected = audit.list(1, NOW);
    db.close();
    db = openDatabase(path);
    expect(new AuditStore(db).list(1, NOW)).toEqual(expected);
    expect(new OutboxStore(db).history(1)!.attempts[0].outcome).toBe("sent");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
