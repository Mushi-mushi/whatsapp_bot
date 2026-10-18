import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { renameSync } from "node:fs";
import { openDatabase } from "../src/state/db.js";
import { BackupWorker, backupOptions } from "../src/state/backups.js";
import { AuditStore } from "../src/state/audit.js";
import { AskQuotaStore } from "../src/state/ask-quota.js";

const DAY = 86_400_000;
const NOW = 1800000000000;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bot-backups-"));
  const path = join(root, "source.db");
  const directory = join(root, "automatic");
  const db = openDatabase(path);
  const logger = pino({ level: "silent" });
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  const worker = new BackupWorker(db, { directory, retentionDays: 14 }, logger);
  cleanup.push(async () => { await worker.stop(); if (db.open) db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, db, directory, logger, info, error, worker };
}

function autoName(time: number, id = "00000000-0000-4000-8000-000000000000"): string {
  return `bot-auto-${time}-${id}.db`;
}

describe("backup configuration", () => {
  it("disables standalone backups without a directory and supplies the default retention", () => {
    expect(backupOptions({})).toEqual({ directory: undefined, retentionDays: 14 });
    expect(backupOptions({ BACKUP_DIR: "  " }).directory).toBeUndefined();
    expect(backupOptions({ BACKUP_DIR: " /backups ", BACKUP_RETENTION_DAYS: "30" }))
      .toEqual({ directory: "/backups", retentionDays: 30 });
  });

  it.each(["", "0", "-1", "1.5", "3651", "invalid"])("rejects invalid retention %s", (value) => {
    expect(() => backupOptions({ BACKUP_RETENTION_DAYS: value })).toThrow();
  });
});

describe("verified database backups", () => {
  it("restores WAL-backed data into an isolated standalone database without migrating or changing source records", async () => {
    const { root, db, directory, worker } = await setup();
    db.exec(`
      INSERT INTO kv VALUES ('private-config', 'SECRET');
      INSERT INTO reminders(chat_id,text,due_ts,created_ts) VALUES ('private','SECRET',10,0);
      INSERT INTO pets VALUES ('private','{"name":"SECRET"}');
      INSERT INTO outbox(chat_id,body,status,available_at,created_at,claim_token,attempts,lease_until)
        VALUES ('private','SECRET','sending',0,0,'SECRET',2,1000);
    `);
    const audit = new AuditStore(db);
    const action = audit.begin("config.save", null, "authenticated-api");
    audit.complete(action, "config.save", null, 200);
    new AskQuotaStore(db).consume("private", "person", null, NOW);
    await worker.run();
    const filenames = await readdir(directory);
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toMatch(/^bot-auto-\d{13}-.+\.db$/);
    const restoreDirectory = join(root, "isolated-restore");
    await mkdir(restoreDirectory);
    const restoredPath = join(restoreDirectory, "restored.db");
    await copyFile(join(directory, filenames[0]), restoredPath);
    const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try {
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(restored.pragma("foreign_key_check")).toEqual([]);
      expect(restored.pragma("user_version", { simple: true })).toBe(9);
      expect(restored.pragma("journal_mode", { simple: true })).toBe("delete");
      for (const table of ["reminders", "pets", "outbox", "admin_audit", "ask_quota"]) {
        expect(restored.prepare(`SELECT * FROM ${table}`).all()).toEqual(db.prepare(`SELECT * FROM ${table}`).all());
      }
      expect(restored.prepare("SELECT value FROM kv WHERE key='private-config'").get()).toEqual({ value: "SECRET" });
    } finally { restored.close(); }
    const snapshot = worker.snapshot();
    expect(snapshot).toMatchObject({
      enabled: true, running: false, retentionDays: 14, intervalHours: 24,
      lastSuccessAt: expect.any(Number), lastSizeBytes: expect.any(Number), lastFailureAt: null, lastError: null,
    });
    expect(snapshot.lastSizeBytes).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot)).not.toContain(directory);
  });

  it("persists verification metadata across worker/database restarts and returns independent snapshots", async () => {
    const { db, path, worker, directory, logger } = await setup();
    await worker.run();
    const expected = worker.snapshot();
    const snapshot = worker.snapshot();
    snapshot.lastSuccessAt = 0;
    expect(worker.snapshot().lastSuccessAt).toBe(expected.lastSuccessAt);
    db.close();
    const reopened = openDatabase(path);
    try {
      expect(new BackupWorker(reopened, { directory, retentionDays: 14 }, logger).snapshot()).toEqual(expected);
    } finally { reopened.close(); }
  });

  it("prunes only strictly expired generated files after a successful backup, retaining manual files and directories", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const { directory, worker } = await setup();
    await mkdir(directory);
    const expired = autoName(NOW - 14 * DAY - 1);
    const boundary = autoName(NOW - 14 * DAY);
    const directoryName = autoName(NOW - 40 * DAY);
    const keep = [boundary, autoName(NOW + DAY), "manual-before-upgrade.db", "notes.txt",
      `${autoName(NOW - 40 * DAY)}.partial`, "bot-auto-invalid.db"];
    await writeFile(join(directory, expired), "old");
    for (const name of keep) await writeFile(join(directory, name), "keep");
    await mkdir(join(directory, directoryName));
    await worker.run();
    const remaining = await readdir(directory);
    expect(remaining).not.toContain(expired);
    for (const name of [...keep, directoryName]) expect(remaining).toContain(name);
    expect(remaining.length).toBe(keep.length + 2);
  });

  it("retains previous backups and reports failures without exposing raw errors when destination is unwritable", async () => {
    const { db, root, logger, error } = await setup();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "keep");
    const worker = new BackupWorker(db, { directory: blocked, retentionDays: 14 }, logger);
    await worker.run();
    expect(worker.snapshot()).toMatchObject({
      running: false, lastSuccessAt: null, lastFailureAt: expect.any(Number), lastError: "backup",
    });
    expect(await readFile(blocked, "utf8")).toBe("keep");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ stage: "backup", err: expect.any(Error) }),
      "Database backup maintenance failed; retrying next daily pass");
    expect(JSON.stringify(worker.snapshot())).not.toContain(blocked);
    const restarted = new BackupWorker(db, { directory: blocked, retentionDays: 14 }, logger);
    expect(restarted.snapshot().lastError).toBe("backup");
  });

  it("does not publish corrupt backups or prune good old copies after verification fails", async () => {
    const { db, directory, worker, info } = await setup();
    await mkdir(directory);
    const old = autoName(NOW - 100 * DAY);
    await writeFile(join(directory, old), "previous backup");
    vi.spyOn(db, "backup").mockImplementation(async (destination) => {
      await writeFile(destination, "invalid SQLite data");
      return { totalPages: 1, remainingPages: 0 };
    });
    await worker.run();
    expect(await readdir(directory)).toEqual([old]);
    expect(worker.snapshot()).toMatchObject({ lastError: "backup", lastSuccessAt: null });
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects foreign key violations in the copied database", async () => {
    const { db, directory, worker } = await setup();
    db.pragma("foreign_keys = OFF");
    db.exec(`INSERT INTO outbox(chat_id,body,available_at,created_at,pet_event_id)
      VALUES ('private','body',0,0,'nonexistent')`);
    db.pragma("foreign_keys = ON");
    await worker.run();
    expect(worker.snapshot().lastError).toBe("backup");
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports pruning errors separately, keeps the verified copy and clears the error on a later success", async () => {
    const { root, directory, worker, info, logger, db } = await setup();
    const moved = join(root, "temporarily-unavailable");
    info.mockImplementationOnce(() => { renameSync(directory, moved); });
    await worker.run();
    expect(worker.snapshot()).toMatchObject({
      lastError: "prune", lastSuccessAt: expect.any(Number), lastFailureAt: expect.any(Number),
      lastSizeBytes: expect.any(Number), running: false,
    });
    expect(await readdir(moved)).toHaveLength(1);
    expect(new BackupWorker(db, { directory, retentionDays: 14 }, logger).snapshot().lastError).toBe("prune");
    renameSync(moved, directory);
    await worker.run();
    expect(worker.snapshot().lastError).toBeNull();
    expect(await readdir(directory)).toHaveLength(2);
  });

  it("keeps a previous successful backup and its metadata after a subsequent backup failure", async () => {
    const { db, directory, worker } = await setup();
    await worker.run();
    const first = worker.snapshot();
    const files = await readdir(directory);
    vi.spyOn(db, "backup").mockRejectedValue(new Error("SECRET diagnostics"));
    await worker.run();
    expect(worker.snapshot()).toMatchObject({
      lastSuccessAt: first.lastSuccessAt, lastSizeBytes: first.lastSizeBytes,
      lastError: "backup", lastFailureAt: expect.any(Number),
    });
    expect(await readdir(directory)).toEqual(files);
    expect(JSON.stringify(worker.snapshot())).not.toContain("SECRET");
  });

  it("coalesces overlapping runs and waits for the active backup before stopping", async () => {
    const { db, worker, directory } = await setup();
    const original = db.backup.bind(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backup = vi.spyOn(db, "backup").mockImplementation(async (destination) => {
      await gate;
      return original(destination);
    });
    const first = worker.run();
    expect(worker.run()).toBe(first);
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1));
    expect(worker.snapshot().running).toBe(true);
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
    expect(worker.snapshot()).toMatchObject({ running: false, nextRunAt: null, lastError: null });
    await worker.run();
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("schedules startup and daily passes once and disposes its timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const { worker, directory } = await setup();
    worker.start();
    worker.start();
    await worker.run();
    expect(await readdir(directory)).toHaveLength(1);
    expect(worker.snapshot().nextRunAt).toBe(NOW + DAY);
    vi.advanceTimersByTime(DAY - 1);
    expect(worker.snapshot().running).toBe(false);
    vi.advanceTimersByTime(1);
    await worker.run();
    expect(await readdir(directory)).toHaveLength(2);
    expect(worker.snapshot().nextRunAt).toBe(NOW + 2 * DAY);
    await worker.stop();
    vi.advanceTimersByTime(DAY);
    expect(await readdir(directory)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no IO or scheduling when backups are disabled", async () => {
    const { db, logger } = await setup();
    const backup = vi.spyOn(db, "backup");
    const worker = new BackupWorker(db, { retentionDays: 14 }, logger);
    worker.start();
    await worker.run();
    expect(backup).not.toHaveBeenCalled();
    expect(worker.snapshot()).toMatchObject({ enabled: false, running: false, nextRunAt: null, lastAttemptAt: null });
    await worker.stop();
  });

  it("fails explicitly on corrupt persisted status instead of fabricating a successful history", async () => {
    const { db, logger } = await setup();
    db.prepare("INSERT INTO kv VALUES ('database_backup_status', ?)").run('{"lastSuccessAt":"wrong"}');
    expect(() => new BackupWorker(db, { retentionDays: 14 }, logger)).toThrow();
  });
});
