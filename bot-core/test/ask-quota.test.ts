import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/state/db.js";
import { AskQuotaStore } from "../src/state/ask-quota.js";
import { ContactsStore } from "../src/state/repos.js";
import { removeScopedSchema } from "./legacy-schema.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const HOUR = 3_600_000;
const PN = "34600000001@s.whatsapp.net";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return { db, quota: new AskQuotaStore(db) };
}

describe("persistent ask quota", () => {
  it("allows exactly ten and resets at the exact cooldown boundary without extending it on rejection", () => {
    const { quota } = setup();
    for (let i = 0; i < 10; i++) expect(quota.consume("group@g.us", PN, null, NOW)).toEqual({ allowed: true });
    expect(quota.consume("group@g.us", PN, null, NOW + 1)).toEqual({ allowed: false, retryAt: NOW + HOUR });
    expect(quota.consume("group@g.us", PN, null, NOW + HOUR - 1)).toEqual({ allowed: false, retryAt: NOW + HOUR });
    for (let i = 0; i < 10; i++) expect(quota.consume("group@g.us", PN, null, NOW + HOUR)).toEqual({ allowed: true });
    expect(quota.consume("group@g.us", PN, null, NOW + HOUR)).toEqual({ allowed: false, retryAt: NOW + 2 * HOUR });
  });

  it("counts across the UTC day, not an hour from the first request, and resets at midnight", () => {
    const { quota } = setup();
    for (let i = 0; i < 9; i++) quota.consume("group@g.us", PN, null, NOW);
    const last = Date.parse("2026-10-18T23:50:00Z");
    const midnight = Date.parse("2026-10-19T00:00:00Z");
    expect(quota.consume("group@g.us", PN, null, last)).toEqual({ allowed: true });
    expect(quota.consume("group@g.us", PN, null, last + 1)).toEqual({ allowed: false, retryAt: midnight });
    expect(quota.consume("group@g.us", PN, null, midnight)).toEqual({ allowed: true });
  });

  it("isolates people and chats while recognizing verified aliases, phone hints and device addresses", () => {
    const { db, quota } = setup();
    for (let i = 0; i < 10; i++) quota.consume("900@lid", "900@lid", null, NOW);
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "Alex" }]);
    expect(quota.consume(PN, "34600000001:2@s.whatsapp.net", null, NOW)).toEqual({ allowed: false, retryAt: NOW + HOUR });
    expect(quota.consume("other@g.us", PN, null, NOW)).toEqual({ allowed: true });
    expect(quota.consume(PN, "901@lid", null, NOW)).toEqual({ allowed: true });
    for (let i = 0; i < 10; i++) quota.consume("group@g.us", "900@lid", "34600000001", NOW);
    expect(quota.consume("group@g.us", PN, null, NOW).allowed).toBe(false);
  });

  it("does not grant extra requests when two previously separate verified aliases become known", () => {
    const { db, quota } = setup();
    for (let i = 0; i < 6; i++) {
      quota.consume("group@g.us", "900@lid", null, NOW);
      quota.consume("group@g.us", PN, null, NOW);
    }
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
    expect(quota.consume("group@g.us", PN, null, NOW)).toEqual({ allowed: false, retryAt: NOW + HOUR });
    expect(quota.consume("group@g.us", "900@lid", null, NOW + HOUR).allowed).toBe(true);
  });

  it("migrates schema seven without changing existing tables and preserves quotas across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-ask-quota-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    try {
      db.exec("INSERT INTO kv VALUES ('quota-test','keep'); DROP TABLE ask_quota; PRAGMA user_version = 7;");
      removeScopedSchema(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const snapshot = () => tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all());
      const before = snapshot();
      db.close();
      db = openDatabase(path);
      expect(db.pragma("user_version", { simple: true })).toBe(10);
      expect(snapshot()).toEqual(before);
      const quota = new AskQuotaStore(db);
      for (let i = 0; i < 10; i++) quota.consume("group@g.us", PN, null, NOW);
      db.close();
      db = openDatabase(path);
      expect(new AskQuotaStore(db).consume("group@g.us", PN, null, NOW + 1))
        .toEqual({ allowed: false, retryAt: NOW + HOUR });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});
