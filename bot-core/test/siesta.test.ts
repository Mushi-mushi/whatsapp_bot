import { describe, it, expect, vi } from "vitest";
import { makeSiesta } from "../src/handlers/commands/siesta.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { RuntimeState } from "../src/state/runtime.js";
import { openDatabase } from "../src/state/db.js";
import { ContactsStore, SiestaDisciplineStore, utcDay } from "../src/state/repos.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

function setup(args: string, msgOverrides: Partial<IncomingMessage> = {}, config: Partial<BotConfig> = {}) {
  const db = openDatabase(":memory:");
  const runtime = new RuntimeState();
  const discipline = new SiestaDisciplineStore(db);
  const msg: IncomingMessage = {
    chatId: "g@g.us",
    chatName: "Group",
    senderId: "34600@s.whatsapp.net",
    senderName: "Player",
    senderPhone: "34600",
    messageId: "m1",
    fromMe: false,
    isGroup: true,
    text: `bot.siesta ${args}`,
    kind: "text",
    timestamp: Date.now(),
    raw: {} as WAMessage,
    ...msgOverrides,
  };
  const sendText = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText } as unknown as Services["transport"],
    getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  return { run: () => makeSiesta(runtime, discipline)(ctx), runtime, discipline, sendText, msg, db };
}

const reply = (sendText: ReturnType<typeof vi.fn>) => sendText.mock.calls.at(-1)?.[1] as string;

describe("bot.siesta discipline", () => {
  it("resets usage across all chats and aliases without waking, disarming or changing other players", () => {
    const { discipline, db } = setup("5");
    try {
      const sender = "34600000001@s.whatsapp.net";
      const other = "34600000002@s.whatsapp.net";
      for (const chat of ["a@g.us", "b@g.us"]) {
        discipline.recordAllowedSiesta(chat, "900@lid", "2026-10-18");
        discipline.recordAllowedSiesta(chat, sender, "2026-10-18");
        discipline.recordAllowedSiesta(chat, other, "2026-10-18");
        discipline.putToSleep(chat, sender, Date.now() + 60000);
        discipline.arm(chat, sender);
      }
      new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "Alice" }]);
      discipline.resetUsageForUser("34600000001:2@s.whatsapp.net");
      discipline.resetUsageForUser(sender);
      for (const chat of ["a@g.us", "b@g.us"]) {
        expect(discipline.countToday(chat, "900@lid", "2026-10-18")).toBe(0);
        expect(discipline.get(chat, sender)?.lastSiestaDay).toBeNull();
        expect(discipline.isArmed(chat, sender)).toBe(true);
        expect(discipline.sleepUntil(chat, sender)).not.toBeNull();
        expect(discipline.countToday(chat, other, "2026-10-18")).toBe(1);
      }
    } finally { db.close(); }
  });

  it("allows exactly the configured daily count before putting the player to sleep", async () => {
    const { run, runtime, discipline, msg, db } = setup("5", {}, { siestaMaxCalls: 3 });
    try {
      for (let i = 1; i <= 3; i++) {
        await run();
        expect(runtime.isSleeping()).toBe(true);
        expect(discipline.countToday(msg.chatId, msg.senderId, utcDay(Date.now()))).toBe(i);
        runtime.cancelSiesta();
      }
      await run();
      expect(runtime.isSleeping()).toBe(false);
      expect(discipline.sleepUntil(msg.chatId, msg.senderId)).not.toBeNull();
      expect(discipline.countToday(msg.chatId, msg.senderId, utcDay(Date.now()))).toBe(3);
    } finally { db.close(); }
  });

  it("combines verified aliases, preserves counts when waking and resets on a different day", () => {
    const { discipline, db } = setup("5");
    try {
      discipline.recordAllowedSiesta("g@g.us", "900@lid", "2026-10-18");
      discipline.recordAllowedSiesta("g@g.us", "34600000001@s.whatsapp.net", "2026-10-18");
      new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "Alice" }]);
      const sender = "34600000001@s.whatsapp.net";
      expect(discipline.countToday("g@g.us", sender, "2026-10-18")).toBe(2);
      discipline.recordAllowedSiesta("g@g.us", sender, "2026-10-18");
      discipline.wake("g@g.us", sender);
      expect(discipline.countToday("g@g.us", sender, "2026-10-18")).toBe(3);
      expect(discipline.countToday("other@g.us", sender, "2026-10-18")).toBe(0);
      discipline.recordAllowedSiesta("g@g.us", sender, "2026-10-19");
      expect(discipline.countToday("g@g.us", sender, "2026-10-19")).toBe(1);
    } finally { db.close(); }
  });

  it("naps the bot and records the daily allowance on first use", async () => {
    const { run, runtime, discipline, msg, db } = setup("10");
    await run();
    expect(runtime.isSleeping()).toBe(true);
    expect(discipline.usedToday(msg.chatId, msg.senderId, utcDay(Date.now()))).toBe(true);
    db.close();
  });

  it("rebels and sleeps the player on a second siesta the same day", async () => {
    const { run, runtime, discipline, sendText, msg, db } = setup("5");
    await run(); // first: bot nap
    runtime.cancelSiesta();
    await run(); // second: rebel
    expect(runtime.isSleeping()).toBe(false);
    const until = discipline.sleepUntil(msg.chatId, msg.senderId);
    expect(until).not.toBeNull();
    expect(reply(sendText).toLowerCase()).toContain("sleep");
    db.close();
  });

  it("sleeps an armed player on their first siesta and clears the armed flag", async () => {
    const { run, runtime, discipline, msg, db } = setup("8");
    discipline.arm(msg.chatId, msg.senderId);
    await run();
    expect(runtime.isSleeping()).toBe(false);
    expect(discipline.isArmed(msg.chatId, msg.senderId)).toBe(false);
    expect(discipline.sleepUntil(msg.chatId, msg.senderId)).not.toBeNull();
    db.close();
  });

  it("matches a LID group participant against the phone-JID they were armed by", async () => {
    // In groups the sender arrives as an opaque LID, but the dashboard arms by the
    // phone JID resolved from contacts. Both must collapse to the same identity.
    const { run, runtime, discipline, db } = setup("5", {
      senderId: "209348576012345@lid",
      senderPhone: "34634439261",
    });
    discipline.arm("g@g.us", "34634439261@s.whatsapp.net");
    await run();
    expect(runtime.isSleeping()).toBe(false);
    expect(discipline.sleepUntil("g@g.us", "34634439261@s.whatsapp.net")).not.toBeNull();
    db.close();
  });

  it("does not penalise or consume the allowance on an invalid duration", async () => {
    const { run, runtime, discipline, msg, db } = setup("nope");
    await run();
    expect(runtime.isSleeping()).toBe(false);
    expect(discipline.usedToday(msg.chatId, msg.senderId, utcDay(Date.now()))).toBe(false);
    expect(discipline.sleepUntil(msg.chatId, msg.senderId)).toBeNull();
    db.close();
  });

  it("tracks the daily allowance separately per chat", async () => {
    const { run, discipline, msg, db } = setup("10");
    await run();
    expect(discipline.usedToday(msg.chatId, msg.senderId, utcDay(Date.now()))).toBe(true);
    expect(discipline.usedToday("other@g.us", msg.senderId, utcDay(Date.now()))).toBe(false);
    db.close();
  });
});
