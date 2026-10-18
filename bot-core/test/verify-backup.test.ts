import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { AuditStore } from "../src/state/audit.js";
import { verifyBackup } from "../src/state/verify-backup.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), "backup-verifier-test-"));
  const source = join(root, "standalone.db");
  const db = openDatabase(join(root, "original.db"));
  cleanup.push(async () => {
    if (db.open) db.close();
    for (const entry of await fs.readdir(root)) await fs.rm(join(root, entry));
    await fs.rmdir(root);
  });
  db.exec(`
    INSERT INTO kv VALUES ('config', '{"redditClientSecret":"SECRET"}');
    INSERT INTO reminders(chat_id,target_name,text,due_ts,created_ts) VALUES ('SECRET','SECRET','SECRET',0,0);
    INSERT INTO tells(target_norm,target_name,from_name,message,created_ts) VALUES ('SECRET','SECRET','SECRET','SECRET',0);
    INSERT INTO pets VALUES ('SECRET','{"name":"SECRET"}');
    INSERT INTO pet_events(id,chat_id,stage,sleeping) VALUES ('SECRET','SECRET',0,0);
    INSERT INTO outbox(chat_id,body,status,available_at,created_at,pet_event_id,claim_token,attempts,lease_until)
      VALUES ('SECRET','SECRET','sending',0,0,'SECRET','SECRET',2,1000);
  `);
  const audit = new AuditStore(db);
  const id = audit.begin("config.save", null, "authenticated-api", 1000);
  audit.complete(id, "config.save", null, 200, 1001);
  await db.backup(source);
  const copy = new Database(source);
  copy.pragma("journal_mode = DELETE");
  copy.close();
  return { root, source, db };
}

async function hash(path: string) {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}

function captureTemporaryDirectories() {
  const original = fs.mkdtemp;
  const paths: string[] = [];
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const result = await original(prefix, options as { encoding: "utf8" });
    paths.push(result);
    return result;
  });
  return paths;
}

describe("isolated backup verification", () => {
  it("checks every application table and reports only bounded metadata while preserving source bytes, rows and files", async () => {
    const { source, root, db } = await setup();
    const before = await hash(source);
    const files = (await fs.readdir(root)).sort();
    const liveState = db.prepare("SELECT * FROM outbox").all();
    const paths = captureTemporaryDirectories();
    const result = await verifyBackup(source);
    expect(result).toMatchObject({
      ok: true, schemaVersion: DATABASE_SCHEMA_VERSION, sha256: before, bytes: (await fs.stat(source)).size,
      checks: { integrity: "ok", foreignKeys: "ok", schema: "ok", sourceUnchanged: true },
      counts: { kv: 1, reminders: 1, tells: 1, pets: 1, pet_events: 1, outbox: 1, admin_audit: 1, delivery_attempts: 0 },
    });
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    expect(Object.keys(result.counts)).toEqual(tables.map((row) => row.name));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(await hash(source)).toBe(before);
    expect((await fs.readdir(root)).sort()).toEqual(files);
    expect(db.prepare("SELECT * FROM outbox").all()).toEqual(liveState);
    expect(paths).toHaveLength(1);
    await expect(fs.lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a valid empty current database without inventing required nonzero counts", async () => {
    const { source } = await setup();
    const empty = openDatabase(":memory:");
    try { await empty.backup(source); } finally { empty.close(); }
    const result = await verifyBackup(source);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });

  it.each(["-wal", "-shm", "-journal"])("rejects sources with %s sidecars without opening SQLite on the source", async (suffix) => {
    const { source } = await setup();
    await fs.writeFile(`${source}${suffix}`, "SECRET");
    const before = await hash(source);
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "SOURCE_SIDECARS" });
    expect(await hash(source)).toBe(before);
    expect(await fs.readFile(`${source}${suffix}`, "utf8")).toBe("SECRET");
  });

  it("rejects live WAL databases and partial, missing, directory and symlink inputs", async () => {
    const { source, root } = await setup();
    await expect(verifyBackup(join(root, "original.db"))).rejects.toMatchObject({ code: "SOURCE_SIDECARS" });
    await expect(verifyBackup(root)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(verifyBackup(join(root, "missing.db"))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const partial = `${source}.partial`;
    await fs.copyFile(source, partial);
    await expect(verifyBackup(partial)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    if (process.platform !== "win32") {
      const link = join(root, "link.db");
      await fs.symlink(source, link);
      await expect(verifyBackup(link)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
  });

  it.each([0, DATABASE_SCHEMA_VERSION - 1, DATABASE_SCHEMA_VERSION + 1])("rejects incompatible schema %s without migrating or changing the source", async (version) => {
    const { source } = await setup();
    const raw = new Database(source);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = await hash(source);
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "SCHEMA_INCOMPATIBLE" });
    expect(await hash(source)).toBe(before);
    const checked = new Database(source, { readonly: true });
    try { expect(checked.pragma("user_version", { simple: true })).toBe(version); } finally { checked.close(); }
  });

  it("rejects corrupt files, redacts diagnostic details and cleans up failed copies", async () => {
    const { source } = await setup();
    await fs.writeFile(source, "SECRET invalid SQLite bytes");
    const paths = captureTemporaryDirectories();
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "DATABASE_INVALID" });
    expect(paths).toHaveLength(1);
    await expect(fs.lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects foreign-key violations even when SQLite structural integrity succeeds", async () => {
    const { source } = await setup();
    const db = new Database(source);
    db.pragma("foreign_keys = OFF");
    db.exec("INSERT INTO pet_events(id,chat_id,stage,sleeping) VALUES ('orphan','absent',0,0)");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "DATABASE_INVALID" });
  });

  it.each(["table", "column", "index", "foreign-key"])("rejects a current-version database missing required %s structure", async (kind) => {
    const { source } = await setup();
    const db = new Database(source);
    db.pragma("foreign_keys = OFF");
    if (kind === "table") db.exec("DROP TABLE tells");
    if (kind === "column") db.exec("ALTER TABLE tells RENAME COLUMN message TO wrong_message");
    if (kind === "index") db.exec("DROP INDEX idx_admin_audit_started");
    if (kind === "foreign-key") {
      db.exec("DROP TABLE delivery_attempts; CREATE TABLE delivery_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, outbox_id INTEGER NOT NULL, claim_token TEXT NOT NULL UNIQUE, retry_count INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, failure_kind TEXT); CREATE INDEX idx_delivery_attempts_outbox ON delivery_attempts(outbox_id,id DESC);");
    }
    db.close();
    const before = await hash(source);
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(await hash(source)).toBe(before);
  });

  it("detects a source modified while copying instead of certifying a moving target", async () => {
    const { source } = await setup();
    const copy = fs.copyFile;
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, flags) => {
      await copy(from, to, flags);
      const changed = new Database(source);
      changed.exec("INSERT INTO kv VALUES ('new','SECRET')");
      changed.close();
    });
    const paths = captureTemporaryDirectories();
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(fs.lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails explicitly and cleans its private directory when copying is denied", async () => {
    const { source } = await setup();
    const paths = captureTemporaryDirectories();
    vi.spyOn(fs, "copyFile").mockRejectedValue(new Error("SECRET source path and OS failure"));
    await expect(verifyBackup(source)).rejects.toMatchObject({
      code: "COPY_FAILED", message: "Could not create the isolated restore copy. Check source access and temporary disk space.",
    });
    await expect(fs.lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report success if cleanup fails, and identifies the private-directory prefix without exposing paths", async () => {
    const { source } = await setup();
    const paths = captureTemporaryDirectories();
    const removeDirectory = fs.rmdir;
    vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("SECRET path"));
    await expect(verifyBackup(source)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    await removeDirectory(paths[0]);
  });
});

describe("backup verification CLI", () => {
  const cli = resolve("src", "cli", "verify-backup.ts");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, DB_PATH: "DO-NOT-OPEN.db", AUTH_DIR: "DO-NOT-READ", API_PORT: "invalid" },
  });

  it("supports help and rejects missing, extra and unknown arguments with usage exit code 2", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("without migrations");
    for (const args of [[], ["one", "two"], ["--unknown"], [""]]) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "USAGE" });
    }
  });

  it("returns machine-readable success without using runtime DB/auth/network settings", async () => {
    const { source } = await setup();
    const result = run([source]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, schemaVersion: DATABASE_SCHEMA_VERSION, counts: { outbox: 1, admin_audit: 1 } });
    expect(result.stdout).not.toContain("SECRET");
  });

  it("returns nonzero failure JSON without raw private paths or file contents", async () => {
    const { source } = await setup();
    await fs.writeFile(source, "SECRET invalid database");
    const result = run([source]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "DATABASE_INVALID" });
    expect(result.stderr).not.toContain(source);
    expect(result.stderr).not.toContain("SECRET");
  });
});
