import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AchievementStore, SECRET_ACHIEVEMENTS } from "../src/state/achievements.js";
import { openDatabase } from "../src/state/db.js";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { ContactsStore, DuelWinStore, SiestaDisciplineStore, TriviaScoreStore } from "../src/state/repos.js";
import { InteractionStore } from "../src/state/interactions.js";
import { OutboxStore } from "../src/state/outbox.js";
import { RuntimeState } from "../src/state/runtime.js";
import { handleTriviaAnswer, type TriviaAnswerCtx } from "../src/handlers/commands/trivia.js";
import { makeSiesta } from "../src/handlers/commands/siesta.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import { Context } from "../src/router/context.js";
import type { Transport } from "../src/transport/types.js";

const CHAT = "group@g.us";
const OTHER = "other@g.us";
const PN = "34600000001@s.whatsapp.net";
const BOB = "34600000002@s.whatsapp.net";
const LID = "900@lid";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});

function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  let config: BotConfig = { ...DEFAULT_CONFIG, approvedSenders: [CHAT, OTHER], achievementChats: [CHAT] };
  const getConfig = () => config;
  const store = new AchievementStore(db, getConfig);
  const interactions = new InteractionStore(db, store);
  return { db, store, interactions, getConfig, configure: (patch: Partial<BotConfig>) => { config = { ...config, ...patch }; } };
}

describe("surprise achievement rules", () => {
  it("hides every new name, requirement and progress until unlocked, without hiding existing badges", () => {
    const { store } = setup();
    const hidden = store.describe(CHAT, PN);
    for (const badge of SECRET_ACHIEVEMENTS) {
      expect(hidden).not.toContain(badge.name);
      expect(hidden).not.toContain(badge.requirement);
    }
    expect(hidden).toContain("[Locked] Chatterbox");
    expect(hidden).toContain("15 secret achievements still hidden");
    store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW + 10_000);
    expect(store.describe(CHAT, PN)).toContain("[Unlocked] Unmute Any% Speedrun");
    expect(store.describe(CHAT, PN)).toContain("14 secret achievements still hidden");
  });

  it("uses inclusive unmute/remute boundaries but excludes active extensions and unknown expiries", () => {
    const { store } = setup();
    expect(store.unmutedMessage(CHAT, PN, "Alice", 0, NOW)).toBeNull();
    expect(store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW - 1)).toBeNull();
    expect(store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW + 10_001)).toBeNull();
    expect(store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW + 10_000)).toContain("Speedrun");
    expect(store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW + 10_000)).toBeNull();
    expect(store.muted(CHAT, PN, "Alice", NOW + 1, NOW)).toBeNull();
    expect(store.muted(CHAT, PN, "Alice", NOW, NOW + 600_001)).toBeNull();
    expect(store.muted(CHAT, PN, "Alice", NOW, NOW + 600_000)).toContain("I Regret Nothing");
  });

  it("counts unique command IDs and calendar days, not aliases or repeated calls", () => {
    const { store } = setup();
    for (let i = 0; i < 30; i++) store.command(CHAT, PN, "Alice", "roll", NOW);
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
    for (let day = 1; day < 6; day++) store.command(CHAT, PN, "Alice", "roll", NOW + day * DAY);
    expect(store.command(CHAT, PN, "Alice", "roll", NOW + 6 * DAY)).toContain("Repeat Customer");
    for (let day = 7; day < 29; day++) store.command(CHAT, PN, "Alice", "roll", NOW + day * DAY);
    expect(store.command(CHAT, PN, "Alice", "roll", NOW + 29 * DAY)).toContain("Loyal Customer");
    for (let i = 1; i < 9; i++) store.command(CHAT, PN, "Alice", `command-${i}`, NOW);
    expect(store.command(CHAT, PN, "Alice", "command-9", NOW)).toContain("Jack of All Bots");
    expect(store.command(CHAT, PN, "Alice", "command-10", NOW)).toBeNull();
  });

  it("uses Paris midnight and excludes 5 a.m., counting a repeated DST hour only once", () => {
    const { store } = setup();
    // Paris is UTC+1 here: 23:30 UTC is already the following calendar day.
    for (let day = 0; day < 4; day++) {
      const time = Date.parse("2026-10-27T23:30:00Z") + day * DAY;
      store.record(CHAT, PN, "Alice", ["messages"], time);
      store.record(CHAT, PN, "Alice", ["messages"], time + 60_000);
    }
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === "night-owl")).toBe(false);
    store.record(CHAT, PN, "Alice", ["messages"], Date.parse("2026-11-01T04:00:00Z"));
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === "night-owl")).toBe(false);
    expect(store.record(CHAT, PN, "Alice", ["messages"], Date.parse("2026-11-01T03:59:59Z"))).toContain("Night Owl");
    store.record(CHAT, BOB, "Bob", ["messages"], Date.parse("2026-10-25T00:30:00Z"));
    store.record(CHAT, BOB, "Bob", ["messages"], Date.parse("2026-10-25T01:30:00Z"));
    const nights = store.describe(CHAT, BOB);
    expect(nights).not.toContain("Night Owl");
  });

  it("counts pet care on seven distinct days and pauses tracking when disabled", () => {
    const { store, configure } = setup();
    for (let i = 0; i < 8; i++) expect(store.care(CHAT, PN, "Alice", NOW)).toBeNull();
    configure({ achievementChats: [] });
    for (let day = 1; day <= 7; day++) expect(store.care(CHAT, PN, "Alice", NOW + day * DAY)).toBeNull();
    configure({ achievementChats: [CHAT] });
    for (let day = 1; day < 6; day++) expect(store.care(CHAT, PN, "Alice", NOW + day * DAY)).toBeNull();
    expect(store.care(CHAT, PN, "Alice", NOW + 6 * DAY)).toContain("Pet's Favourite");
    expect(store.care(OTHER, PN, "Alice", NOW + 6 * DAY)).toBeNull();
  });

  it("merges verified alias days as a union and preserves counters and unlocks across aliases", () => {
    const { db, store } = setup();
    for (let day = 0; day < 3; day++) {
      store.care(CHAT, PN, "Alice", NOW + day * DAY);
      store.care(CHAT, LID, "Alice", NOW + day * DAY);
    }
    new ContactsStore(db).upsertMany([{ jid: LID, phone: "34600000001", name: "Alice" }]);
    for (let day = 3; day < 6; day++) expect(store.care(CHAT, LID, "Alice", NOW + day * DAY)).toBeNull();
    expect(store.care(CHAT, LID, "Alice", NOW + 6 * DAY)).toContain("Pet's Favourite");
    expect(store.care(CHAT, PN, "Renamed", NOW + 7 * DAY)).toBeNull();
    expect(store.describe(CHAT, PN)).toContain("[Unlocked] Pet's Favourite");
  });

  it("resets wrong guesses on a correct answer and checks precise debt and return thresholds", () => {
    const { store } = setup();
    for (let i = 0; i < 4; i++) expect(store.triviaAnswer(CHAT, PN, "Alice", false, 0, NOW)).toBeNull();
    expect(store.triviaAnswer(CHAT, PN, "Alice", true, 4_999, NOW)).toBeNull();
    for (let i = 0; i < 4; i++) expect(store.triviaAnswer(CHAT, PN, "Alice", false, 0, NOW)).toBeNull();
    expect(store.triviaAnswer(CHAT, PN, "Alice", false, 0, NOW)).toContain("The Oracle Is Broken");
    expect(store.triviaAnswer(CHAT, PN, "Alice", true, 5_000, NOW)).toContain("Still Worth It");
    store.record(CHAT, PN, "Alice", ["messages"], NOW);
    store.record(CHAT, PN, "Alice", ["messages"], NOW + 30 * DAY);
    expect(store.triviaAnswer(CHAT, PN, "Alice", true, 0, NOW + 30 * DAY + 600_001)).toBeNull();
    expect(store.triviaAnswer(CHAT, PN, "Alice", true, 0, NOW + 30 * DAY + 600_000)).toContain("The Return of the King");
    expect(store.triviaAnswer(CHAT, BOB, "Bob", true, 0, NOW)).toBeNull();
  });

  it("queues debt-free unlocks for participants only, including dashboard payments and mute deductions", () => {
    const { db, store, interactions } = setup();
    store.record(CHAT, PN, "Alice", ["messages"], NOW);
    const outbox = new OutboxStore(db);
    const firstWords = outbox.claim(Date.now())!;
    expect(firstWords.achievement_badge_id).toBe("messages-1");
    outbox.sent(firstWords);
    interactions.addDebt(PN, 999);
    interactions.removeDebt(PN, 999);
    expect(new OutboxStore(db).claim(Date.now())).toBeUndefined();
    interactions.addDebt(PN, 1_000);
    interactions.removeDebt(PN, 999);
    expect(new OutboxStore(db).claim(Date.now())).toBeUndefined();
    interactions.removeDebt(PN, 1);
    const announcement = outbox.claim(Date.now())!;
    expect(announcement.achievement_badge_id).toBe("debt-free");
    expect(announcement.chat_id).toBe(CHAT);
    expect(announcement.body).toContain("Debt-Free, Briefly");
    expect(announcement.body).toContain("Alice");
    outbox.sent(announcement);
    interactions.addDebt(PN, 1_000);
    interactions.removeDebt(PN, 1_000);
    expect(outbox.claim(Date.now())).toBeUndefined();
    store.record(CHAT, BOB, "Bob", ["messages"], NOW);
    outbox.sent(outbox.claim(Date.now())!);
    interactions.addDebt(BOB, 1_000);
    interactions.mute(CHAT, PN, BOB, 10, NOW);
    expect(outbox.claim(Date.now())?.body).toContain("Debt-Free, Briefly");
    expect(store.progress(OTHER, BOB).unlocked).toEqual([]);
  });

  it("awards photo finish, comeback and tied runners-up only at completed duel results", () => {
    const { store } = setup();
    const players = [{ id: PN, name: "Alice", score: 5, trailed: true },
      { id: BOB, name: "Bob", score: 4 }, { id: LID, name: "Charlie", score: 4 }];
    const notice = store.duelResult(CHAT, players, PN, NOW);
    expect(notice).toContain("Comeback Kid");
    expect(notice).toContain("Photo Finish");
    for (let i = 1; i < 4; i++) expect(store.duelResult(CHAT, players, PN, NOW)).toBeNull();
    const runners = store.duelResult(CHAT, players, PN, NOW)!;
    expect(runners).toContain("So Close...");
    expect(runners).toContain("Bob");
    expect(runners).toContain("Charlie");
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === "runner-up")).toBe(false);
  });

  it("rolls back a payment and its secret unlock if the persistent announcement cannot be queued", () => {
    const { db, store, interactions } = setup();
    store.record(CHAT, PN, "Alice", ["messages"], NOW);
    interactions.addDebt(PN, 1_000);
    db.exec("CREATE TRIGGER reject_secret BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
    expect(() => interactions.removeDebt(PN, 1_000)).toThrow("queue unavailable");
    expect(interactions.debt(PN)).toBe(1_000);
    expect(store.progress(CHAT, PN).unlocked.some((row) => row.badge_id === "debt-free")).toBe(false);
  });

  it("never unlocks any new badge for a disabled or revoked chat", () => {
    const { store, configure } = setup();
    configure({ approvedSenders: [] });
    for (let day = 0; day < 30; day++) {
      const time = NOW + day * DAY;
      store.command(CHAT, PN, "Alice", `command-${day}`, time);
      store.care(CHAT, PN, "Alice", time);
      store.siesta(CHAT, PN, "Alice", time);
      store.triviaAnswer(CHAT, PN, "Alice", false, 5_000, time);
      store.triviaAnswer(CHAT, PN, "Alice", true, 5_000, time);
      store.unmutedMessage(CHAT, PN, "Alice", time, time);
      store.muted(CHAT, PN, "Alice", time, time);
    }
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
    configure({ approvedSenders: [CHAT] });
    expect(store.siesta(CHAT, PN, "Alice", NOW)).toBeNull();
    expect(store.care(CHAT, PN, "Alice", NOW)).toBeNull();
    expect(store.command(CHAT, PN, "Alice", "roll", NOW)).toBeNull();
  });

  it("validates timezone configuration", () => {
    expect(ConfigSchema.parse({}).achievementTimezone).toBe("Europe/Paris");
    expect(ConfigSchema.safeParse({ achievementTimezone: "invalid/timezone" }).success).toBe(false);
  });

  it("persists secret counters and unlocks across database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-secrets-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    const config = { ...DEFAULT_CONFIG, approvedSenders: [CHAT], achievementChats: [CHAT] };
    try {
      let store = new AchievementStore(db, () => config);
      for (let i = 0; i < 9; i++) store.siesta(CHAT, PN, "Alice", NOW);
      db.close();
      db = openDatabase(path);
      store = new AchievementStore(db, () => config);
      expect(store.siesta(CHAT, PN, "Alice", NOW)).toContain("Let Them Sleep");
      db.close();
      db = openDatabase(path);
      store = new AchievementStore(db, () => config);
      expect(store.siesta(CHAT, PN, "Alice", NOW)).toBeNull();
      expect(store.describe(CHAT, PN)).toContain("[Unlocked] Let Them Sleep");
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});

describe("surprise achievement integrations", () => {
  function trivia() {
    const state = setup();
    const runtime = new RuntimeState();
    cleanup.push(() => runtime.dispose());
    const reply = vi.fn().mockResolvedValue(undefined);
    const answer: TriviaAnswerCtx = {
      runtime, scores: new TriviaScoreStore(state.db), duelScores: new DuelWinStore(state.db),
      achievements: state.store, interactions: state.interactions,
      chatId: CHAT, senderId: PN, senderName: "Alice", text: "Paris", sentAt: NOW,
      cfg: state.getConfig(), reply,
    };
    const question = (mode: "classic" | "duel" = "classic") => runtime.triviaGames.set(CHAT, {
      question: "Capital?", options: ["Paris", "London"], correct: "Paris",
      askedAt: NOW, language: "en", mode, answered: new Set(),
    });
    question();
    return { ...state, runtime, answer, reply, question };
  }

  it("ignores stale/non-answer guesses and resets the wrong streak on a scored answer", async () => {
    const { store, answer, question, interactions, reply } = trivia();
    for (let i = 0; i < 5; i++) await handleTriviaAnswer({ ...answer, text: "London", sentAt: NOW - 60_000 });
    for (let i = 0; i < 5; i++) await handleTriviaAnswer({ ...answer, text: "not an answer" });
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
    for (let i = 0; i < 4; i++) await handleTriviaAnswer({ ...answer, text: "London" });
    await handleTriviaAnswer(answer);
    question();
    for (let i = 0; i < 5; i++) await handleTriviaAnswer({ ...answer, text: "London" });
    expect(reply.mock.calls.flat().join("\n")).toContain("The Oracle Is Broken");
    interactions.addDebt(PN, 5_000);
    await handleTriviaAnswer(answer);
    expect(reply.mock.calls.flat().join("\n")).toContain("Still Worth It");
  });

  it("tracks a real comeback across duel questions", async () => {
    const { runtime, answer, question, store, reply } = trivia();
    runtime.triviaDuels.set(CHAT, {
      target: 5, phase: "running", hostName: "Alice",
      players: new Map([[PN, { name: "Alice", score: 1 }], [BOB, { name: "Bob", score: 4 }]]),
      session: { token: null, queue: [], language: "en" }, language: "en", countdownTimers: [],
    });
    for (let i = 0; i < 4; i++) {
      question("duel");
      await handleTriviaAnswer(answer);
    }
    const notices = reply.mock.calls.flat().join("\n");
    expect(notices).toContain("Comeback Kid");
    expect(notices).toContain("Photo Finish");
    expect(runtime.triviaDuels.has(CHAT)).toBe(false);
    expect(store.progress(CHAT, PN).counts.duels).toBe(1);
  });

  it("does not count repeated duel guesses or nonparticipants as new wrong answers", async () => {
    const { runtime, answer, question, store, reply } = trivia();
    runtime.triviaDuels.set(CHAT, {
      target: 5, phase: "running", hostName: "Alice",
      players: new Map([[PN, { name: "Alice", score: 0 }], [BOB, { name: "Bob", score: 0 }]]),
      session: { token: null, queue: [], language: "en" }, language: "en", countdownTimers: [],
    });
    question("duel");
    for (let i = 0; i < 8; i++) await handleTriviaAnswer({ ...answer, text: "London" });
    for (let i = 0; i < 8; i++) await handleTriviaAnswer({ ...answer, senderId: LID, text: "London" });
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
    expect(store.progress(CHAT, LID).unlocked).toEqual([]);
    for (let i = 0; i < 4; i++) {
      question("duel");
      await handleTriviaAnswer({ ...answer, text: "London" });
    }
    expect(reply.mock.calls.flat().join("\n")).toContain("The Oracle Is Broken");
  });

  it("counts only accepted siestas, excluding forced sleep and already-sleeping requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { db, store, getConfig, interactions } = setup();
    const runtime = new RuntimeState();
    cleanup.push(() => runtime.dispose());
    const reply = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
    const ctx = new Context({
      chatId: CHAT, senderId: PN, senderName: "Alice", senderPhone: "34600000001",
      messageId: "siesta", fromMe: false, isGroup: true, text: "bot.siesta 1",
      kind: "text", timestamp: NOW, raw: { key: {} },
    }, { transport: { sendText: reply } as Transport, getConfig });
    ctx.args = "1";
    const handler = makeSiesta(runtime, new SiestaDisciplineStore(db), interactions, store);
    await handler(ctx);
    await handler(ctx);
    runtime.cancelSiesta();
    await handler(ctx); // Same-day allowance exhausted: user sleeps, not the bot.
    for (let day = 1; day < 9; day++) {
      vi.setSystemTime(NOW + day * DAY);
      runtime.cancelSiesta();
      await handler(ctx);
    }
    expect(reply.mock.calls.flat().join("\n")).not.toContain("Let Them Sleep");
    vi.setSystemTime(NOW + 9 * DAY);
    runtime.cancelSiesta();
    await handler(ctx);
    expect(reply.mock.calls.flat().join("\n")).toContain("Let Them Sleep");
  });

  it("signals actual pet care only, never status, cooldowns or disabled pets", () => {
    const { db, getConfig } = setup();
    const pets = new PetService(new PetStore(db), getConfig, () => true);
    const care = vi.fn();
    pets.command(CHAT, "enable", "Mochi", NOW);
    pets.command(CHAT, "status", "", NOW, care);
    expect(care).not.toHaveBeenCalled();
    pets.command(CHAT, "feed", "", NOW, care);
    expect(care).toHaveBeenCalledTimes(1);
    pets.command(CHAT, "feed", "", NOW, care);
    expect(care).toHaveBeenCalledTimes(1);
    pets.command(CHAT, "disable", "", NOW);
    pets.command(CHAT, "water", "", NOW, care);
    expect(care).toHaveBeenCalledTimes(1);
  });
});
