import type Database from "better-sqlite3";

export function checkDatabaseIntegrity(db: Database.Database): void {
  const checks = db.pragma("integrity_check") as { integrity_check: string }[];
  if (checks.length !== 1 || checks[0].integrity_check !== "ok") throw new Error("Database integrity check failed");
  if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Database foreign key check failed");
}
