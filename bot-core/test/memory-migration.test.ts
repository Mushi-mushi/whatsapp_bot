import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/state/db.js";
import { UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { memoryKey } from "../src/state/identity.js";
import { OutboxStore } from "../src/state/outbox.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("chat memory migration", () => {
  it("deletes only legacy memory once and preserves new scoped data on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatsapp-memory-"));
    const path = join(dir, "state.sqlite");
    let db = openDatabase(path);
    cleanup.push(() => {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    });
    db.exec(`
      INSERT INTO kv VALUES ('config', '{"test":true}');
      INSERT INTO contacts VALUES ('123@s.whatsapp.net', '123', 'Alice', 1);
      INSERT INTO chat_directory VALUES ('group@g.us', 'Friends', 1);
      INSERT INTO reminders (chat_id, text, due_ts, created_ts) VALUES ('group@g.us', 'remember', 2, 1);
      INSERT INTO tells (target_norm, target_name, from_name, message, created_ts) VALUES ('alice', 'Alice', 'Bob', 'hello', 1);
      INSERT INTO pets VALUES ('group@g.us', '{}');
      INSERT INTO outbox (chat_id, body, available_at, created_at) VALUES ('group@g.us', 'queued', 2, 1);
      INSERT INTO outbox (chat_id, body, status, attempts, available_at, created_at, lease_until, claim_token, last_error)
        VALUES ('group@g.us', 'claimed', 'sending', 2, 2, 1, 300000, 'existing-claim', 'old failure');
      INSERT INTO siesta_discipline (chat_id, sender_id, armed) VALUES ('group@g.us', '123', 1);
      DROP TABLE user_messages;
      DROP TABLE user_profiles;
      CREATE TABLE user_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender_key TEXT NOT NULL,
        name_norm TEXT NOT NULL, name TEXT NOT NULL, chat_name TEXT,
        message TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE TABLE user_profiles (
        sender_key TEXT PRIMARY KEY, name TEXT NOT NULL, deep TEXT NOT NULL,
        short TEXT NOT NULL, last_profiled_id INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      INSERT INTO user_messages (sender_key, name_norm, name, chat_name, message, ts)
        VALUES ('123', 'alice', 'Alice', 'Friends', 'legacy private message', 1);
      INSERT INTO user_profiles VALUES ('123', 'Alice', 'mixed-chat dossier', 'summary', 1, 1);
      PRAGMA user_version = 3;
    `);
    const tables = ["kv", "contacts", "chat_directory", "reminders", "tells", "pets", "outbox", "siesta_discipline"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec("DROP TABLE admin_audit; DROP TABLE delivery_attempts; ALTER TABLE outbox DROP COLUMN manual_retry_count; DROP INDEX idx_outbox_failures; ALTER TABLE outbox DROP COLUMN last_failure_at;");
    db.close();
    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(7);
    expect(db.prepare("SELECT * FROM user_messages").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM user_profiles").all()).toEqual([]);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);

    const key = memoryKey("group@g.us", "123");
    new UserMemoryStore(db).record(key, "Alice", "Friends", "fresh scoped message", 50);
    new UserProfileStore(db).upsert({ sender_key: key, name: "Alice", deep: "fresh dossier", short: "fresh", last_profiled_id: 1 });
    // Simulate a version-four installation: adding monitoring must not clear
    // the already isolated memory or alter existing outbox claims.
    db.exec("DROP TABLE admin_audit; DROP TABLE delivery_attempts; ALTER TABLE outbox DROP COLUMN manual_retry_count; DROP INDEX idx_outbox_failures; ALTER TABLE outbox DROP COLUMN last_failure_at; PRAGMA user_version = 4;");
    db.close();
    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(7);
    expect(new UserMemoryStore(db).recentFor(key)[0].message).toBe("fresh scoped message");
    expect(new UserProfileStore(db).get(key)?.deep).toBe("fresh dossier");
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    const outbox = new OutboxStore(db);
    expect(outbox.snapshot(3).recentFailures[0]).toMatchObject({ failedAt: null, status: "sending", attempts: 2 });
    outbox.failed({ id: 2, chat_id: "group@g.us", body: "claimed", attempts: 2, claim_token: "existing-claim" }, "new failure", 3);
    const snapshot = outbox.snapshot(3);
    db.close();
    db = openDatabase(path);
    expect(new OutboxStore(db).snapshot(3)).toEqual(snapshot);
    expect(new UserMemoryStore(db).recentFor(key)[0].message).toBe("fresh scoped message");
  });
});
