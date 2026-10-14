import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { makeAsk } from "../src/handlers/commands/ask.js";
import { makeAsUser } from "../src/handlers/commands/asuser.js";
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
  return { userMemory, profiler, ask: makeAsk(userMemory, profiler) };
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

describe("bot.ask.raw skips profile injection", () => {
  it("injects the asker's context for a normal ask", async () => {
    const { userMemory, ask } = setup();
    userMemory.record("34600000001", "Alice", null, "I love trail running in the Alps", 50);
    await ask(makeCtx("recommend a hobby"));
    const systems = ollama.chat.mock.calls[0][1]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");
    expect(systems).toContain("About Alice");
  });

  it("omits profile context when invoked as bot.ask.raw", async () => {
    const { userMemory, ask } = setup();
    userMemory.record("34600000001", "Alice", null, "I love trail running in the Alps", 50);
    const ctx = makeCtx("recommend a hobby");
    ctx.commandTrigger = "bot.ask.raw";
    await ask(ctx);
    const systems = ollama.chat.mock.calls[0][1]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");
    expect(systems).not.toContain("About Alice");
  });
});

describe("bot.as impersonates a profiled user", () => {
  it("answers in the voice of the named person", async () => {
    const { userMemory, profiler } = setup();
    for (const m of ["I love trail running", "France is the best", "I bake bread on weekends", "Mondays are rough"]) {
      userMemory.record("34600000009", "Hernan", "Group", m, 50);
    }
    const asUser = makeAsUser(userMemory, profiler);
    const ctx = makeCtx("");
    ctx.args = "Hernan: what do you think of Mondays?";
    await asUser(ctx);
    // The persona system prompt should instruct role-play as the named person.
    const lastCall = ollama.chat.mock.calls.at(-1)![1] as { role: string; content: string }[];
    expect(lastCall[0].content).toContain("role-playing as Hernan");
    expect(lastCall[1].content).toBe("what do you think of Mondays?");
  });

  it("parses a multi-word name without a colon", async () => {
    const { userMemory, profiler } = setup();
    for (const m of ["hola a todos", "me encanta el cafe", "vamos a la playa", "feliz lunes"]) {
      userMemory.record("34600000007", "Si Ying", "Group", m, 50);
    }
    const asUser = makeAsUser(userMemory, profiler);
    const ctx = makeCtx("");
    ctx.args = "Si Ying what should we do with hernan?";
    await asUser(ctx);
    const lastCall = ollama.chat.mock.calls.at(-1)![1] as { role: string; content: string }[];
    expect(lastCall[0].content).toContain("role-playing as Si Ying");
    expect(lastCall[1].content).toBe("what should we do with hernan?");
  });

  it("refuses to impersonate someone not active in this chat", async () => {
    const { userMemory, profiler } = setup();
    for (const m of ["hola", "que tal", "me gusta el asado", "argentina campeon"]) {
      userMemory.record("34600000009", "Hernan", "Otra Fiesta", m, 50);
    }
    const asUser = makeAsUser(userMemory, profiler);
    const transport = { sendText: vi.fn(async () => {}) };
    const msg: IncomingMessage = {
      chatId: "c@g.us", chatName: "Group", senderId: "x@s.whatsapp.net", senderName: "Bob",
      senderPhone: "34600000002", messageId: "m3", fromMe: false, isGroup: true,
      text: "bot.as Hernan: hi", kind: "text", timestamp: Date.now(), raw: {} as WAMessage,
    };
    const ctx = new Context(msg, { transport: transport as unknown as Services["transport"], getConfig: () => DEFAULT_CONFIG });
    ctx.args = "Hernan: what do you think of Mondays?";
    await asUser(ctx);
    expect(transport.sendText).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("isn't active in this chat"));
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("refuses an unknown person", async () => {
    const { userMemory, profiler } = setup();
    const asUser = makeAsUser(userMemory, profiler);
    const transport = { sendText: vi.fn(async () => {}) };
    const msg: IncomingMessage = {
      chatId: "c@g.us", chatName: "Group", senderId: "x@s.whatsapp.net", senderName: "Bob",
      senderPhone: "34600000002", messageId: "m2", fromMe: false, isGroup: true,
      text: "bot.as Nobody: hi", kind: "text", timestamp: Date.now(), raw: {} as WAMessage,
    };
    const ctx = new Context(msg, { transport: transport as unknown as Services["transport"], getConfig: () => DEFAULT_CONFIG });
    ctx.args = "Nobody: hi";
    await asUser(ctx);
    expect(transport.sendText).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Nobody"));
    expect(ollama.chat).not.toHaveBeenCalled();
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
