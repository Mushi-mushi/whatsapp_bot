import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { InteractionStore } from "../src/state/interactions.js";
import { ContactsStore } from "../src/state/repos.js";

const PN = "34600000001@s.whatsapp.net";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe("persistent interaction counters", () => {
  it("converts schema 12 counters once and preserves paid-down debt and active mutes on restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-debt-"));
    const path = join(directory, "bot.db");
    const bob = "34600000002@s.whatsapp.net";
    const now = Date.parse("2026-10-20T12:00:00Z");
    let db = openDatabase(path);
    try {
      db.exec(`DROP TABLE user_mutes;
        ALTER TABLE user_interactions DROP COLUMN debt_cents;
        INSERT INTO user_interactions(sender_id, count) VALUES ('${PN}', 37);
        PRAGMA user_version = 12;`);
      db.close();
      db = openDatabase(path);
      let store = new InteractionStore(db);
      expect(store.total(PN)).toBe(37);
      expect(store.debt(PN)).toBe(370);
      expect(store.mute("g@g.us", bob, PN, 3, now)).toEqual({ ok: true, until: now + 180_000 });
      expect(store.debt(PN)).toBe(70);
      expect(store.debt(bob)).toBe(60);
      db.close();
      db = openDatabase(path);
      store = new InteractionStore(db);
      expect(store.debt(PN)).toBe(70);
      expect(store.total(PN)).toBe(37);
      expect(store.debt(bob)).toBe(60);
      expect(store.muteUntil("g@g.us", PN)).toBe(now + 180_000);
      expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });

  it("combines previously separate verified aliases without merging identical display names", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const store = new InteractionStore(db);
    store.increment("900@lid");
    store.increment(PN);
    store.increment("901@lid");
    expect(store.total(PN)).toBe(1);
    new ContactsStore(db).upsertMany([
      { jid: "900@lid", phone: "34600000001", name: "Alex" },
      { jid: "901@lid", phone: "34600000002", name: "Alex" },
    ]);
    store.increment("34600000001:2@s.whatsapp.net");
    for (const sender of [PN, "900@lid", "34600000001:3@s.whatsapp.net"]) {
      expect(store.total(sender)).toBe(3);
    }
    expect(store.total("901@lid")).toBe(1);
    store.increment("902@lid", "34600000001");
    expect(store.total(PN)).toBe(4);
    expect(store.total("902@lid", "34600000001")).toBe(4);
  });

  it("migrates schema 11 additively and preserves counters through restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-billing-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    try {
      db.exec("INSERT INTO kv VALUES ('billing-test','keep'); DROP TABLE user_interactions; DROP TABLE user_mutes; PRAGMA user_version = 11;");
      db.close();
      db = openDatabase(path);
      expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(db.prepare("SELECT value FROM kv WHERE key = 'billing-test'").get()).toEqual({ value: "keep" });
      const store = new InteractionStore(db);
      expect(store.total(PN)).toBe(0);
      store.increment(PN);
      store.increment(PN);
      db.close();
      db = openDatabase(path);
      expect(new InteractionStore(db).total(PN)).toBe(2);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});
