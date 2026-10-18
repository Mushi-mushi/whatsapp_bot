import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdtemp, chmod, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "./db.js";
import { checkDatabaseIntegrity } from "./database-checks.js";

export type VerificationCode = "INVALID_SOURCE" | "SOURCE_SIDECARS" | "SOURCE_CHANGED" | "COPY_FAILED"
  | "DATABASE_INVALID" | "SCHEMA_INCOMPATIBLE" | "SCHEMA_INVALID" | "CLEANUP_FAILED";

const messages: Record<VerificationCode, string> = {
  INVALID_SOURCE: "Provide an existing regular standalone database backup, not a directory, link or partial file.",
  SOURCE_SIDECARS: "Source has SQLite sidecars. Use a published standalone online backup, not a live database or raw WAL copy.",
  SOURCE_CHANGED: "Source changed during verification. Retry with a completed, immutable backup.",
  COPY_FAILED: "Could not create the isolated restore copy. Check source access and temporary disk space.",
  DATABASE_INVALID: "Isolated database failed to open or failed integrity/foreign-key checks.",
  SCHEMA_INCOMPATIBLE: "Backup schema does not match this application. Use the matching application version; this command never migrates backups.",
  SCHEMA_INVALID: "Backup is missing required schema structure or record counts could not be read.",
  CLEANUP_FAILED: "Could not remove the private temporary restore copy. Inspect your operating system temporary directory for bot-restore-check-* and remove only the verification directory.",
};

export class BackupVerificationError extends Error {
  constructor(public readonly code: VerificationCode) {
    super(messages[code]);
    this.name = "BackupVerificationError";
  }
}

export interface BackupVerificationReport {
  ok: true;
  schemaVersion: number;
  bytes: number;
  sha256: string;
  checks: { integrity: "ok"; foreignKeys: "ok"; schema: "ok"; sourceUnchanged: true };
  counts: Record<string, number>;
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkSource(path: string): Promise<void> {
  if (path.endsWith(".partial") || !(await lstat(path)).isFile()) throw new BackupVerificationError("INVALID_SOURCE");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const exists = await lstat(`${path}${suffix}`).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) throw new BackupVerificationError("SOURCE_SIDECARS");
  }
}

interface Column { name: string; type: string; notnull: number; pk: number }
interface ForeignKey { table: string; from: string; to: string; on_update: string; on_delete: string }
interface Index { name: string; unique: number; partial: number }
interface IndexColumn { name: string | null; desc: number; coll: string; key: number }
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function checkSchemaAndCount(copy: Database.Database): Record<string, number> {
  // Build the expected schema in memory only; the restored file never uses the migrating opener.
  const expected = openDatabase(":memory:");
  try {
    const tables = expected.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      if (!copy.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)) throw new BackupVerificationError("SCHEMA_INVALID");
      const columns = expected.pragma(`table_info(${quote(name)})`) as Column[];
      const actual = copy.pragma(`table_info(${quote(name)})`) as Column[];
      for (const col of columns) {
        if (!actual.some((other) => other.name === col.name && other.type.toUpperCase() === col.type.toUpperCase()
          && other.notnull === col.notnull && other.pk === col.pk)) throw new BackupVerificationError("SCHEMA_INVALID");
      }
      const foreignKeys = expected.pragma(`foreign_key_list(${quote(name)})`) as ForeignKey[];
      const actualKeys = copy.pragma(`foreign_key_list(${quote(name)})`) as ForeignKey[];
      for (const fk of foreignKeys) {
        if (!actualKeys.some((other) => other.table === fk.table && other.from === fk.from && other.to === fk.to
          && other.on_update === fk.on_update && other.on_delete === fk.on_delete)) throw new BackupVerificationError("SCHEMA_INVALID");
      }
      const indexes = expected.pragma(`index_list(${quote(name)})`) as Index[];
      const actualIndexes = copy.pragma(`index_list(${quote(name)})`) as Index[];
      for (const index of indexes) {
        if (!actualIndexes.some((other) => other.name === index.name && other.unique === index.unique && other.partial === index.partial)) {
          throw new BackupVerificationError("SCHEMA_INVALID");
        }
        const columns = (db: Database.Database) => (db.pragma(`index_xinfo(${quote(index.name)})`) as IndexColumn[])
          .map(({ name, desc, coll, key }) => ({ name, desc, coll, key }));
        if (JSON.stringify(columns(expected)) !== JSON.stringify(columns(copy))) throw new BackupVerificationError("SCHEMA_INVALID");
      }
      const { count } = copy.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get() as { count: number };
      if (!Number.isSafeInteger(count) || count < 0) throw new BackupVerificationError("SCHEMA_INVALID");
      counts[name] = count;
    }
    return counts;
  } finally { expected.close(); }
}

export async function verifyBackup(source: string): Promise<BackupVerificationReport> {
  const path = resolve(source);
  let directory: string | undefined;
  let stage: VerificationCode = "INVALID_SOURCE";
  let result: BackupVerificationReport | BackupVerificationError;
  try {
    await checkSource(path);
    stage = "COPY_FAILED";
    const originalHash = await digest(path);
    directory = await mkdtemp(join(tmpdir(), "bot-restore-check-"));
    await chmod(directory, 0o700);
    const restoredPath = join(directory, "restored.db");
    await copyFile(path, restoredPath, constants.COPYFILE_EXCL);
    await chmod(restoredPath, 0o600);
    stage = "SOURCE_CHANGED";
    await checkSource(path);
    const sha256 = await digest(restoredPath);
    if (originalHash !== sha256 || await digest(path) !== originalHash) throw new BackupVerificationError("SOURCE_CHANGED");
    const bytes = (await lstat(restoredPath)).size;
    stage = "DATABASE_INVALID";
    const copy = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try {
      copy.pragma("query_only = ON");
      copy.pragma("trusted_schema = OFF");
      checkDatabaseIntegrity(copy);
      const schemaVersion = copy.pragma("user_version", { simple: true }) as number;
      if (schemaVersion !== DATABASE_SCHEMA_VERSION) throw new BackupVerificationError("SCHEMA_INCOMPATIBLE");
      stage = "SCHEMA_INVALID";
      const counts = checkSchemaAndCount(copy);
      stage = "SOURCE_CHANGED";
      await checkSource(path);
      if (await digest(path) !== originalHash) throw new BackupVerificationError("SOURCE_CHANGED");
      result = { ok: true, schemaVersion, bytes, sha256,
        checks: { integrity: "ok", foreignKeys: "ok", schema: "ok", sourceUnchanged: true }, counts };
    } finally { copy.close(); }
  } catch (error) {
    result = error instanceof BackupVerificationError ? error : new BackupVerificationError(stage);
  }
  if (directory) {
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(directory, `restored.db${suffix}`), { force: true });
      await rmdir(directory);
    } catch {
      throw new BackupVerificationError("CLEANUP_FAILED");
    }
  }
  if (result instanceof BackupVerificationError) throw result;
  return result;
}
