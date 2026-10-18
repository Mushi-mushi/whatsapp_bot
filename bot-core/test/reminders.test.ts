import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { RemindersStore } from "../src/state/repos.js";
import { OutboxStore } from "../src/state/outbox.js";

it("persists scheduled cancellations across reopens without disturbing delivered, tell or pet records", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-reminders-"));
  const path = join(directory, "state.db");
  let db = openDatabase(path);
  try {
    const reminders = new RemindersStore(db);
    reminders.add("chat", "Alice", "cancel", 0);
    reminders.add("chat", "Bob", "keep", 0);
    db.exec(`
      INSERT INTO pets VALUES ('chat','{}');
      INSERT INTO tells(target_norm,target_name,from_name,message,created_ts) VALUES ('alice','Alice','Bob','tell',0);
      INSERT INTO outbox(chat_id,body,status,available_at,created_at) VALUES ('chat','already delivered','sent',0,0);
    `);
    const tables = ["pets", "tells", "outbox"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    expect(reminders.remove(1)).toBe(true);
    expect(reminders.remove(1)).toBe(false);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    db.close();
    db = openDatabase(path);
    expect(new RemindersStore(db).list(1, 123)).toEqual({
      sampledAt: 123, total: 1, page: 1, pageSize: 50,
      reminders: [{ id: 2, chatId: "chat", chatName: null, targetName: "Bob", text: "keep", dueAt: 0 }],
    });
    new OutboxStore(db).enqueueReminders(1000);
    expect(new RemindersStore(db).list(1).total).toBe(0);
    expect(db.prepare("SELECT body FROM outbox ORDER BY id").all()).toEqual([
      { body: "already delivered" }, { body: "Reminder: Bob, keep" },
    ]);
  } finally {
    if (db.open) db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    rmdirSync(directory);
  }
});
