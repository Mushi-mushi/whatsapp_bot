import { describe, it, expect, vi, afterEach } from "vitest";
import { makeFallback } from "../src/handlers/fallback.js";
import { handleTriviaAnswer } from "../src/handlers/commands/trivia.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { RuntimeState, type TriviaGame, type TriviaDuel } from "../src/state/runtime.js";
import { openDatabase } from "../src/state/db.js";
import { SentimentStore, TriviaScoreStore, DuelWinStore, UserMemoryStore } from "../src/state/repos.js";
import type { ProfileService } from "../src/handlers/profiles/service.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

const CHAT = "c@s.whatsapp.net";

afterEach(() => {
  vi.useRealTimers();
});

function makeGame(askedAt: number, over: Partial<TriviaGame> = {}): TriviaGame {
  return {
    question: "Q?",
    options: ["Paris", "London", "Rome", "Madrid"],
    correct: "Paris",
    askedAt,
    language: "en",
    mode: "classic",
    answered: new Set(),
    ...over,
  };
}

function setup(game: TriviaGame) {
  const db = openDatabase(":memory:");
  const runtime = new RuntimeState();
  runtime.triviaGames.set(CHAT, game);
  const deps = {
    runtime,
    sentiment: new SentimentStore(db),
    triviaScores: new TriviaScoreStore(db),
    duelScores: new DuelWinStore(db),
    userMemory: new UserMemoryStore(db),
    profiler: { maybeRefresh() {} } as unknown as ProfileService,
  };
  return { runtime, deps, scores: deps.triviaScores, duelScores: deps.duelScores };
}

function makeCtx(
  text: string,
  timestamp: number,
  senderName = "Alice",
): { ctx: Context; sendText: ReturnType<typeof vi.fn> } {
  const msg: IncomingMessage = {
    chatId: CHAT,
    chatName: "Group",
    senderId: senderName.toLowerCase(),
    senderName,
    senderPhone: "",
    messageId: `m-${senderName}-${timestamp}`,
    fromMe: false,
    isGroup: true,
    text,
    kind: "text",
    timestamp,
    raw: {} as WAMessage,
  };
  const sendText = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText } as unknown as Services["transport"],
    getConfig: () => DEFAULT_CONFIG,
  };
  return { ctx: new Context(msg, services), sendText };
}

function scoreMap(scores: TriviaScoreStore): Map<string, number> {
  return new Map(scores.top(CHAT, 10).map((r) => [r.name, r.correct]));
}

describe("trivia stale-answer guard", () => {
  it("ignores an answer sent before the current question appeared", async () => {
    const askedAt = Date.now();
    const { deps, scores } = setup(makeGame(askedAt));
    const { ctx, sendText } = makeCtx("A", askedAt - 10_000);
    await makeFallback(deps)(ctx);
    expect(sendText).not.toHaveBeenCalled();
    expect(scores.top(CHAT)).toEqual([]);
  });

  it("accepts a wrong answer sent after the question (scores -1)", async () => {
    const askedAt = Date.now();
    const { deps, scores } = setup(makeGame(askedAt));
    const { ctx, sendText } = makeCtx("B", askedAt + 1_000);
    await makeFallback(deps)(ctx);
    expect(sendText).toHaveBeenCalledOnce();
    expect(scores.top(CHAT, 5)).toEqual([{ senderId: "alice", name: "Alice", correct: -1 }]);
  });

  it("accepts a same-second answer whose timestamp is floored below askedAt", async () => {
    const askedAt = Date.now();
    const { deps, scores } = setup(makeGame(askedAt));
    const { ctx, sendText } = makeCtx("B", askedAt - 900);
    await makeFallback(deps)(ctx);
    expect(sendText).toHaveBeenCalledOnce();
    expect(scores.top(CHAT, 5)).toEqual([{ senderId: "alice", name: "Alice", correct: -1 }]);
  });
});

describe("classic multi-correct", () => {
  it("allows retrying after a wrong answer and scores the wrong guess", async () => {
    vi.useFakeTimers();
    const askedAt = Date.now();
    const { deps, scores } = setup(makeGame(askedAt));
    const run = makeFallback(deps);

    const wrong = makeCtx("C", askedAt + 1000, "Alice");
    await run(wrong.ctx);
    await run(makeCtx("A", askedAt + 2000, "Alice").ctx);

    expect(wrong.sendText).toHaveBeenCalledOnce();
    expect(scoreMap(scores).get("Alice")).toBe(0);
  });

  it("awards every correct answerer once and ignores repeats", async () => {
    vi.useFakeTimers();
    const askedAt = Date.now();
    const { deps, scores } = setup(makeGame(askedAt));
    const run = makeFallback(deps);

    await run(makeCtx("A", askedAt + 1000, "Alice").ctx); // Paris = A (correct)
    await run(makeCtx("Paris", askedAt + 1500, "Bob").ctx); // correct by text
    await run(makeCtx("A", askedAt + 2000, "Alice").ctx); // Alice again → ignored

    const map = scoreMap(scores);
    expect(map.get("Alice")).toBe(1);
    expect(map.get("Bob")).toBe(1);
    // The collection window is still open (not advanced yet).
    expect(deps.runtime.triviaGames.has(CHAT)).toBe(true);
  });
});

describe("trivia duel", () => {
  function makeDuel(target: number, players: string[]): TriviaDuel {
    return {
      target,
      phase: "running",
      hostName: players[0],
      players: new Map(players.map((p) => [p.toLowerCase(), { name: p, score: 0 }])),
      session: { token: null, category: undefined, language: "en", queue: [] },
      language: "en",
      countdownTimers: [],
    };
  }

  function duelArgs(
    runtime: RuntimeState,
    duelScores: DuelWinStore,
    scores: TriviaScoreStore,
    text: string,
    sender: string,
    askedAt: number,
  ) {
    const reply = vi.fn(async () => {});
    return {
      args: {
        runtime,
        scores,
        duelScores,
        chatId: CHAT,
        senderId: sender.toLowerCase(),
        senderName: sender,
        text,
        sentAt: askedAt + 500,
        cfg: DEFAULT_CONFIG,
        reply,
      },
      reply,
    };
  }

  it("records a win for the fastest player reaching the target", async () => {
    const askedAt = Date.now();
    const { runtime, duelScores, scores } = setup(makeGame(askedAt, { mode: "duel" }));
    runtime.triviaDuels.set(CHAT, makeDuel(1, ["Alice", "Bob"]));

    const { args, reply } = duelArgs(runtime, duelScores, scores, "A", "Alice", askedAt);
    const consumed = await handleTriviaAnswer(args);

    expect(consumed).toBe(true);
    expect(reply).toHaveBeenCalledOnce();
    expect(duelScores.top(CHAT, 5)).toEqual([{ senderId: "alice", name: "Alice", wins: 1 }]);
    expect(runtime.triviaDuels.has(CHAT)).toBe(false); // duel ended
    expect(runtime.triviaGames.has(CHAT)).toBe(false);
  });

  it("ignores answers from players who did not join the duel", async () => {
    const askedAt = Date.now();
    const { runtime, duelScores, scores } = setup(makeGame(askedAt, { mode: "duel" }));
    runtime.triviaDuels.set(CHAT, makeDuel(3, ["Alice", "Bob"]));

    const { args, reply } = duelArgs(runtime, duelScores, scores, "A", "Carol", askedAt);
    const consumed = await handleTriviaAnswer(args);

    expect(consumed).toBe(false); // not a participant → falls through
    expect(reply).not.toHaveBeenCalled();
    expect(runtime.triviaGames.has(CHAT)).toBe(true); // question still open
  });

  it("gives no penalty for a wrong duel answer but consumes the attempt", async () => {
    const askedAt = Date.now();
    const { runtime, duelScores, scores } = setup(makeGame(askedAt, { mode: "duel" }));
    const duel = makeDuel(3, ["Alice", "Bob"]);
    runtime.triviaDuels.set(CHAT, duel);

    const first = duelArgs(runtime, duelScores, scores, "B", "Alice", askedAt);
    expect(await handleTriviaAnswer(first.args)).toBe(true);
    expect(duel.players.get("alice")!.score).toBe(0);

    // Alice already used her attempt this question → ignored.
    const again = duelArgs(runtime, duelScores, scores, "A", "Alice", askedAt);
    expect(await handleTriviaAnswer(again.args)).toBe(true);
    expect(duel.players.get("alice")!.score).toBe(0);
  });
});
