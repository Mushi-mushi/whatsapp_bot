import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { makeAsk } from "../src/handlers/commands/ask.js";
import { makeTranslate } from "../src/handlers/commands/translate.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { openDatabase } from "../src/state/db.js";
import { UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

const ollama = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../src/util/ollama.js", () => ({
  ollamaChat: ollama.chat,
  ollamaErrorMessage: () => "err",
}));

beforeEach(() => {
  ollama.chat.mockReset();
  ollama.chat.mockResolvedValue({ ok: true, content: "Paris." });
});

function setup(cfg: BotConfig = DEFAULT_CONFIG) {
  const db = openDatabase(":memory:");
  const userMemory = new UserMemoryStore(db);
  const profiler = new ProfileService(
    userMemory,
    new UserProfileStore(db),
    new BackgroundJobs(() => {}),
    () => cfg,
    pino({ level: "silent" }),
  );
  return { userMemory, ask: makeAsk(userMemory, profiler) };
}

function makeCtx(args: string, cfg: BotConfig = DEFAULT_CONFIG) {
  const msg: IncomingMessage = {
    chatId: "c@g.us",
    chatName: "Group",
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    senderPhone: "34600000001",
    messageId: "m1",
    fromMe: false,
    isGroup: true,
    text: `bot.ask ${args}`,
    kind: "text",
    timestamp: Date.now(),
    raw: {} as WAMessage,
  };
  const services: Services = {
    transport: { sendText: vi.fn(async () => {}) } as unknown as Services["transport"],
    getConfig: () => cfg,
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  return ctx;
}

describe("bot.ask records the question for profiling", () => {
  it("stores the asked question under the asker's identity", async () => {
    const { userMemory, ask } = setup();
    await ask(makeCtx("What are the best trail running shoes?"));
    const msgs = userMemory.recentFor("34600000001");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("(asked the bot) What are the best trail running shoes?");
  });

  it("does not record when user memory is disabled", async () => {
    const cfg = { ...DEFAULT_CONFIG, userMemoryEnabled: false };
    const { userMemory, ask } = setup(cfg);
    await ask(makeCtx("anything", cfg));
    expect(userMemory.recentFor("34600000001")).toHaveLength(0);
  });
});

describe("bot.translate records the input for profiling", () => {
  it("stores the translated text under the asker's identity", async () => {
    const db = openDatabase(":memory:");
    const userMemory = new UserMemoryStore(db);
    const profiler = new ProfileService(
      userMemory,
      new UserProfileStore(db),
      new BackgroundJobs(() => {}),
      () => DEFAULT_CONFIG,
      pino({ level: "silent" }),
    );
    const translate = makeTranslate(userMemory, profiler);
    await translate(makeCtx("Spanish I love cycling in the mountains"));
    const msgs = userMemory.recentFor("34600000001");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("(asked to translate to Spanish) I love cycling in the mountains");
  });
});
