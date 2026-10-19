import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { ContactsStore, KarmaStore, SeenActivityStore, SentimentStore, SuggestionStore, TellStore,
  TriviaScoreStore, DuelWinStore, UserMemoryStore, UserProfileStore, SiestaDisciplineStore } from "../src/state/repos.js";
import { RuntimeState } from "../src/state/runtime.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { Context } from "../src/router/context.js";
import type { IncomingMessage, Transport } from "../src/transport/types.js";
import { activityTracker, participantTracker, approvedSenderGuard, ignoreOwn, siestaGuard, sleepGuard } from "../src/middleware/index.js";
import { makeTell } from "../src/handlers/commands/tell.js";
import { makeSeen } from "../src/handlers/commands/seen.js";
import { makeKarma, makeKarmaHears } from "../src/handlers/commands/karma.js";
import { makeScore } from "../src/handlers/commands/score.js";
import { makeTopPositive } from "../src/handlers/commands/top.js";
import { makeTrivia, handleTriviaAnswer } from "../src/handlers/commands/trivia.js";
import { makeInsults } from "../src/handlers/commands/insults.js";
import { makeSuggest } from "../src/handlers/commands/suggest.js";
import { makeFallback } from "../src/handlers/fallback.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { removeScopedSchema } from "./legacy-schema.js";

const PN = "34600000001@s.whatsapp.net";
const OTHER = "34600000002@s.whatsapp.net";
const CHAT = "group@g.us";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  const runtime = new RuntimeState();
  cleanup.push(() => runtime.dispose());
  const jobs = new BackgroundJobs(() => {});
  cleanup.push(() => jobs.stop());
  const cfg = { ...DEFAULT_CONFIG, userMemoryEnabled: false, botReplyPrefix: "", respondToOwnCommands: true };
  const people = new SeenActivityStore(db);
  const tells = new TellStore(db);
  const karma = new KarmaStore(db);
  const sentiment = new SentimentStore(db);
  const suggestions = new SuggestionStore(db);
  const scores = new TriviaScoreStore(db);
  const duelScores = new DuelWinStore(db);
  const userMemory = new UserMemoryStore(db);
  const profiler = new ProfileService(userMemory, new UserProfileStore(db), jobs, () => cfg, pino({ level: "silent" }));
  const fallback = makeFallback({ runtime, sentiment, suggestions, triviaScores: scores, duelScores, userMemory, profiler });
  const sendText = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
  const transport = { sendText } as Transport;
  function context(args = "", over: Partial<IncomingMessage> = {}) {
    const ctx = new Context({
      chatId: CHAT, chatName: "Friends", senderId: PN, senderName: "Alice", senderPhone: "",
      messageId: "synthetic", fromMe: false, isGroup: true, text: args,
      kind: "text", timestamp: Date.now(), raw: { key: {} }, ...over,
    }, { transport, getConfig: () => cfg });
    ctx.args = args;
    return ctx;
  }
  async function observe(name: string, senderId: string, chatId = CHAT, time = Date.now()) {
    const ctx = context("hi", { senderName: name, senderId, chatId });
    vi.spyOn(Date, "now").mockReturnValueOnce(time);
    await participantTracker(people)(ctx, async () => {
      await activityTracker(tells)(ctx, async () => {});
    });
  }
  return { db, runtime, cfg, people, tells, karma, sentiment, suggestions, scores, duelScores, context, observe, fallback, sendText };
}

describe("chat-scoped named features", () => {
  it("refuses unknown or ambiguous tell recipients and never uses a contact name as proof of chat membership", async () => {
    const { db, people, tells, observe, context, sendText } = setup();
    new ContactsStore(db).upsertMany([{ jid: OTHER, phone: "34600000002", name: "Bob" }]);
    const tell = makeTell(tells, people);
    await tell(context("Bob: hello"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("send a message here first");
    await observe("Bob", OTHER, "other@g.us");
    await tell(context("Bob: hello"));
    expect(tells.list(1).total).toBe(0);
    await observe("Bob", OTHER);
    await observe("Bob", "900@lid");
    await tell(context("Bob: hello"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("More than one person");
    expect(tells.list(1).total).toBe(0);
  });

  it("binds a tell to one person and chat, survives rename, and hands it off once to the observed transport address", async () => {
    const { db, people, tells, observe, context } = setup();
    await observe("Bob", OTHER);
    await makeTell(tells, people)(context("Bob: call me"));
    await observe("Bob", "900@lid", CHAT);
    await observe("Bob", OTHER, "elsewhere@g.us");
    expect(tells.list(1).total).toBe(1);
    await observe("Robert", OTHER);
    await observe("Robert", OTHER);
    expect(tells.list(1).total).toBe(0);
    expect(db.prepare("SELECT chat_id,body FROM outbox").all())
      .toEqual([{ chat_id: CHAT, body: "Robert, Alice said: call me" }]);
  });

  it("holds legacy tells without attribution and supports cancellation alongside scoped tells", async () => {
    const { db, tells, observe } = setup();
    db.exec(`INSERT INTO tells (target_norm,target_name,from_name,message,created_ts)
      VALUES ('bob','Bob','Alice','legacy',0)`);
    await observe("Bob", OTHER);
    expect(tells.list(1).tells[0]).toMatchObject({ legacy: true, chatId: null, targetId: null, text: "legacy" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
    expect(tells.remove(1)).toBe(true);
  });

  it("uses verified aliases for tell handoff but preserves the raw LID delivery destination", async () => {
    const { db, tells } = setup();
    tells.add("900@lid", "900@lid", "Bob", "Alice", "hello");
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000002", name: "Bob" }]);
    tells.enqueueFor(OTHER, "900@lid", "Robert");
    expect(db.prepare("SELECT chat_id,body FROM outbox").get())
      .toEqual({ chat_id: "900@lid", body: "Robert, Alice said: hello" });
  });

  it("isolates last-seen and resolves only a person's latest local name", async () => {
    const { people, observe, context, sendText } = setup();
    await observe("Bob", OTHER, CHAT, 1000);
    await observe("Bob", OTHER, "elsewhere@g.us", 2000);
    expect(people.get(CHAT, OTHER)?.last_ts).toBe(1000);
    expect(people.get("elsewhere@g.us", OTHER)?.last_ts).toBe(2000);
    await makeSeen(people)(context("Bob"));
    expect(sendText.mock.calls.at(-1)![1]).not.toContain("elsewhere");
    await observe("Robert", OTHER, CHAT, 3000);
    await makeSeen(people)(context("Bob"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("haven't seen anyone");
    await makeSeen(people)(context("Robert"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("Robert was last seen");
    await observe("Alice", OTHER);
    await makeSeen(people)(context("Alice"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("More than one person");
  });

  it("tracks short/media/command and owner activity with AI memory disabled, but ignores bot messages and unapproved chats", async () => {
    const { people, context } = setup();
    for (const over of [
      { text: "ok" }, { text: null, kind: "audio" as const }, { text: "bot.status", fromMe: true },
    ]) await participantTracker(people)(context("", over), async () => {});
    expect(people.get(CHAT, PN)).toBeDefined();
    await participantTracker(people)(context("", { senderId: OTHER, isBot: true }), async () => {});
    expect(people.get(CHAT, OTHER)).toBeUndefined();
    await approvedSenderGuard(context("", { senderId: OTHER }), async () => {
      await participantTracker(people)(context("", { senderId: OTHER }), async () => {});
    });
    expect(people.get(CHAT, OTHER)).toBeUndefined();
  });

  it("keeps the newest observed name when verified alias records share a timestamp", () => {
    const { db, people } = setup();
    people.record(CHAT, PN, "Alice", 1000, "Friends");
    people.record(CHAT, "900@lid", "Old label", 1000, "Friends");
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
    people.record(CHAT, PN, "Alicia", 1000, "Friends");
    expect(people.resolve(CHAT, "Alicia")).toHaveLength(1);
    expect(people.resolve(CHAT, "Old label")).toEqual([]);
    expect(people.people(CHAT)).toHaveLength(1);
  });

  it("observes people without bypassing existing global siesta or player sleep delivery guards", async () => {
    const { db, runtime, people, tells, context } = setup();
    tells.add(CHAT, PN, "Alice", "Bob", "wait");
    const ctx = context("hi");
    runtime.siestaUntil = Date.now() + 60_000;
    await participantTracker(people)(ctx, async () => {
      await siestaGuard(runtime)(ctx, async () => {
        await activityTracker(tells)(ctx, async () => {});
      });
    });
    expect(people.get(CHAT, PN)).toBeDefined();
    expect(tells.list(1).total).toBe(1);
    runtime.cancelSiesta();
    new SiestaDisciplineStore(db).putToSleep(CHAT, PN, Date.now() + 60_000);
    await sleepGuard(new SiestaDisciplineStore(db), pino({ level: "silent" }))(ctx, async () => {
      await activityTracker(tells)(ctx, async () => {});
    });
    expect(tells.list(1).total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });

  it("uses identities for karma and self-karma checks, rejects ambiguity and keeps leaderboards local", async () => {
    const { people, karma, observe, context, sendText } = setup();
    await observe("Bob", OTHER);
    await makeKarmaHears(karma, people)(context("Bob++"));
    expect(karma.get(CHAT, OTHER)?.points).toBe(1);
    await observe("Robert", OTHER);
    await makeKarma(karma, people)(context("Robert"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("Robert has 1 karma");
    await makeKarmaHears(karma, people)(context("Alice++"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("no self-karma");
    await observe("Robert", "900@lid");
    await makeKarmaHears(karma, people)(context("Robert++"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("More than one person");
    expect(karma.get(CHAT, OTHER)?.points).toBe(1);
    expect(karma.top("elsewhere@g.us")).toEqual([]);
    await makeKarmaHears(karma, people)(context("Unknown++"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("send a message here first");
  });

  it("scopes sentiment logging, scores and quoted top messages to identities in the current chat", async () => {
    const { db, people, observe, context, fallback, sentiment, sendText } = setup();
    await observe("Alice", PN);
    await observe("Alice", OTHER);
    await fallback(context("I love this wonderful day"));
    await fallback(context("A private terrible day", { chatId: "private@g.us" }));
    db.exec(`INSERT INTO sentiment_log(ts,sender,sentiment,polarity,message) VALUES (0,'Alice','positive',100,'LEGACY')`);
    expect(sentiment.scoreFor(CHAT, PN).count).toBe(1);
    expect(sentiment.scoreFor(CHAT, OTHER).count).toBe(0);
    await makeScore(sentiment, people)(context(""));
    expect(sendText.mock.calls.at(-1)![1]).toContain("1 analyzed message");
    await makeScore(sentiment, people)(context("Alice"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("More than one person");
    await makeTopPositive(sentiment)(context(""));
    expect(sendText.mock.calls.at(-1)![1]).toContain("wonderful day");
    expect(sendText.mock.calls.at(-1)![1]).not.toContain("private");
    expect(sendText.mock.calls.at(-1)![1]).not.toContain("LEGACY");
  });

  it("combines only verified aliases in directory, karma and sentiment after learning a mapping", () => {
    const { db, people, karma, sentiment } = setup();
    people.record(CHAT, "900@lid", "Bob", 1, "Friends");
    people.record(CHAT, OTHER, "Robert", 2, "Friends");
    karma.adjust(CHAT, "900@lid", "Bob", 2);
    karma.adjust(CHAT, OTHER, "Robert", 3);
    sentiment.log(CHAT, "900@lid", "Bob", "positive", 1, "hello");
    sentiment.log(CHAT, OTHER, "Robert", "positive", 2, "hi");
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000002", name: "" }]);
    expect(people.people(CHAT)).toHaveLength(1);
    expect(people.resolve(CHAT, "Robert")).toHaveLength(1);
    expect(people.resolve(CHAT, "Bob")).toEqual([]);
    expect(karma.get(CHAT, OTHER)).toMatchObject({ points: 5, name: "Robert" });
    expect(sentiment.scoreFor(CHAT, OTHER)).toEqual({ total: 3, count: 2 });
  });
});

describe("identity-based games", () => {
  it("lets same-name people answer separately but prevents renames and alias changes from answering twice", async () => {
    const { db, runtime, scores, duelScores } = setup();
    vi.useFakeTimers();
    runtime.triviaGames.set(CHAT, {
      question: "Q", options: ["Yes", "No"], correct: "Yes", askedAt: Date.now(),
      language: "en", mode: "classic", answered: new Set(),
    });
    const answer = (senderId: string, senderName: string) => handleTriviaAnswer({
      runtime, scores, duelScores, chatId: CHAT, senderId, senderName, text: "A",
      sentAt: Date.now(), cfg: DEFAULT_CONFIG, reply: async () => {},
    });
    await answer("900@lid", "Alex");
    await answer(OTHER, "Alex");
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
    await answer(PN, "Renamed");
    expect(scores.top(CHAT)).toHaveLength(2);
    expect(scores.allTime(CHAT).map((p) => p.total)).toEqual([1, 1]);
    expect(scores.top("elsewhere@g.us")).toEqual([]);
  });

  it("keeps separate duel participants with identical names and rejects a renamed rejoin", async () => {
    const { runtime, scores, duelScores, context, sendText } = setup();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ response_code: 0, token: "token" })));
    const trivia = makeTrivia(runtime, scores, duelScores);
    await trivia(context("duel", { senderName: "Alex" }));
    await trivia(context("accept", { senderName: "Alex", senderId: OTHER }));
    expect(runtime.triviaDuels.get(CHAT)?.players.size).toBe(2);
    await trivia(context("accept", { senderName: "Renamed" }));
    expect(sendText.mock.calls.at(-1)![1]).toContain("already in the duel");
    expect(runtime.triviaDuels.get(CHAT)?.players.size).toBe(2);
  });

  it("matches active DM sessions and owner answers after verified addressing changes", async () => {
    const { db, runtime, scores, duelScores, people, context } = setup();
    vi.useFakeTimers();
    runtime.triviaGames.set("900@lid", {
      question: "Q", options: ["Yes", "No"], correct: "Yes", askedAt: Date.now(),
      language: "en", mode: "classic", answered: new Set(),
    });
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
    const next = vi.fn();
    await ignoreOwn(runtime, people)(context("A", { chatId: PN, fromMe: true, isGroup: false }), next);
    expect(next).toHaveBeenCalledOnce();
    expect(await handleTriviaAnswer({
      runtime, scores, duelScores, chatId: PN, senderId: OTHER, senderName: "Bob", text: "A",
      sentAt: Date.now(), cfg: DEFAULT_CONFIG, reply: async () => {},
    })).toBe(true);
    expect(scores.top(PN)[0]).toMatchObject({ senderId: OTHER, correct: 1 });
  });

  it("rechecks verified identities when a duel lobby closes", async () => {
    const { db, runtime, scores, duelScores, context, sendText } = setup();
    vi.useFakeTimers();
    const trivia = makeTrivia(runtime, scores, duelScores);
    await trivia(context("duel"));
    await trivia(context("accept", { senderId: "900@lid", senderName: "Another label" }));
    expect(runtime.triviaDuels.get(CHAT)?.players.size).toBe(2);
    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.triviaDuels.has(CHAT)).toBe(false);
    expect(sendText.mock.calls.at(-1)![1]).toContain("Not enough players");
  });

  it("keeps monthly totals/trophies joined by identity rather than duplicate names", async () => {
    const { scores, duelScores, context, runtime, sendText } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15));
    scores.add(CHAT, PN, "Alex", 4);
    scores.add(CHAT, OTHER, "Alex", 2);
    duelScores.add(CHAT, PN, "Alex");
    vi.setSystemTime(new Date(2026, 1, 15));
    scores.add(CHAT, PN, "Alicia", 1);
    scores.add(CHAT, OTHER, "Alex", 1);
    await makeTrivia(runtime, scores, duelScores)(context("scores"));
    expect(sendText.mock.calls.at(-1)![1]).toContain("Alicia: 1 (all-time 5)");
    expect(sendText.mock.calls.at(-1)![1]).toContain("Alex: 1 (all-time 3)");
    expect(scores.trophies(CHAT)).toEqual([{ senderId: PN, name: "Alex", trophies: 1 }]);
    expect(duelScores.top(CHAT)).toEqual([]);
    expect(duelScores.trophies(CHAT)).toHaveLength(1);
  });

  it("binds insult-duel answers to their challenger rather than any same-name speaker", async () => {
    const { runtime, people, context, fallback, sendText } = setup();
    await makeInsults(runtime, people)(context("", { senderName: "Alex" }));
    sendText.mockClear();
    const game = runtime.insultGames.get(CHAT)!;
    await fallback(context("random answer", { senderName: "Alex", senderId: OTHER }));
    expect(game.botWins).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    await fallback(context("random answer", { senderName: "Renamed" }));
    expect(game.botWins).toBe(1);
  });

  it("logs explicit bot.suggest ideas and silently logs unrecognized bot.xxxx commands without replying", async () => {
    const { suggestions, sentiment, context, fallback, sendText } = setup();
    const suggest = makeSuggest(suggestions);
    await suggest(context(""));
    expect(sendText).toHaveBeenCalledWith(CHAT, expect.stringContaining("Usage: `bot.suggest"));
    expect(suggestions.list(1).total).toBe(0);

    sendText.mockClear();
    await suggest(context("Add a horoscope command"));
    expect(sendText).toHaveBeenCalledOnce();
    expect(suggestions.list(1).suggestions[0]).toMatchObject({
      kind: "explicit",
      command: null,
      text: "Add a horoscope command",
      senderId: PN,
      chatId: CHAT,
    });

    sendText.mockClear();
    await fallback(context("hey bot.dance salsa"));
    expect(sendText).not.toHaveBeenCalled();
    expect(sentiment.scoreFor(CHAT, PN).count).toBe(0);
    expect(suggestions.list(1).suggestions[0]).toMatchObject({
      kind: "unknown_command",
      command: "bot.dance",
      text: "bot.dance salsa",
      senderId: PN,
      chatId: CHAT,
    });
  });
});

describe("legacy feature preservation", () => {
  it("migrates schema eight without attributing or deleting historical records across restart/rollover/reset", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-scoped-features-"));
    const path = join(directory, "bot.db");
    let db = openDatabase(path);
    try {
      removeScopedSchema(db);
      db.exec(`
        INSERT INTO seen_activity VALUES ('alex','Alex',1,'Private group');
        INSERT INTO karma VALUES ('alex','Alex',50);
        INSERT INTO tells(target_norm,target_name,from_name,message,created_ts) VALUES ('alex','Alex','Bob','legacy',1);
        INSERT INTO sentiment_log(ts,sender,sentiment,polarity,message) VALUES (1,'Alex','positive',1,'legacy');
        INSERT INTO trivia_scores VALUES ('group@g.us','alex','Alex',4);
        INSERT INTO trivia_trophies VALUES ('group@g.us','2026-01','alex','Alex',4);
        INSERT INTO trivia_totals VALUES ('group@g.us','alex','Alex',8);
        INSERT INTO duel_wins VALUES ('group@g.us','alex','Alex',1);
        INSERT INTO duel_trophies VALUES ('group@g.us','2026-01','alex','Alex',1);
        INSERT INTO duel_totals VALUES ('group@g.us','alex','Alex',3);
        PRAGMA user_version=8;
      `);
      const legacyTables = ["seen_activity", "karma", "trivia_scores", "trivia_trophies", "trivia_totals",
        "duel_wins", "duel_trophies", "duel_totals"];
      const tables = [...legacyTables, "kv",
        "contacts", "outbox", "reminders", "user_messages", "user_profiles", "ask_quota"];
      const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
      const before = snapshot();
      db.close();
      db = openDatabase(path);
      expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(snapshot()).toEqual(before);
      expect(new KarmaStore(db).top(CHAT)).toEqual([]);
      expect(new SeenActivityStore(db).resolve(CHAT, "Alex")).toEqual([]);
      expect(new SentimentStore(db).scoreFor(CHAT, PN)).toEqual({ total: 0, count: 0 });
      const tells = new TellStore(db);
      tells.enqueueFor(PN, CHAT, "Alex");
      expect(tells.list(1).tells[0]).toMatchObject({ legacy: true, text: "legacy", chatId: null, targetId: null });
      const scores = new TriviaScoreStore(db);
      scores.closeMonth("2026-01");
      scores.clearAll();
      expect(scores.allTime(CHAT)).toEqual([]);
      for (const table of legacyTables) {
        expect(db.prepare(`SELECT * FROM "${table}"`).all()).toEqual(before[tables.indexOf(table)]);
      }
      db.close();
      db = openDatabase(path);
      expect(new TellStore(db).list(1).tells[0].legacy).toBe(true);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});
