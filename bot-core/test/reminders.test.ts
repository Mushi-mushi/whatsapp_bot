import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { RemindersStore } from "../src/state/repos.js";
import { OutboxStore } from "../src/state/outbox.js";
import { makeRemind } from "../src/handlers/commands/remind.js";
import { Context } from "../src/router/context.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type { Transport } from "../src/transport/types.js";

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
      reminders: [{ id: 2, chatId: "chat", chatName: null, targetName: "Bob", text: "keep", dueAt: 0, recurrence: "once" }],
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

it("advances daily and weekly recurring reminders when due and supports WhatsApp recurrence syntax", async () => {
  const db = openDatabase(":memory:");
  try {
    const reminders = new RemindersStore(db);
    const outbox = new OutboxStore(db);
    const day = 86_400_000;
    const week = 7 * day;
    const idDaily = reminders.add("chat", "Alice", "standup", 1000, "daily");
    const idWeekly = reminders.add("chat", null, "retro", 1000, "weekly");

    outbox.enqueueReminders(1000);
    expect(reminders.get(idDaily)?.dueAt).toBe(1000 + day);
    expect(reminders.get(idWeekly)?.dueAt).toBe(1000 + week);

    // If the bot was offline across multiple intervals, advance to the first strictly future slot.
    outbox.enqueueReminders(1000 + 3 * day + 50);
    expect(reminders.get(idDaily)?.dueAt).toBe(1000 + 4 * day);

    const sendText = vi.fn().mockResolvedValue(undefined);
    const remind = makeRemind(reminders);
    const ctx = new Context({
      chatId: "chat", chatName: "Group", senderId: "34600000001@s.whatsapp.net", senderName: "Alice", senderPhone: "34600000001",
      messageId: "m1", fromMe: false, isGroup: true, text: "daily 10m take vitamins",
      kind: "text", timestamp: Date.now(), raw: { key: {} },
    }, { transport: { sendText } as unknown as Transport, getConfig: () => DEFAULT_CONFIG });
    ctx.args = "daily 10m take vitamins";
    await remind(ctx);
    expect(sendText).toHaveBeenCalledWith("chat", expect.stringContaining("(repeats daily): take vitamins"));
    expect(reminders.list(1).reminders.some((r) => r.text === "take vitamins" && r.recurrence === "daily")).toBe(true);
  } finally {
    db.close();
  }
});
