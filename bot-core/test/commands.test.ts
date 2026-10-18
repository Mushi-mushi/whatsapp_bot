import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { COMMAND_CATALOGUE, commandHelp, defaultCommands, getCommandDefinition, registerConfiguredCommands } from "../src/router/commands.js";
import type { CommandRegistry } from "../src/router/commands.js";
import { Context } from "../src/router/context.js";
import { Bot } from "../src/router/router.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { help } from "../src/handlers/commands/help.js";
import { buildCommandRegistry } from "../src/handlers/commands/index.js";
import { openDatabase } from "../src/state/db.js";
import {
  ComplaintStore, ConfigStore, DuelWinStore, KarmaStore, RemindersStore,
  SeenActivityStore, SentimentStore, SiestaDisciplineStore, TellStore,
  TriviaScoreStore, UserMemoryStore, UserProfileStore,
} from "../src/state/repos.js";
import { RuntimeState } from "../src/state/runtime.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import type { Transport } from "../src/transport/types.js";
import { AskQuotaStore } from "../src/state/ask-quota.js";

// Persisted aliases and IDs must remain compatible with pre-catalogue installs.
const legacyCommands = {
  "bot.jokes": "jokes", "bot.roast.neg": "roast", "bot.roast": "roast",
  "bot.status": "status", "bot.help": "help", "bot.weather": "weather",
  "bot.meteo": "meteo", "bot.fact": "fact", "bot.8ball": "eightball",
  "bot.quote": "quote", "bot.siesta": "siesta", "bot.complain": "complain",
  "bot.score": "score", "bot.top.positive": "top_positive", "bot.top.negative": "top_negative",
  "bot.torture": "torture", "bot.insults": "insults", "bot.ask": "ask",
  "bot.ask.raw": "ask", "bot.models": "models", "bot.as": "as_user",
  "bot.profile": "profile", "bot.seen": "seen", "bot.whoami": "whoami",
  "bot.tell": "tell", "bot.remind": "remind", "bot.karma": "karma",
  "bot.translate": "translate", "bot.tldr": "tldr", "bot.roll": "roll",
  "bot.trivia": "trivia", "bot.paint": "paint", "bot.film": "film",
  "bot.instadelete": "instadelete", "bot.pet": "pet", "bot.services": "services",
};

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  const runtime = new RuntimeState();
  const jobs = new BackgroundJobs((error) => { throw error; });
  cleanup.push(async () => { await jobs.stop(); runtime.dispose(); });
  const configStore = new ConfigStore(db);
  const userMemory = new UserMemoryStore(db);
  const profiler = new ProfileService(userMemory, new UserProfileStore(db), jobs,
    () => configStore.load(), pino({ level: "silent" }));
  const registry = buildCommandRegistry({
    runtime, discipline: new SiestaDisciplineStore(db),
    askQuota: new AskQuotaStore(db),
    sentiment: new SentimentStore(db), complaints: new ComplaintStore(db),
    seenActivity: new SeenActivityStore(db), tells: new TellStore(db),
    karma: new KarmaStore(db), reminders: new RemindersStore(db),
    triviaScores: new TriviaScoreStore(db), duelScores: new DuelWinStore(db),
    userMemory, profiler,
    settings: {
      get: () => configStore.load(),
      update: (patch) => configStore.save({ ...configStore.load(), ...patch }),
    },
    pets: new PetService(new PetStore(db), () => configStore.load(), () => true),
  });
  const bot = new Bot();
  cleanup.push(() => bot.stop());
  return { registry, jobs, configStore, bot };
}

function context(text: string, commands: Record<string, string> = DEFAULT_CONFIG.commands) {
  const sendText = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
  const ctx = new Context({
    chatId: "chat@g.us", chatName: "Group", senderId: "alice", senderName: "Alice",
    senderPhone: "123456789", messageId: "message", fromMe: false, isGroup: true,
    text, kind: "text", timestamp: Date.now(), raw: { key: {} },
  }, {
    transport: { sendText } as Transport,
    getConfig: () => ({ ...DEFAULT_CONFIG, commands }),
  });
  return { ctx, sendText };
}

describe("command catalogue", () => {
  it("preserves every existing alias, command ID and default insertion order", () => {
    expect(defaultCommands()).toEqual(legacyCommands);
    expect(Object.entries(defaultCommands())).toEqual(Object.entries(legacyCommands));
    expect(DEFAULT_CONFIG.commands).toEqual(legacyCommands);
  });

  it("has unique routable aliases and complete metadata for every implemented command", () => {
    const { registry } = setup();
    expect(Object.keys(registry).sort()).toEqual(Object.keys(COMMAND_CATALOGUE).sort());
    const aliases: string[] = [];
    for (const [id, definition] of Object.entries(COMMAND_CATALOGUE)) {
      expect(definition.description.trim()).not.toBe("");
      expect(typeof definition.usage).toBe("string");
      expect(["inline", "background"]).toContain(definition.execution);
      expect(definition.aliases.length).toBeGreaterThan(0);
      expect(typeof registry[id as keyof CommandRegistry]).toBe("function");
      for (const { trigger } of definition.aliases) {
        expect(trigger).toMatch(/^bot\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/);
        expect(commandHelp(trigger, id)).toBeTruthy();
        aliases.push(trigger);
      }
    }
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("preserves the existing background execution policy", () => {
    expect(Object.entries(COMMAND_CATALOGUE)
      .filter(([, definition]) => definition.execution === "background").map(([id]) => id).sort())
      .toEqual(["ask", "as_user", "profile", "translate", "tldr", "paint", "film"].sort());
  });

  it.each(["missing", "__proto__", "constructor", "toString"])("rejects unknown or inherited command ID %s", (id) => {
    expect(getCommandDefinition(id)).toBeUndefined();
    expect(commandHelp("bot.custom", id)).toBeUndefined();
  });

  it("does not change saved aliases, remappings or intentionally removed commands", () => {
    const { configStore } = setup();
    configStore.load();
    const commands = { "bot.chat": "ask", "bot.ask": "roll", "bot.future": "not-installed" };
    configStore.save({ ...DEFAULT_CONFIG, commands });
    expect(configStore.load().commands).toEqual(commands);
  });

  it("backfills defaults without overwriting existing custom mappings on an older install", () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const commands = { "bot.ask": "roll", "bot.chat": "ask" };
    db.prepare("INSERT INTO kv VALUES ('config', ?)").run(JSON.stringify({ ...DEFAULT_CONFIG, commands }));
    db.prepare("INSERT INTO kv VALUES ('config_version', '1')").run();
    const migrated = new ConfigStore(db).load();
    expect(migrated.commands).toEqual({ ...legacyCommands, ...commands });
  });
});

describe("catalogue-driven help", () => {
  it("uses mapped command IDs and the configured alias in usage", async () => {
    const { ctx, sendText } = context("bot.help", { "bot.chat": "ask", "bot.ask": "roll", "bot.custom": "not-installed" });
    await help(ctx);
    const text = sendText.mock.calls[0][1];
    expect(text).toContain("`bot.chat` — ask the AI");
    expect(text).toContain("`bot.chat <question>`");
    expect(text).toContain("`bot.ask` — roll dice");
    expect(text).toContain("`bot.ask 2d6`");
    expect(text).toContain("• `bot.custom`");
    expect(text).not.toContain("bot.roll");
    expect(text.indexOf("`bot.ask`")).toBeLessThan(text.indexOf("`bot.chat`"));
  });

  it("retains variant descriptions for default and renamed suffix aliases", () => {
    expect(commandHelp("bot.ask.raw", "ask")).toContain("without using learned profiles");
    expect(commandHelp("bot.chat.raw", "ask")).toContain("without using learned profiles");
    expect(commandHelp("BOT.CHAT.RAW", "ask")).toContain("without using learned profiles");
    expect(commandHelp("bot.tease.neg", "roast")).toContain("harsher roast");
    expect(commandHelp("bot.ask.raw", "roll")).toContain("roll dice");
    expect(commandHelp("bot.ask.raw", "roll")).not.toContain("profiles");
  });

  it("handles an empty configured command list", async () => {
    const { ctx, sendText } = context("bot.help", {});
    await help(ctx);
    expect(sendText.mock.calls[0][1]).toContain("No commands are configured yet.");
  });
});

describe("catalogue-driven registration", () => {
  it("wraps every background alias and only background aliases", () => {
    const { bot, jobs, registry } = setup();
    const wrap = vi.spyOn(jobs, "wrap");
    const warn = vi.fn();
    registerConfiguredCommands(bot, DEFAULT_CONFIG.commands, registry, jobs, warn);
    const expected = Object.entries(DEFAULT_CONFIG.commands)
      .filter(([, id]) => getCommandDefinition(id)?.execution === "background")
      .map(([, id]) => registry[id as keyof CommandRegistry]);
    expect(wrap.mock.calls.map(([handler]) => handler)).toEqual(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it("queues renamed expensive commands while inline commands can still run", async () => {
    const { bot, jobs, registry } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jobs.submit("busy", () => gate);
    const ask = vi.fn();
    const roll = vi.fn();
    registry.ask = ask;
    registry.roll = roll;
    registerConfiguredCommands(bot, { "bot.chat": "ask", "bot.dice": "roll" }, registry, jobs, vi.fn());
    await bot.handle(context("bot.chat hello").ctx);
    await bot.handle(context("bot.dice 2d6").ctx);
    expect(ask).not.toHaveBeenCalled();
    expect(roll).toHaveBeenCalledOnce();
    release();
    await jobs.stop();
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0].args).toBe("hello");
  });

  it("removes stale registrations and warns for unknown IDs on reload", async () => {
    const { bot, jobs, registry } = setup();
    const ask = vi.fn();
    registry.ask = ask;
    registerConfiguredCommands(bot, { "bot.old": "ask" }, registry, jobs, vi.fn());
    const warn = vi.fn();
    registerConfiguredCommands(bot, { "bot.new": "ask", "bot.invalid": "__proto__" }, registry, jobs, warn);
    await bot.handle(context("bot.old hello").ctx);
    await bot.handle(context("bot.invalid hello").ctx);
    await bot.handle(context("bot.new hello").ctx);
    await jobs.stop();
    expect(ask).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("bot.invalid", "__proto__");
  });
});
