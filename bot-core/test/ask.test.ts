import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { makeAsk, models as modelsCmd } from "../src/handlers/commands/ask.js";
import { makeAsUser } from "../src/handlers/commands/asuser.js";
import { makeProfile } from "../src/handlers/commands/profile.js";
import { makeTranslate } from "../src/handlers/commands/translate.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { openDatabase } from "../src/state/db.js";
import { UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

import { memoryKey } from "../src/state/identity.js";
import { AskQuotaStore } from "../src/state/ask-quota.js";

const ollama = vi.hoisted(() => ({ chat: vi.fn(), listModels: vi.fn() }));
vi.mock("../src/util/ollama.js", () => ({
  ollamaChat: ollama.chat,
  ollamaErrorMessage: () => "err",
  ollamaListModels: ollama.listModels,
}));

beforeEach(() => {
  ollama.chat.mockReset();
  ollama.chat.mockResolvedValue({ ok: true, content: "Paris." });
  ollama.listModels.mockReset();
  ollama.listModels.mockResolvedValue({ ok: true, models: ["llama3", DEFAULT_CONFIG.ollamaModel] });
});

function setup(cfg: BotConfig = DEFAULT_CONFIG) {
  const db = openDatabase(":memory:");
  const userMemory = new UserMemoryStore(db);
  const profiles = new UserProfileStore(db);
  const profiler = new ProfileService(
    userMemory,
    profiles,
    new BackgroundJobs(() => {}),
    () => cfg,
    pino({ level: "silent" }),
  );
  const quota = new AskQuotaStore(db);
  return { userMemory, profiles, profiler, quota, ask: makeAsk(userMemory, profiler, quota) };
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

// Like makeCtx but also exposes the sendText spy so reply text can be asserted.
function makeCtxWithReply(args: string, cfg: BotConfig = DEFAULT_CONFIG) {
  const sendText = vi.fn(async () => {});
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
    transport: { sendText } as unknown as Services["transport"],
    getConfig: () => cfg,
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  return { ctx, sendText };
}

describe("bot.ask quota", () => {
  const cfg = { ...DEFAULT_CONFIG, userMemoryEnabled: false };

  it("shares ten requests across ask/raw/model overrides and blocks concurrent excess before inference", async () => {
    const { ask, quota } = setup(cfg);
    const reserve = vi.spyOn(quota, "consume");
    const requests = Array.from({ length: 12 }, (_, i) => {
      const { ctx, sendText } = makeCtxWithReply(i % 2 ? "model=llama3 question" : "question", cfg);
      ctx.commandTrigger = i % 2 ? "bot.ask.raw" : "bot.ask";
      ctx.msg.fromMe = true;
      return { ctx, sendText };
    });
    await Promise.all(requests.map(({ ctx }) => ask(ctx)));
    expect(ollama.chat).toHaveBeenCalledTimes(10);
    expect(reserve).toHaveBeenCalledTimes(12);
    for (const { sendText } of requests.slice(10)) {
      expect(sendText.mock.calls[0][1]).toContain("used your 10 bot.ask requests in this chat");
      expect(sendText.mock.calls[0][1]).toContain("60 minutes");
    }
  });

  it("does not count empty prompts, disabled ask, model-only overrides or model-list requests", async () => {
    const { ask, quota } = setup(cfg);
    const reserve = vi.spyOn(quota, "consume");
    for (const args of ["", "models", "model=?", "model=llama3"]) await ask(makeCtx(args, cfg));
    await ask(makeCtx("question", { ...cfg, askEnabled: false }));
    expect(reserve).not.toHaveBeenCalled();
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(ollama.listModels).toHaveBeenCalledTimes(2);
  });

  it("counts failed inference attempts but still allows model-list requests during cooldown", async () => {
    const { ask } = setup(cfg);
    ollama.chat.mockResolvedValue({ ok: false, reason: "unreachable" });
    for (let i = 0; i < 10; i++) await ask(makeCtx("question", cfg));
    const { ctx, sendText } = makeCtxWithReply("question", cfg);
    await ask(ctx);
    expect(sendText.mock.calls[0][1]).toContain("used your 10");
    await ask(makeCtx("models", cfg));
    expect(ollama.chat).toHaveBeenCalledTimes(10);
    expect(ollama.listModels).toHaveBeenCalledOnce();
  });

  it("fails explicitly without inference if quota persistence fails", async () => {
    const { ask, quota } = setup(cfg);
    vi.spyOn(quota, "consume").mockImplementation(() => { throw new Error("Disk unavailable"); });
    await expect(ask(makeCtx("question", cfg))).rejects.toThrow("Disk unavailable");
    expect(ollama.chat).not.toHaveBeenCalled();
  });
});

describe("bot.ask records the question for profiling", () => {
  it("uses the resolved DM scope for recording and mention context without reading legacy or other chat memory", async () => {
    const { userMemory, ask } = setup();
    const ctx = makeCtx("what does Bob think?");
    ctx.msg.chatId = "900@lid";
    ctx.msg.chatIdentity = "34600000001@s.whatsapp.net";
    ctx.msg.senderId = "900@lid";
    ctx.msg.senderIdentity = ctx.msg.chatIdentity;
    ctx.msg.isGroup = false;
    userMemory.record(memoryKey(ctx.msg.chatIdentity, "2"), "Bob", "DM", "CANONICAL CONTEXT", 50);
    userMemory.record(memoryKey(ctx.msg.chatId, "3"), "Bob", "DM", "LEGACY CONTEXT", 50);
    userMemory.record(memoryKey("other@g.us", "4"), "Bob", "Other", "OTHER CHAT CONTEXT", 50);
    await ask(ctx);
    const messages = ollama.chat.mock.calls[0][1] as { role: string; content: string }[];
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(system).toContain("CANONICAL CONTEXT");
    expect(system).not.toContain("LEGACY CONTEXT");
    expect(system).not.toContain("OTHER CHAT CONTEXT");
    expect(userMemory.recentFor(memoryKey(ctx.msg.chatIdentity, "34600000001"))).toHaveLength(1);
    expect(userMemory.recentFor(memoryKey(ctx.msg.chatId, "3"))).toHaveLength(1);
  });

  it.each(["profile", "as"])("resolves named %s requests in the canonical DM scope", async (command) => {
    const { userMemory, profiles, profiler } = setup();
    const { ctx, sendText } = makeCtxWithReply(command === "profile" ? "Bob" : "Bob: hello");
    ctx.msg.chatId = "900@lid";
    ctx.msg.chatIdentity = "34600000001@s.whatsapp.net";
    ctx.msg.isGroup = false;
    const key = memoryKey(ctx.msg.chatIdentity, "2");
    userMemory.record(key, "Bob", "DM", "hello", 50);
    profiles.upsert({ sender_key: key, name: "Bob", deep: "CANONICAL DOSSIER", short: "Bob", last_profiled_id: 1 });
    const refresh = vi.spyOn(profiler, "refresh").mockResolvedValue(null);
    if (command === "profile") {
      vi.spyOn(profiler, "maybeRefresh").mockImplementation(() => {});
      await makeProfile(userMemory, profiler)(ctx);
      expect(sendText.mock.calls[0][1]).toContain("CANONICAL DOSSIER");
    } else {
      await makeAsUser(userMemory, profiler)(ctx);
      expect(refresh).toHaveBeenCalledWith(key, "Bob", ctx.config);
      const messages = ollama.chat.mock.calls[0][1] as { role: string; content: string }[];
      expect(messages[0].content).toContain("CANONICAL DOSSIER");
    }
  });

  it("stores the asked question under the asker's identity", async () => {
    const { userMemory, ask } = setup();
    await ask(makeCtx("What are the best trail running shoes?"));
    const msgs = userMemory.recentFor(memoryKey("c@g.us", "34600000001"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("(asked the bot) What are the best trail running shoes?");
  });

  it("does not record when user memory is disabled", async () => {
    const cfg = { ...DEFAULT_CONFIG, userMemoryEnabled: false };
    const { userMemory, ask } = setup(cfg);
    await ask(makeCtx("anything", cfg));
    expect(userMemory.recentFor(memoryKey("c@g.us", "34600000001"))).toHaveLength(0);
  });
});

describe("bot.ask.raw skips profile injection", () => {
  it("injects the asker's context for a normal ask", async () => {
    const { userMemory, ask } = setup();
    userMemory.record(memoryKey("c@g.us", "34600000001"), "Alice", null, "I love trail running in the Alps", 50);
    await ask(makeCtx("recommend a hobby"));
    const systems = ollama.chat.mock.calls[0][1]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");
    expect(systems).toContain("About Alice");
  });

  describe("chat-scoped command context", () => {
    it.each(["other@g.us", "private@lid"])("does not inject profiles or mentioned users from %s", async (otherChat) => {
      const { userMemory, profiles, ask } = setup();
      const self = memoryKey(otherChat, "34600000001");
      const bob = memoryKey(otherChat, "34600000002");
      userMemory.record(self, "Alice", "Group", "SECRET ALICE MEMORY", 50);
      userMemory.record(bob, "Bob", "Group", "SECRET BOB MEMORY", 50);
      profiles.upsert({ sender_key: self, name: "Alice", deep: "secret", short: "SECRET ALICE PROFILE", last_profiled_id: 0 });
      profiles.upsert({ sender_key: bob, name: "Bob", deep: "secret", short: "SECRET BOB PROFILE", last_profiled_id: 0 });
      await ask(makeCtx("what does Bob think?"));
      const sent = JSON.stringify(ollama.chat.mock.calls[0][1]);
      expect(sent).not.toContain("SECRET");
      expect(sent).not.toContain("About Alice");
      expect(sent).not.toContain("About Bob");
    });

    it("uses local memory and profiles when the same sender also has a profile elsewhere", async () => {
      const { userMemory, profiles, ask } = setup();
      profiles.upsert({ sender_key: memoryKey("other@g.us", "34600000001"), name: "Alice", deep: "other", short: "PRIVATE ELSEWHERE", last_profiled_id: 0 });
      profiles.upsert({ sender_key: memoryKey("c@g.us", "34600000001"), name: "Alice", deep: "local", short: "LOCAL SUMMARY", last_profiled_id: 0 });
      userMemory.record(memoryKey("c@g.us", "2"), "Bob", "Group", "LOCAL BOB MESSAGE", 50);
      await ask(makeCtx("what does Bob think?"));
      const sent = JSON.stringify(ollama.chat.mock.calls[0][1]);
      expect(sent).toContain("LOCAL SUMMARY");
      expect(sent).toContain("LOCAL BOB MESSAGE");
      expect(sent).not.toContain("PRIVATE ELSEWHERE");
    });

    it.each(["profile", "as", "as-no-colon"])("refuses ambiguous names for %s without inference", async (command) => {
      const { userMemory, profiler } = setup();
      userMemory.record(memoryKey("c@g.us", "1"), "Alex", "Group", "one", 50);
      userMemory.record(memoryKey("c@g.us", "2"), "Alex", "Group", "two", 50);
      const { ctx, sendText } = makeCtxWithReply(command === "profile" ? "Alex" : command === "as" ? "Alex: hello" : "Alex say hello");
      await (command === "profile" ? makeProfile(userMemory, profiler) : makeAsUser(userMemory, profiler))(ctx);
      expect(sendText.mock.calls[0][1]).toContain("More than one person");
      expect(ollama.chat).not.toHaveBeenCalled();
    });

    it("does not fall back to global name lookup in an unnamed DM", async () => {
      const { userMemory, profiles, profiler } = setup();
      const key = memoryKey("c@g.us", "2");
      userMemory.record(key, "Bob", "Group", "private group memory", 50);
      profiles.upsert({ sender_key: key, name: "Bob", deep: "PRIVATE DOSSIER", short: "private", last_profiled_id: 0 });
      const { ctx, sendText } = makeCtxWithReply("Bob");
      ctx.msg.chatId = "private@lid";
      ctx.msg.chatName = "";
      ctx.msg.isGroup = false;
      await makeProfile(userMemory, profiler)(ctx);
      expect(sendText.mock.calls[0][1]).toContain("in this chat yet");
      expect(sendText.mock.calls[0][1]).not.toContain("PRIVATE DOSSIER");
      expect(ollama.chat).not.toHaveBeenCalled();
    });

    it("allows self profiles even when another person has the same display name", async () => {
      const { userMemory, profiles, profiler } = setup();
      userMemory.record(memoryKey("c@g.us", "34600000001"), "Alice", "Group", "self", 50);
      userMemory.record(memoryKey("c@g.us", "2"), "Alice", "Group", "other", 50);
      profiles.upsert({ sender_key: memoryKey("c@g.us", "34600000001"), name: "Alice", deep: "MY DOSSIER", short: "me", last_profiled_id: 1 });
      const { ctx, sendText } = makeCtxWithReply("");
      await makeProfile(userMemory, profiler)(ctx);
      expect(sendText.mock.calls[0][1]).toContain("MY DOSSIER");
    });
  });

  it("omits profile context when invoked as bot.ask.raw", async () => {
    const { userMemory, ask } = setup();
    userMemory.record(memoryKey("c@g.us", "34600000001"), "Alice", null, "I love trail running in the Alps", 50);
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

describe("bot.ask inline model override", () => {
  it("uses the configured model by default", async () => {
    const { ask } = setup();
    await ask(makeCtx("What is the capital of France?"));
    const opts = ollama.chat.mock.calls[0][2] as { model?: string } | undefined;
    expect(opts?.model).toBe(DEFAULT_CONFIG.ollamaModel);
  });

  it("overrides the model from a model= token and strips it from the prompt", async () => {
    const { ask } = setup();
    await ask(makeCtx("model=llama3 What is the capital of France?"));
    const opts = ollama.chat.mock.calls[0][2] as { model?: string };
    expect(opts.model).toBe("llama3");
    const user = (ollama.chat.mock.calls[0][1] as { role: string; content: string }[]).find((m) => m.role === "user");
    expect(user?.content).toBe("What is the capital of France?");
  });

  it("supports an Ollama tag with a colon and a mid-prompt token", async () => {
    const { ask } = setup();
    await ask(makeCtx("Tell me a joke model=glm-4.7-flash:latest please"));
    const opts = ollama.chat.mock.calls[0][2] as { model?: string };
    expect(opts.model).toBe("glm-4.7-flash:latest");
    const user = (ollama.chat.mock.calls[0][1] as { role: string; content: string }[]).find((m) => m.role === "user");
    expect(user?.content).toBe("Tell me a joke please");
  });

  it("records the question without the model token", async () => {
    const { userMemory, ask } = setup();
    await ask(makeCtx("model=llama3 best trail shoes?"));
    const msgs = userMemory.recentFor(memoryKey("c@g.us", "34600000001"));
    expect(msgs[0].message).toBe("(asked the bot) best trail shoes?");
  });
});

describe("bot.ask models lists installed models", () => {
  it("replies with the available models and marks the default", async () => {
    const { ask } = setup();
    const { ctx, sendText } = makeCtxWithReply("models");
    await ask(ctx);
    expect(ollama.chat).not.toHaveBeenCalled();
    const reply = sendText.mock.calls[0][1] as string;
    expect(reply).toContain("llama3");
    expect(reply).toContain(`${DEFAULT_CONFIG.ollamaModel} (default)`);
  });

  it("also responds to `model=?`", async () => {
    const { ask } = setup();
    const { ctx, sendText } = makeCtxWithReply("model=?");
    await ask(ctx);
    expect(ollama.listModels).toHaveBeenCalled();
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1] as string).toContain("Available models");
  });

  it("matches singular/variant phrasings without hitting the LLM", async () => {
    const { ask } = setup();
    for (const phrase of ["list model", "show models", "which model", "model"]) {
      const { ctx, sendText } = makeCtxWithReply(phrase);
      await ask(ctx);
      expect(sendText.mock.calls[0][1] as string).toContain("Available models");
    }
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("reports when Ollama is unreachable", async () => {
    ollama.listModels.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const { ask } = setup();
    const { ctx, sendText } = makeCtxWithReply("models");
    await ask(ctx);
    expect(sendText.mock.calls[0][1] as string).toContain("couldn't reach Ollama");
  });
});

describe("bot.models command never calls the LLM", () => {
  it("lists installed models directly", async () => {
    const { ctx, sendText } = makeCtxWithReply("");
    await modelsCmd(ctx);
    expect(ollama.listModels).toHaveBeenCalled();
    expect(ollama.chat).not.toHaveBeenCalled();
    const reply = sendText.mock.calls[0][1] as string;
    expect(reply).toContain("llama3");
    expect(reply).toContain(`${DEFAULT_CONFIG.ollamaModel} (default)`);
  });

  it("is disabled when ask is off", async () => {
    const cfg = { ...DEFAULT_CONFIG, askEnabled: false };
    const { ctx, sendText } = makeCtxWithReply("", cfg);
    await modelsCmd(ctx);
    expect(ollama.listModels).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1] as string).toContain("disabled");
  });
});

describe("bot.as impersonates a profiled user", () => {
  it("answers in the voice of the named person", async () => {
    const { userMemory, profiler } = setup();
    for (const m of ["I love trail running", "France is the best", "I bake bread on weekends", "Mondays are rough"]) {
      userMemory.record(memoryKey("c@g.us", "34600000009"), "Hernan", "Group", m, 50);
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
      userMemory.record(memoryKey("c@g.us", "34600000007"), "Si Ying", "Group", m, 50);
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
      userMemory.record(memoryKey("other@g.us", "34600000009"), "Hernan", "Otra Fiesta", m, 50);
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
    expect(transport.sendText).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("in this chat yet"));
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
    const msgs = userMemory.recentFor(memoryKey("c@g.us", "34600000001"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("(asked to translate to Spanish) I love cycling in the mountains");
  });
});
