import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { beginDuel, makeTrivia, scheduleNextQuestion, startDuelQuestion, startQuestion } from "../src/handlers/commands/trivia.js";
import { Context } from "../src/router/context.js";
import { openDatabase } from "../src/state/db.js";
import { DuelWinStore, TriviaScoreStore } from "../src/state/repos.js";
import { RuntimeState, type TriviaDuel } from "../src/state/runtime.js";
import type { Transport } from "../src/transport/types.js";
import { InteractionStore } from "../src/state/interactions.js";
import { Bot } from "../src/router/router.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { registerConfiguredCommands, type CommandRegistry } from "../src/router/commands.js";

const CHAT = "group@g.us";
const question = { question: "Question?", correct: "Paris", options: ["Paris", "London"] };
const runtimes: RuntimeState[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const onError = vi.fn();
  const runtime = new RuntimeState(onError);
  runtimes.push(runtime);
  const db = openDatabase(":memory:");
  databases.push(db);
  const sendText = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
  const transport = { sendText } as Transport;
  const interactions = new InteractionStore(db);
  const handler = makeTrivia(runtime, new TriviaScoreStore(db), new DuelWinStore(db), interactions);
  function command(args: string) {
    const ctx = new Context({
      chatId: CHAT, chatName: "Group", senderId: "alice", senderName: "Alice",
      senderPhone: "123456789", messageId: "m1", fromMe: false, isGroup: true,
      text: `bot.trivia ${args}`, kind: "text", timestamp: Date.now(), raw: { key: {} },
    }, { transport, getConfig: () => DEFAULT_CONFIG });
    ctx.args = args;
    return handler(ctx);
  }
  runtime.triviaSessions.set(CHAT, { token: "token", language: "en", queue: [{ ...question }] });
  return { runtime, onError, sendText, command, interactions, handler };
}

describe("trivia lifecycle", () => {
  it.each(["skip", "next", " SKIP "])("charges exactly EUR 0.20 only for accepted %s through the configured router", async (args) => {
    const { runtime, sendText, handler, interactions } = setup();
    const bot = new Bot();
    const jobs = new BackgroundJobs(() => {});
    const registry = { trivia: handler } as CommandRegistry;
    registerConfiguredCommands(bot, { "bot.quiz": "trivia" }, registry, jobs, vi.fn(), interactions);
    const ctx = () => new Context({
      chatId: CHAT, chatName: "Group", senderId: "alice", senderName: "Alice",
      senderPhone: "123456789", messageId: "m1", fromMe: false, isGroup: true,
      text: `bot.quiz ${args}`, kind: "text", timestamp: Date.now(), raw: { key: {} },
    }, { transport: { sendText } as Transport, getConfig: () => DEFAULT_CONFIG });
    await bot.handle(ctx());
    expect(interactions.debt("alice", "123456789")).toBe(0);
    await startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    await bot.handle(ctx());
    await bot.handle(ctx());
    expect(interactions.debt("alice", "123456789")).toBe(20);
    expect(interactions.total("alice", "123456789")).toBe(1);
    await bot.stop();
    await jobs.stop();
  });

  it("stops during the inter-question gap and cancels its continuation", async () => {
    const { runtime, sendText, command } = setup();
    await startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    runtime.triviaSessions.get(CHAT)!.queue.push({ ...question });
    await command("skip");
    await command("stop");
    await vi.advanceTimersByTimeAsync(2000);
    expect(runtime.triviaSessions.has(CHAT)).toBe(false);
    expect(runtime.triviaGames.has(CHAT)).toBe(false);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText.mock.calls[2][1]).toContain("Trivia stopped.");
  });

  it("logs timeout send failures and cleans up without an unhandled rejection", async () => {
    const { runtime, onError, sendText } = setup();
    await startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    const error = new Error("disconnected");
    sendText.mockRejectedValueOnce(error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onError).toHaveBeenCalledWith(error, CHAT);
    expect(runtime.triviaGames.has(CHAT)).toBe(false);
    expect(runtime.triviaSessions.has(CHAT)).toBe(false);
  });

  it("logs continuation failures instead of swallowing them", async () => {
    const { runtime, onError } = setup();
    const reply = vi.fn().mockRejectedValue(new Error("send failed"));
    scheduleNextQuestion(runtime, CHAT, reply, DEFAULT_CONFIG);
    await vi.advanceTimersByTimeAsync(1200);
    expect(onError).toHaveBeenCalledOnce();
    expect(runtime.triviaGames.has(CHAT)).toBe(false);
    expect(runtime.triviaSessions.has(CHAT)).toBe(false);
  });

  it("does not create a game after stop during question preparation", async () => {
    const { runtime, sendText, command } = setup();
    runtime.triviaSessions.get(CHAT)!.queue = [];
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const starting = startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    await command("stop");
    release(Response.json({ response_code: 0, results: [{ question: "Question?", correct_answer: "Paris", incorrect_answers: ["London"] }] }));
    expect(await starting).toBe(false);
    expect(runtime.triviaGames.has(CHAT)).toBe(false);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("cleans up when sending the initial question fails", async () => {
    const { runtime, sendText } = setup();
    sendText.mockRejectedValueOnce(new Error("offline"));
    await expect(startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG)).rejects.toThrow("offline");
    expect(runtime.triviaSessions.size).toBe(0);
    expect(runtime.triviaGames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cancel a replacement session when an old scheduled send fails", async () => {
    const { runtime, onError } = setup();
    let reject!: (error: Error) => void;
    const reply = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await startQuestion(runtime, CHAT, async () => {}, DEFAULT_CONFIG);
    runtime.triviaSessions.get(CHAT)!.queue.push({ ...question });
    runtime.scheduleTrivia(CHAT, () => reply(), 100);
    await vi.advanceTimersByTimeAsync(100);
    runtime.cancelTrivia(CHAT);
    const replacement = { token: "new", language: "en" as const, queue: [{ ...question }] };
    runtime.triviaSessions.set(CHAT, replacement);
    reject(new Error("old send failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(runtime.triviaSessions.get(CHAT)).toBe(replacement);
  });

  it("does not revive a disposed runtime after an in-flight request", async () => {
    const { runtime, sendText } = setup();
    runtime.triviaSessions.delete(CHAT);
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const starting = startQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    runtime.dispose();
    release(Response.json({ response_code: 0, token: "token" }));
    expect(await starting).toBe(false);
    expect(runtime.triviaSessions.size).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("disposes pending continuation timers", async () => {
    const { runtime, sendText } = setup();
    scheduleNextQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG);
    runtime.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendText).not.toHaveBeenCalled();
    expect(runtime.triviaGames.size).toBe(0);
  });

  function duel(runtime: RuntimeState): TriviaDuel {
    const value: TriviaDuel = {
      target: 5, phase: "lobby", hostName: "Alice", language: "en",
      players: new Map([["alice", { name: "Alice", score: 0 }], ["bob", { name: "Bob", score: 0 }]]),
      session: { token: "token", language: "en", queue: [{ ...question }] },
      countdownTimers: [],
    };
    runtime.triviaSessions.delete(CHAT);
    runtime.triviaDuels.set(CHAT, value);
    return value;
  }

  it("handles countdown send failures and cancels the remaining duel timers", async () => {
    const { runtime, onError } = setup();
    duel(runtime);
    const reply = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("offline"));
    await beginDuel(runtime, CHAT, reply, DEFAULT_CONFIG);
    await vi.advanceTimersByTimeAsync(6000);
    expect(onError).toHaveBeenCalledOnce();
    expect(runtime.triviaDuels.size).toBe(0);
    expect(runtime.triviaGames.size).toBe(0);
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("keeps skipping a duel in duel mode and permits stopping its gap", async () => {
    const { runtime, sendText, command } = setup();
    const value = duel(runtime);
    value.phase = "running";
    await startDuelQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG, value);
    value.session.queue.push({ ...question });
    await command("skip");
    await vi.advanceTimersByTimeAsync(1200);
    expect(runtime.triviaGames.get(CHAT)?.mode).toBe("duel");
    expect(runtime.triviaSessions.has(CHAT)).toBe(false);
    await command("skip");
    await command("stop");
    await vi.advanceTimersByTimeAsync(1200);
    expect(runtime.triviaGames.size).toBe(0);
    expect(runtime.triviaDuels.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a duel when its question timeout reply fails", async () => {
    const { runtime, onError, sendText } = setup();
    const value = duel(runtime);
    value.phase = "running";
    await startDuelQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG, value);
    sendText.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(runtime.triviaDuels.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not install a prepared question in a cancelled duel", async () => {
    const { runtime, sendText } = setup();
    const value = duel(runtime);
    value.session.queue = [];
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const starting = startDuelQuestion(runtime, CHAT, (text) => sendText(CHAT, text), DEFAULT_CONFIG, value);
    runtime.cancelTrivia(CHAT);
    release(Response.json({ response_code: 0, results: [{ question: "Q", correct_answer: "A", incorrect_answers: ["B"] }] }));
    expect(await starting).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(runtime.triviaGames.size).toBe(0);
  });
});
