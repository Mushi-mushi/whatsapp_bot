import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { Context } from "../src/router/context.js";
import { makeMute } from "../src/handlers/commands/mute.js";
import { muteGuard } from "../src/middleware/index.js";
import { openDatabase } from "../src/state/db.js";
import { InteractionStore } from "../src/state/interactions.js";
import { AchievementStore } from "../src/state/achievements.js";
import { ContactsStore, SeenActivityStore } from "../src/state/repos.js";
import type { IncomingMessage, Transport } from "../src/transport/types.js";

const CHAT = "group@g.us";
const ALICE = "34600000001@s.whatsapp.net";
const BOB = "34600000002@s.whatsapp.net";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const db = openDatabase(":memory:");
  databases.push(db);
  const interactions = new InteractionStore(db);
  const people = new SeenActivityStore(db);
  people.record(CHAT, ALICE, "Alice Smith", NOW, "Group");
  const transport = {
    sendText: vi.fn<Transport["sendText"]>().mockResolvedValue(undefined),
    deleteMessage: vi.fn<Transport["deleteMessage"]>().mockResolvedValue(undefined),
    isBotGroupAdmin: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn(() => ({ me: "34600000003:1@s.whatsapp.net" })),
  };
  function context(args = "Alice Smith 2", overrides: Partial<IncomingMessage> = {}) {
    const ctx = new Context({
      chatId: CHAT, chatName: "Group", senderId: BOB, senderName: "Bob",
      senderPhone: "34600000002", messageId: "m1", fromMe: false, isGroup: true,
      text: `bot.mute ${args}`, kind: "text", timestamp: NOW, raw: { key: {} }, ...overrides,
    }, { transport: transport as Transport, getConfig: () => DEFAULT_CONFIG });
    ctx.args = args;
    ctx.commandTrigger = "bot.mute";
    return ctx;
  }
  const handler = makeMute(interactions, people);
  return { db, interactions, people, handler, context, transport };
}

describe("debt-powered mutes", () => {
  it("awards remute secrets only after accepted mutes, not rejected requests or active extensions", async () => {
    const { db, interactions, people, context, transport } = setup();
    const achievements = new AchievementStore(db, () => ({
      ...DEFAULT_CONFIG, approvedSenders: [CHAT], achievementChats: [CHAT],
    }));
    const handler = makeMute(interactions, people, achievements);
    interactions.addDebt(ALICE, 300);
    await handler(context("Alice Smith 1"));
    await handler(context("Alice Smith 1")); // Active extension.
    expect(transport.sendText.mock.calls.flat().join("\n")).not.toContain("I Regret Nothing");
    vi.setSystemTime(NOW + 120_000);
    transport.isBotGroupAdmin.mockResolvedValueOnce(false);
    await handler(context("Alice Smith 1"));
    expect(transport.sendText.mock.calls.flat().join("\n")).not.toContain("I Regret Nothing");
    await handler(context("Alice Smith 1"));
    expect(transport.sendText.mock.calls.flat().join("\n")).toContain("I Regret Nothing");
  });

  it("debits EUR 1 per minute, charges the caller EUR 0.20/minute and extends existing mutes", async () => {
    const { interactions, handler, context, transport } = setup();
    interactions.increment(ALICE, null, 370);
    await handler(context());
    expect(interactions.debt(ALICE)).toBe(170);
    expect(interactions.debt(BOB)).toBe(40);
    expect(interactions.total(ALICE)).toBe(1);
    expect(interactions.total(BOB)).toBe(1);
    expect(interactions.muteUntil(CHAT, ALICE)).toBe(NOW + 120_000);
    vi.advanceTimersByTime(30_000);
    await handler(context("Alice Smith 1"));
    expect(interactions.muteUntil(CHAT, ALICE)).toBe(NOW + 180_000);
    expect(interactions.debt(ALICE)).toBe(70);
    expect(interactions.debt(BOB)).toBe(60);
    await handler(context("Alice Smith 1"));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("only 0 whole minute");
    expect(interactions.debt(BOB)).toBe(60);
    expect(interactions.muteUntil("other@g.us", ALICE)).toBe(0);
  });

  it.each(["Alice Smith 0", "Alice Smith -1", "Alice Smith 1.5", "Alice Smith 2junk", "Alice Smith", "Alice Smith 999999999999999"])(
    "rejects invalid duration without charging: %s", async (args) => {
      const { interactions, handler, context, transport } = setup();
      interactions.increment(ALICE, null, 500);
      await handler(context(args));
      expect(transport.sendText.mock.calls[0][1]).toContain("Usage:");
      expect(interactions.debt(BOB)).toBe(0);
      expect(interactions.debt(ALICE)).toBe(500);
    });

  it("rejects DMs, missing/ambiguous targets, self-mutes and the linked account without charging", async () => {
    const { interactions, handler, context, people, transport } = setup();
    await handler(context("Alice Smith 1", { isGroup: false }));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("approved groups");
    await handler(context("Nobody 1"));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("haven't seen");
    people.record(CHAT, "34600000004@s.whatsapp.net", "Alice Smith", NOW, "Group");
    await handler(context("Alice Smith 1"));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("won't guess");
    await handler(context("Bob 1"));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("cannot mute yourself");
    people.record(CHAT, "34600000003@s.whatsapp.net", "Owner", NOW, "Group");
    await handler(context("Owner 1"));
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("linked account cannot be muted");
    expect(interactions.debt(BOB)).toBe(0);
  });

  it("requires verified bot-admin permissions, not caller-admin permissions", async () => {
    const { interactions, handler, context, transport } = setup();
    interactions.increment(ALICE, null, 500);
    transport.isBotGroupAdmin.mockResolvedValueOnce(false);
    await handler(context());
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("Make me a group admin");
    transport.isBotGroupAdmin.mockRejectedValueOnce(new Error("Disconnected"));
    await handler(context());
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("couldn't verify");
    expect(interactions.debt(BOB)).toBe(0);
    expect(interactions.debt(ALICE)).toBe(500);
    await handler(context());
    expect(interactions.debt(BOB)).toBe(40);
  });

  it("uses global debt and verified identities but scopes mute enforcement to the requesting group", async () => {
    const { db, interactions, handler, context, transport } = setup();
    interactions.increment("900@lid", null, 100);
    interactions.increment(ALICE, null, 170);
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "Alice Smith" }]);
    await handler(context());
    expect(interactions.debt("900@lid")).toBe(70);
    expect(interactions.debt(ALICE)).toBe(70);
    expect(interactions.total("900@lid")).toBe(2);
    const next = vi.fn();
    const guard = muteGuard(interactions, pino({ level: "silent" }));
    for (const kind of ["text", "image", "audio", "video", "sticker", "other"] as const) {
      await guard(context("", { senderId: "900@lid", senderPhone: "", kind }), next);
    }
    expect(next).not.toHaveBeenCalled();
    expect(transport.deleteMessage).toHaveBeenCalledTimes(6);
    expect(interactions.debt(ALICE)).toBe(670);
    expect(interactions.total(ALICE)).toBe(2);
    expect(transport.sendText).toHaveBeenCalledTimes(1);
    await guard(context("", { senderId: ALICE, senderPhone: "", chatId: "other@g.us" }), next);
    expect(next).toHaveBeenCalledOnce();
    vi.setSystemTime(NOW + 120_000);
    await guard(context("", { senderId: ALICE, senderPhone: "" }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("logs and reports deletion failures without dispatching the muted command", async () => {
    const { interactions, handler, context, transport } = setup();
    interactions.increment(ALICE, null, 200);
    await handler(context());
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const next = vi.fn();
    transport.deleteMessage.mockRejectedValueOnce(new Error("No permissions"));
    await muteGuard(interactions, logger)(context("", { senderId: ALICE, senderPhone: "" }), next);
    expect(warn).toHaveBeenCalledOnce();
    expect(transport.sendText.mock.calls.at(-1)?.[1]).toContain("couldn't delete");
    expect(next).not.toHaveBeenCalled();
    expect(interactions.debt(ALICE)).toBe(0);
  });

  it("reserves debt atomically across different groups and rolls back both balances if mute persistence fails", () => {
    const { db, interactions } = setup();
    interactions.increment(ALICE, null, 200);
    expect(interactions.mute(CHAT, BOB, ALICE, 2, NOW).ok).toBe(true);
    expect(interactions.mute("other@g.us", BOB, ALICE, 1, NOW)).toEqual({ ok: false, allowance: 0 });
    expect(interactions.debt(BOB)).toBe(40);
    interactions.increment(ALICE, null, 100);
    db.exec("CREATE TRIGGER reject_mute BEFORE INSERT ON user_mutes BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => interactions.mute("other@g.us", BOB, ALICE, 1, NOW)).toThrow("write failed");
    expect(interactions.debt(ALICE)).toBe(100);
    expect(interactions.debt(BOB)).toBe(40);
    expect(interactions.muteUntil("other@g.us", ALICE)).toBe(0);
  });
});
