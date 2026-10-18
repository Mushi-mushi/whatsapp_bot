import { describe, it, expect, vi } from "vitest";
import { makeSiesta } from "../src/handlers/commands/siesta.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { RuntimeState } from "../src/state/runtime.js";
import { openDatabase } from "../src/state/db.js";
import { SiestaDisciplineStore, utcDay } from "../src/state/repos.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

function setup(args: string, msgOverrides: Partial<IncomingMessage> = {}) {
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
    getConfig: () => DEFAULT_CONFIG,
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  return { run: () => makeSiesta(runtime, discipline)(ctx), runtime, discipline, sendText, msg, db };
}

const reply = (sendText: ReturnType<typeof vi.fn>) => sendText.mock.calls.at(-1)?.[1] as string;

describe("bot.siesta discipline", () => {
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
