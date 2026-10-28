import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AchievementStore, ACHIEVEMENTS } from "../src/state/achievements.js";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { ConfigStore, ContactsStore, DuelWinStore, SeenStore, TriviaScoreStore } from "../src/state/repos.js";
import { achievementObserver, approvedSenderGuard, dedupe, ignoreOwn, siestaGuard } from "../src/middleware/index.js";
import { Bot } from "../src/router/router.js";
import { Context } from "../src/router/context.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { registerConfiguredCommands, type CommandRegistry } from "../src/router/commands.js";
import { makeAchievements } from "../src/handlers/commands/achievements.js";
import { handleTriviaAnswer, type TriviaAnswerCtx } from "../src/handlers/commands/trivia.js";
import { InteractionStore } from "../src/state/interactions.js";
import { OutboxStore } from "../src/state/outbox.js";
import { RuntimeState } from "../src/state/runtime.js";
import type { IncomingMessage, Transport } from "../src/transport/types.js";

const CHAT = "group@g.us";
const OTHER = "other@g.us";
const PN = "34600000001@s.whatsapp.net";
const LID = "900@lid";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  let config: BotConfig = { ...DEFAULT_CONFIG, approvedSenders: [CHAT, OTHER], achievementChats: [CHAT] };
  const getConfig = () => config;
  const store = new AchievementStore(db, getConfig);
  return { db, store, getConfig, configure: (patch: Partial<BotConfig>) => { config = { ...config, ...patch }; } };
}

describe("per-chat achievements", () => {
  it("atomically queues an announcement only for newly enabled chats, including re-enables", () => {
    const { db } = setup();
    const configs = new ConfigStore(db);
    const original = configs.load();
    const enabled = { ...original, approvedSenders: [CHAT, OTHER], achievementChats: [CHAT] };
    configs.save(enabled);
    const outbox = new OutboxStore(db);
    const first = outbox.claim(Date.now())!;
    expect(first.chat_id).toBe(CHAT);
    expect(first.body).toContain("Achievements are now enabled");
    expect(first.body).toContain("bot.achievements");
    outbox.sent(first);
    configs.save({ ...enabled, botReplyPrefix: "Changed" });
    expect(outbox.claim(Date.now())).toBeUndefined();
    configs.save({ ...enabled, achievementChats: [CHAT, OTHER] });
    const second = outbox.claim(Date.now())!;
    expect(second.chat_id).toBe(OTHER);
    outbox.sent(second);
    configs.save({ ...enabled, achievementChats: [] });
    expect(outbox.claim(Date.now())).toBeUndefined();
    configs.save(enabled);
    expect(outbox.claim(Date.now())?.chat_id).toBe(CHAT);
    expect(() => configs.save({ ...enabled, approvedSenders: [] })).toThrow();
    expect(configs.load()).toEqual(enabled);
  });

  it("does not re-announce a verified alias change and rolls back enabling if queuing fails", () => {
    const { db } = setup();
    new ContactsStore(db).upsertMany([{ jid: LID, phone: "34600000001", name: "Alice" }]);
    const configs = new ConfigStore(db);
    const enabled = { ...configs.load(), approvedSenders: [LID, PN, CHAT], achievementChats: [LID] };
    configs.save(enabled);
    const outbox = new OutboxStore(db);
    const first = outbox.claim(Date.now())!;
    expect(first.chat_id).toBe(PN);
    outbox.sent(first);
    configs.save({ ...enabled, achievementChats: [PN] });
    expect(outbox.claim(Date.now())).toBeUndefined();
    db.exec("CREATE TRIGGER reject_announcement BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
    expect(() => configs.save({ ...enabled, achievementChats: [PN, CHAT] })).toThrow("queue unavailable");
    expect(configs.load().achievementChats).toEqual([PN]);
  });

  it("defaults off and validates that enabled chats are approved identities", () => {
    expect(ConfigSchema.parse({}).achievementChats).toEqual([]);
    expect(ConfigSchema.safeParse({ achievementChats: [CHAT] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ approvedSenders: ["Friends"], achievementChats: ["Friends"] }).success).toBe(false);
    expect(ConfigSchema.parse({ approvedSenders: [CHAT], achievementChats: [CHAT] }).achievementChats).toEqual([CHAT]);
  });

  it("starts from zero, isolates chats and people, and pauses without resetting on disable or revocation", () => {
    const { db, store, configure } = setup();
    new InteractionStore(db).increment(PN);
    new TriviaScoreStore(db).add(CHAT, PN, "Alice", 50);
    expect(store.progress(CHAT, PN).counts).toEqual({
      messages: 0, commands: 0, trivia: 0, duels: 0, quietDays: 0, consecutive: 0,
      muteMinutes: 0, muteCount: 0, billCents: 0,
    });
    expect(store.record(CHAT, PN, "Alice", ["messages"])).toBeNull();
    expect(store.record(CHAT, PN, "Alice", ["messages"])).toBeNull();
    expect(store.record(OTHER, PN, "Alice", ["messages"])).toBeNull();
    expect(store.progress(CHAT, "901@lid").counts.messages).toBe(0);
    expect(store.progress(OTHER, PN).counts.messages).toBe(0);
    configure({ achievementChats: [] });
    expect(store.record(CHAT, PN, "Alice", ["messages"])).toBeNull();
    configure({ achievementChats: [CHAT], approvedSenders: [] });
    expect(store.record(CHAT, PN, "Alice", ["messages"])).toBeNull();
    configure({ approvedSenders: [CHAT, OTHER], achievementChats: [CHAT, OTHER] });
    expect(store.record(CHAT, PN, "Renamed", ["messages"])).toBeNull();
    expect(store.progress(CHAT, PN).counts.messages).toBe(3);
    expect(store.record(OTHER, PN, "Alice", ["messages"])).toBeNull();
  });

  it.each(ACHIEVEMENTS.filter((badge) => badge.metric !== "quietDays" && badge.metric !== "consecutive"))("queues $id at exactly $target and never queues it again", (badge) => {
    const { db, store } = setup();
    const outbox = new OutboxStore(db);
    for (let count = 1; count < badge.target; count++) {
      expect(store.record(CHAT, PN, "Alice", [badge.metric], count) ?? "").not.toContain(`${badge.name} -`);
    }
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === badge.id)).toBe(false);
    expect(store.record(CHAT, PN, "Alice", [badge.metric], badge.target)).toBeNull();
    const captions: string[] = [];
    let delivery = outbox.claim(Date.now());
    while (delivery) {
      if (delivery.achievement_badge_id === badge.id) captions.push(delivery.body);
      outbox.sent(delivery);
      delivery = outbox.claim(Date.now());
    }
    expect(captions[0]).toContain(badge.name);
    expect(store.progress(CHAT, PN).unlocked.find((row) => row.badge_id === badge.id)?.unlocked_at).toBe(badge.target);
    expect(store.record(CHAT, PN, "Alice", [badge.metric], badge.target + 1)).toBeNull();
  });

  it("consolidates verified PN/LID progress and badges without using display names", () => {
    const { db, store } = setup();
    store.record(CHAT, PN, "Alex", ["messages"]);
    store.record(CHAT, LID, "Alex", ["messages"]);
    store.record(CHAT, "901@lid", "Alex", ["messages"]);
    new ContactsStore(db).upsertMany([{ jid: LID, phone: "34600000001", name: "Alex" }]);
    expect(store.record(CHAT, LID, "New name", ["messages"])).toBeNull();
    for (const sender of [PN, LID, "34600000001:2@s.whatsapp.net"]) {
      expect(store.progress(CHAT, sender).counts.messages).toBe(3);
      expect(store.progress(CHAT, sender).unlocked).toHaveLength(1);
    }
    expect(store.progress(CHAT, "901@lid").counts.messages).toBe(1);
  });

  it("recognizes approved DM phone/LID aliases but never enables an unapproved chat", () => {
    const { db, store, configure } = setup();
    new ContactsStore(db).upsertMany([{ jid: LID, phone: "34600000001", name: "Alice" }]);
    configure({ approvedSenders: ["+34 600 000 001"], achievementChats: ["+34 600 000 001"] });
    expect(store.enabled(LID)).toBe(true);
    expect(store.enabled(PN)).toBe(true);
    expect(store.enabled(CHAT)).toBe(false);
    configure({ approvedSenders: [] });
    expect(store.enabled(LID)).toBe(false);
  });

  it("migrates schema 13 additively and persists configuration, progress and badges across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-achievements-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    try {
      db.exec("DROP TABLE achievement_progress; DROP TABLE achievement_unlocks; INSERT INTO kv VALUES ('keep','value'); PRAGMA user_version=13;");
      db.close();
      db = openDatabase(path);
      const configs = new ConfigStore(db);
      configs.save({ ...configs.load(), approvedSenders: [CHAT], achievementChats: [CHAT] });
      new AchievementStore(db, () => configs.load()).record(CHAT, PN, "Alice", ["trivia"], 1234);
      db.close();
      db = openDatabase(path);
      const reloaded = new ConfigStore(db);
      const store = new AchievementStore(db, () => reloaded.load());
      expect(store.enabled(CHAT)).toBe(true);
      expect(store.progress(CHAT, PN)).toMatchObject({
        counts: { trivia: 1 }, unlocked: [{ badge_id: "trivia-1", unlocked_at: 1234 }],
      });
      expect(store.record(CHAT, PN, "Alice", ["trivia"])).toBeNull();
      expect(db.prepare("SELECT value FROM kv WHERE key='keep'").get()).toEqual({ value: "value" });
      expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});

describe("quiet returns and consecutive messages", () => {
  const DAY = 86_400_000;

  it.each([1, 7, 30])("awards a quiet return at exactly %i days, not one millisecond earlier", (days) => {
    const { store } = setup();
    const first = 1000;
    store.record(CHAT, PN, "Alice", ["messages"], first);
    store.record(CHAT, LID, "Bob", ["messages"], first);
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(0);
    store.record(CHAT, LID, "Bob", ["messages"], first + days * DAY - 1);
    expect(store.progress(CHAT, LID).unlocked.some((row) => row.badge_id === `quiet-${days}`)).toBe(false);
    expect(store.record(CHAT, PN, "Alice", ["messages"], first + days * DAY)).toBeNull();
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(days);
    expect(store.record(CHAT, PN, "Alice", ["messages"], first + days * DAY + 1)).toBeNull();
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(days);
  });

  it("does not grant silence on the first message or let commands/game results change the baseline", () => {
    const { store } = setup();
    store.record(CHAT, PN, "Alice", ["messages"], 30 * DAY);
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(0);
    store.record(CHAT, PN, "Alice", ["commands", "trivia"], 31 * DAY - 1);
    expect(store.record(CHAT, PN, "Alice", ["messages"], 31 * DAY)).toBeNull();
  });

  it("includes disabled time since the last tracked message, without tracking messages while disabled", () => {
    const { store, configure } = setup();
    store.record(CHAT, PN, "Alice", ["messages"], 0);
    configure({ achievementChats: [] });
    expect(store.record(CHAT, PN, "Alice", ["messages"], 6 * DAY)).toBeNull();
    configure({ achievementChats: [CHAT] });
    expect(store.record(CHAT, PN, "Alice", ["messages"], 7 * DAY)).toBeNull();
    expect(store.progress(CHAT, PN).counts).toMatchObject({ messages: 2, quietDays: 7, consecutive: 2 });
  });

  it.each([5, 10, 25])("awards a consecutive streak at exactly %i messages and keeps the best after interruption", (target) => {
    const { store } = setup();
    for (let count = 1; count < target; count++) store.record(CHAT, PN, "Alice", ["messages"], count);
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === `consecutive-${target}`)).toBe(false);
    const badge = ACHIEVEMENTS.find((entry) => entry.id === `consecutive-${target}`)!;
    expect(store.record(CHAT, PN, "Alice", ["messages"], target)).toBeNull();
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(target);
    store.record(CHAT, LID, "Bob", ["messages"], target + 1);
    expect(store.record(CHAT, PN, "Alice", ["messages"], target + 2)).toBeNull();
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(target);
    for (let count = 2; count <= target + 1; count++) {
      expect(store.record(CHAT, PN, "Alice", ["messages"], target + count + 1) ?? "").not.toContain(badge.name);
    }
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(target + 1);
  });

  it("isolates streaks by chat and resets them for a different person with the same name", () => {
    const { store, configure } = setup();
    configure({ achievementChats: [CHAT, OTHER] });
    for (let count = 0; count < 4; count++) store.record(CHAT, PN, "Alex", ["messages"], count);
    store.record(OTHER, PN, "Alex", ["messages"], 4);
    store.record(CHAT, LID, "Alex", ["messages"], 5);
    expect(store.record(CHAT, PN, "Alex", ["messages"], 6)).toBeNull();
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(4);
    expect(store.progress(OTHER, PN).counts.consecutive).toBe(1);
  });

  it("resolves verified aliases for silence baselines, streak ownership and best metrics without summing records", () => {
    const { db, store } = setup();
    for (let count = 0; count < 3; count++) store.record(CHAT, LID, "Alice", ["messages"], count);
    store.record(CHAT, PN, "Alice", ["messages"], 3);
    new ContactsStore(db).upsertMany([{ jid: LID, phone: "34600000001", name: "Alice" }]);
    store.record(CHAT, LID, "Alice", ["messages"], 4);
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(3);
    expect(store.record(CHAT, PN, "Alice", ["messages"], 7 * DAY + 3)).toBeNull();
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(6);
    expect(store.record(CHAT, LID, "Alice", ["messages"], 14 * DAY + 3)).toBeNull();
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(7);
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(4);
    expect(store.progress(CHAT, LID)).toEqual(store.progress(CHAT, PN));
  });

  it("preserves the latest baseline when the server clock moves backwards", () => {
    const { store } = setup();
    store.record(CHAT, PN, "Alice", ["messages"], 1000);
    store.record(CHAT, PN, "Alice", ["messages"], 500);
    expect(store.record(CHAT, PN, "Alice", ["messages"], DAY + 500)).toBeNull();
    expect(store.progress(CHAT, PN).counts.quietDays).toBe(0);
  });

  it("migrates schema 14 without losing badges, then persists silence baselines and streaks across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-achievement-activity-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    const config = { ...DEFAULT_CONFIG, approvedSenders: [CHAT], achievementChats: [CHAT] };
    try {
      let store = new AchievementStore(db, () => config);
      store.record(CHAT, PN, "Alice", ["commands"]);
      db.exec("DROP TABLE achievement_activity; DROP TABLE achievement_streaks; PRAGMA user_version=14;");
      db.close();
      db = openDatabase(path);
      store = new AchievementStore(db, () => config);
      expect(store.progress(CHAT, PN).unlocked).toHaveLength(1);
      for (let count = 0; count < 4; count++) store.record(CHAT, PN, "Alice", ["messages"], count);
      db.close();
      db = openDatabase(path);
      store = new AchievementStore(db, () => config);
      expect(store.record(CHAT, PN, "Alice", ["messages"], DAY + 3)).toBeNull();
      expect(store.progress(CHAT, PN).counts).toMatchObject({ commands: 1, messages: 5, quietDays: 1, consecutive: 5 });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});

function routed() {
  const state = setup();
  const runtime = new RuntimeState();
  const bot = new Bot();
  const jobs = new BackgroundJobs(() => {});
  cleanup.push(async () => { await bot.stop(); await jobs.stop(); runtime.dispose(); });
  const sendText = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
  const transport = { sendText } as Transport;
  const interactions = new InteractionStore(state.db);
  const handler = vi.fn().mockResolvedValue(undefined);
  const registry = { roll: handler, achievements: makeAchievements(state.store) } as CommandRegistry;
  bot.use(approvedSenderGuard).use(dedupe(new SeenStore(state.db)))
    .use(siestaGuard(runtime)).use(achievementObserver(state.store, interactions)).use(ignoreOwn(runtime));
  registerConfiguredCommands(bot, { "bot.dice": "roll", "bot.badges": "achievements" },
    registry, jobs, vi.fn(), interactions, state.store);
  let id = 0;
  const message = (text: string, patch: Partial<IncomingMessage> = {}) => bot.handle(new Context({
    chatId: CHAT, chatName: "Friends", senderId: PN, senderName: "Alice", senderPhone: "34600000001",
    messageId: String(++id), fromMe: false, isGroup: true, text, kind: "text",
    timestamp: Date.now(), raw: { key: {} }, ...patch,
  }, { transport, getConfig: state.getConfig }));
  return { ...state, message, sendText, interactions, handler, runtime };
}

describe("achievement routing", () => {
  it.each([true, false])("counts the linked owner's unprefixed chatter even when own commands are enabled=%s", async (respondToOwnCommands) => {
    const { store, message, sendText, configure, handler } = routed();
    const prefix = "Root bot:";
    configure({ botReplyPrefix: prefix, respondToOwnCommands });
    const owner = { fromMe: true, senderId: "34600000002@s.whatsapp.net", senderPhone: "34600000002", senderName: "Owner" };
    for (let count = 0; count < 4; count++) await message("Si Ying speaking");
    await message(`  ${prefix}\nGenerated reply`, owner);
    await message("", { ...owner, kind: "image", isBot: true });
    expect(store.progress(CHAT, owner.senderId).counts.messages).toBe(0);
    await message("lol", { ...owner, messageId: "owner-lol" });
    await message("lol", { ...owner, messageId: "owner-lol" });
    expect(store.progress(CHAT, owner.senderId).counts).toMatchObject({ messages: 1, consecutive: 1 });
    await message("Si Ying speaking again");
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(4);
    expect(sendText.mock.calls.flat().join("\n")).not.toContain("Monologue");
    expect(handler).not.toHaveBeenCalled();
    for (let count = 0; count < 3; count++) await message("Still speaking");
    await message("", { ...owner, kind: "sticker" });
    await message("Not alone");
    expect(store.progress(CHAT, PN).counts).toMatchObject({ messages: 9, consecutive: 4 });
    expect(store.progress(CHAT, owner.senderId).counts.messages).toBe(2);
    expect(sendText.mock.calls.flat().join("\n")).not.toContain("Is anyone there?");
  });

  it("does not interrupt a genuine human streak for bot-prefixed replies from the owner's account", async () => {
    const { store, message, configure, sendText } = routed();
    configure({ botReplyPrefix: "Custom Bot:" });
    for (let count = 0; count < 5; count++) {
      await message("Human message");
      await message("Custom Bot:\nAutomated response", {
        fromMe: true, senderId: "34600000002@s.whatsapp.net", senderPhone: "34600000002",
      });
    }
    expect(store.progress(CHAT, PN).counts).toMatchObject({ messages: 5, consecutive: 5 });
    expect(store.progress(CHAT, "34600000002@s.whatsapp.net").counts.messages).toBe(0);
    expect(sendText.mock.calls.flat().join("\n")).not.toContain("Monologue");
  });

  it("observes unmute expiry on a real message and counts command days through configured aliases", async () => {
    vi.useFakeTimers();
    try {
      const { message, interactions, sendText } = routed();
      const now = Date.parse("2026-10-27T12:00:00Z");
      vi.setSystemTime(now);
      interactions.addDebt(PN, 100);
      interactions.mute(CHAT, "34600000002@s.whatsapp.net", PN, 1, now);
      vi.setSystemTime(now + 60_000);
      await message("I'm back");
      expect(sendText.mock.calls.flat().join("\n")).not.toContain("Unmute Any% Speedrun");
      for (let day = 0; day < 6; day++) {
        vi.setSystemTime(now + day * 86_400_000 + 60_000);
        await message("bot.dice");
      }
      expect(sendText.mock.calls.flat().join("\n")).not.toContain("Repeat Customer");
      vi.setSystemTime(now + 6 * 86_400_000 + 60_000);
      await message("bot.dice");
      expect(sendText.mock.calls.flat().join("\n")).not.toContain("Repeat Customer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts commands and media in a streak while ignoring bot replies and duplicates", async () => {
    const { store, message, sendText } = routed();
    await message("Hello", { messageId: "first" });
    await message("Hello", { messageId: "first" });
    await message("bot.dice");
    await message("", { kind: "image" });
    await message("A bot reply", { isBot: true });
    await message("", { kind: "audio" });
    await message("", { kind: "sticker" });
    expect(store.progress(CHAT, PN).counts).toMatchObject({ messages: 5, consecutive: 5, commands: 1 });
    expect(sendText.mock.calls.flatMap((call) => call[1]).join("\n")).not.toContain("Monologue");
    await message("Hi", { senderId: LID, senderPhone: "", senderName: "Bob" });
    await message("Back");
    expect(store.progress(CHAT, PN).counts.consecutive).toBe(5);
  });

  it("counts messages and configured command aliases once and keeps achievement lookups free", async () => {
    const { store, message, sendText, interactions, handler } = routed();
    await message("bot.dice", { messageId: "duplicate" });
    await message("bot.dice", { messageId: "duplicate" });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.progress(CHAT, PN).counts).toMatchObject({ messages: 1, commands: 1 });
    expect(sendText.mock.calls.flatMap((call) => call[1]).join("\n")).not.toContain("Button pusher");
    await message("bot.badges");
    expect(sendText.mock.calls.at(-1)?.[1]).toContain("First words");
    expect(sendText.mock.calls.at(-1)?.[1]).toContain("[Locked] Chatterbox - 2/100");
    expect(interactions.total(PN)).toBe(1);
    expect(store.progress(CHAT, PN).counts.commands).toBe(1);
    await message("bot.unknown");
    expect(store.progress(CHAT, PN).counts.commands).toBe(1);
  });

  it("ignores unapproved, duplicate, bot, protocol and siesta-blocked messages and does not announce while disabled", async () => {
    const { store, message, sendText, runtime, configure } = routed();
    await message("Hello", { chatId: "unapproved@g.us" });
    await message("Hello", { isBot: true });
    await message("Hello", { kind: "other" });
    await message("Hello", { raw: { key: {}, message: { protocolMessage: {} } } });
    runtime.siestaUntil = Date.now() + 60_000;
    await message("Hello");
    runtime.cancelSiesta();
    expect(store.progress(CHAT, PN).counts.messages).toBe(0);
    configure({ achievementChats: [] });
    await message("Hello");
    expect(sendText).not.toHaveBeenCalled();
    await message("bot.badges");
    expect(sendText.mock.calls.at(-1)?.[1]).toContain("disabled in this chat");
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
  });

  it("does not send duplicate text or lose the persisted badge", async () => {
    const { db, store, message, sendText } = routed();
    sendText.mockRejectedValueOnce(new Error("disconnected"));
    await message("Hello");
    expect(sendText).not.toHaveBeenCalled();
    expect(store.progress(CHAT, PN).unlocked).toHaveLength(1);
    expect(new OutboxStore(db).claim(Date.now())?.achievement_badge_id).toBe("messages-1");
  });
});

function trivia() {
  const state = setup();
  const runtime = new RuntimeState();
  cleanup.push(() => runtime.dispose());
  const reply = vi.fn().mockResolvedValue(undefined);
  const answer: TriviaAnswerCtx = {
    runtime, scores: new TriviaScoreStore(state.db), duelScores: new DuelWinStore(state.db),
    achievements: state.store, chatId: CHAT, senderId: PN, senderName: "Alice",
    text: "Paris", sentAt: Date.now(), cfg: state.getConfig(), reply,
  };
  runtime.triviaGames.set(CHAT, {
    question: "Capital?", options: ["Paris", "London"], correct: "Paris",
    askedAt: Date.now(), language: "en", mode: "classic", answered: new Set(),
  });
  return { ...state, runtime, answer, reply };
}

describe("trivia achievement integration", () => {
  it("counts correct classic answers once, without counting wrong or stale answers", async () => {
    const { store, answer, reply } = trivia();
    await handleTriviaAnswer({ ...answer, sentAt: answer.sentAt - 10_000 });
    await handleTriviaAnswer({ ...answer, text: "London" });
    expect(store.progress(CHAT, PN).counts.trivia).toBe(0);
    await handleTriviaAnswer(answer);
    await handleTriviaAnswer(answer);
    expect(store.progress(CHAT, PN).counts.trivia).toBe(1);
    expect(reply.mock.calls.flatMap((call) => call[0]).join("\n")).not.toContain("Bright spark");
  });

  it("counts duel correct answers and the winner once without appending badges to the winning reply", async () => {
    const { store, runtime, answer, reply } = trivia();
    runtime.triviaGames.get(CHAT)!.mode = "duel";
    runtime.triviaDuels.set(CHAT, {
      target: 5, phase: "running", hostName: "Alice", players: new Map([[PN, { name: "Alice", score: 4 }]]),
      session: { token: null, queue: [], language: "en" }, language: "en", countdownTimers: [],
    });
    await handleTriviaAnswer({ ...answer, senderId: "901@lid" });
    expect(store.progress(CHAT, "901@lid").counts.trivia).toBe(0);
    await handleTriviaAnswer(answer);
    await handleTriviaAnswer(answer);
    expect(store.progress(CHAT, PN).counts).toMatchObject({ trivia: 1, duels: 1 });
    expect(reply.mock.calls[0][0]).not.toContain("Bright spark");
    expect(reply.mock.calls[0][0]).not.toContain("First victory");
    expect(runtime.triviaDuels.size).toBe(0);
  });

  it("does not backfill trivia results from a disabled period", async () => {
    const { store, configure, answer } = trivia();
    configure({ achievementChats: [] });
    await handleTriviaAnswer(answer);
    configure({ achievementChats: [CHAT] });
    expect(store.progress(CHAT, PN).counts.trivia).toBe(0);
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
  });
});
