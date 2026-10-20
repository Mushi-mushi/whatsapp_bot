import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { COMMAND_CATALOGUE, commandHelp, defaultCommands, getCommandDefinition, registerConfiguredCommands } from "../src/router/commands.js";
import type { CommandRegistry } from "../src/router/commands.js";
import { Context } from "../src/router/context.js";
import { Bot } from "../src/router/router.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { help } from "../src/handlers/commands/help.js";
import { buildCommandRegistry } from "../src/handlers/commands/index.js";
import { openDatabase } from "../src/state/db.js";
import {
  ComplaintStore, ConfigStore, DuelWinStore, KarmaStore, RemindersStore,
  SeenActivityStore, SentimentStore, SiestaDisciplineStore, SuggestionStore, TellStore,
  TriviaScoreStore, UserMemoryStore, UserProfileStore,
} from "../src/state/repos.js";
import { RuntimeState } from "../src/state/runtime.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import type { Transport } from "../src/transport/types.js";
import { AskQuotaStore } from "../src/state/ask-quota.js";
import { InteractionStore } from "../src/state/interactions.js";
import { approvedSenderGuard, dedupe, ignoreOwn } from "../src/middleware/index.js";
import { SeenStore } from "../src/state/repos.js";

// Persisted aliases and IDs must remain compatible with pre-catalogue installs.
const legacyCommands = {
  "bot.jokes": "jokes", "bot.roast.neg": "roast", "bot.roast": "roast",
  "bot.status": "status", "bot.help": "help", "bot.weather": "weather",
  "bot.meteo": "meteo", "bot.fact": "fact", "bot.8ball": "eightball",
  "bot.quote": "quote", "bot.siesta": "siesta", "bot.complain": "complain",
  "bot.suggest": "suggest",
  "bot.score": "score", "bot.top.positive": "top_positive", "bot.top.negative": "top_negative",
  "bot.torture": "torture", "bot.insults": "insults", "bot.ask": "ask",
  "bot.ask.raw": "ask", "bot.models": "models", "bot.as": "as_user",
  "bot.profile": "profile", "bot.seen": "seen", "bot.whoami": "whoami",
  "bot.tell": "tell", "bot.remind": "remind", "bot.karma": "karma",
  "bot.translate": "translate", "bot.tldr": "tldr", "bot.roll": "roll",
  "bot.trivia": "trivia", "bot.paint": "paint", "bot.film": "film",
  "bot.instadelete": "instadelete", "bot.pet": "pet", "bot.services": "services",
  "bot.billing": "billing",
  "bot.cost": "cost", "bot.mute": "mute",
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
  const interactions = new InteractionStore(db);
  const profiler = new ProfileService(userMemory, new UserProfileStore(db), jobs,
    () => configStore.load(), pino({ level: "silent" }));
  const registry = buildCommandRegistry({
    runtime, discipline: new SiestaDisciplineStore(db),
    askQuota: new AskQuotaStore(db),
    interactions,
    sentiment: new SentimentStore(db), complaints: new ComplaintStore(db),
    suggestions: new SuggestionStore(db),
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
  return { registry, jobs, configStore, bot, interactions, db, runtime };
}

function context(text: string, commands: Record<string, string> = DEFAULT_CONFIG.commands, config: Partial<BotConfig> = {}) {
  const sendText = vi.fn<Transport["sendText"]>().mockResolvedValue(undefined);
  const ctx = new Context({
    chatId: "chat@g.us", chatName: "Group", senderId: "alice", senderName: "Alice",
    senderPhone: "123456789", messageId: "message", fromMe: false, isGroup: true,
    text, kind: "text", timestamp: Date.now(), raw: { key: {} },
  }, {
    transport: { sendText } as Transport,
    getConfig: () => ({ ...DEFAULT_CONFIG, ...config, commands }),
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

  it.each([
    { "bot.invoice": "billing" },
    { "bot.invoice": "billing", "bot.billing": "roll" },
  ])("adds billing to version 16 configurations without replacing custom aliases: %j", (commands) => {
    const { db, configStore } = setup();
    db.prepare("INSERT INTO kv VALUES ('config', ?)").run(JSON.stringify({ ...DEFAULT_CONFIG, commands }));
    db.prepare("INSERT INTO kv VALUES ('config_version', '16')").run();
    expect(configStore.load().commands).toMatchObject({ "bot.billing": "billing", ...commands });
    expect(db.prepare("SELECT value FROM kv WHERE key = 'config_version'").get()).toEqual({ value: "18" });
  });
});

describe("interaction billing", () => {
  it("uses mapped command prices, keeps cost aliases free, and includes prices in help and cost output", async () => {
    const { bot, registry, interactions, jobs } = setup();
    registry.torture = vi.fn();
    registry.ask = vi.fn();
    const commands = { "bot.punish": "torture", "bot.chat": "ask", "bot.prices": "cost", "bot.invoice": "billing" };
    registerConfiguredCommands(bot, commands, registry, jobs, vi.fn(), interactions);
    await bot.handle(context("bot.punish", commands).ctx);
    await bot.handle(context("bot.chat hi", commands).ctx);
    await jobs.stop();
    expect(interactions.debt("alice", "123456789")).toBe(110);
    expect(interactions.total("alice", "123456789")).toBe(2);
    const prices = context("bot.prices", commands);
    await bot.handle(prices.ctx);
    expect(prices.sendText.mock.calls[0][1]).toContain("`bot.punish`: EUR 1.00");
    expect(prices.sendText.mock.calls[0][1]).toContain("`bot.chat`: EUR 0.10");
    expect(prices.sendText.mock.calls[0][1]).toContain("`bot.prices`: free");
    expect(interactions.debt("alice", "123456789")).toBe(110);
    const helpCtx = context("bot.help", commands);
    await help(helpCtx.ctx);
    expect(helpCtx.sendText.mock.calls[0][1]).toContain("[EUR 1.00]");
    expect(commandHelp("bot.mute", "mute")).toContain("EUR 0.20/minute");
    expect(commandHelp("bot.trivia", "trivia")).toContain("skip/next EUR 0.20");
  });

  it("counts failed command attempts and uses command IDs rather than trigger text for exemptions", async () => {
    const { bot, jobs, registry, interactions } = setup();
    registry.roll = () => { throw new Error("Command failed"); };
    registerConfiguredCommands(bot, { "bot.billing": "roll", "bot.invoice": "billing" },
      registry, jobs, vi.fn(), interactions);
    await expect(bot.handle(context("bot.billing").ctx)).rejects.toThrow("Command failed");
    await bot.handle(context("bot.invoice").ctx);
    expect(interactions.total("alice", "123456789")).toBe(1);
  });

  it("counts recognized aliases across chats, isolates users and keeps every billing alias free", async () => {
    const { bot, jobs, registry, interactions } = setup();
    registry.roll = vi.fn();
    const commands = { "bot.dice": "roll", "bot.billing": "billing", "bot.invoice": "billing" };
    registerConfiguredCommands(bot, commands, registry, jobs, vi.fn(), interactions);
    await bot.handle(context("BOT.DICE 2d6", commands).ctx);
    const elsewhere = context("bot.dice", commands).ctx;
    elsewhere.msg.chatId = "other@g.us";
    elsewhere.msg.senderName = "Renamed";
    await bot.handle(elsewhere);
    const otherUser = context("bot.dice", commands).ctx;
    otherUser.msg.senderId = "bob";
    otherUser.msg.senderPhone = "987654321";
    await bot.handle(otherUser);
    for (const text of ["hello", "bot.unknown", "bot.dice.extra", "bot.invoice", "bot.billing"]) {
      await bot.handle(context(text, commands).ctx);
    }
    const { ctx, sendText } = context("bot.billing", commands);
    await bot.handle(ctx);
    const bill = sendText.mock.calls[0][1];
    expect(bill).toContain("Lifetime interactions across chats: 2");
    expect(bill).toContain("Prices vary by command");
    expect(bill).toContain("Pretend total: EUR 0.20");
    expect(bill).toContain("no real charges, no payment due");
    expect(interactions.total("alice", "123456789")).toBe(2);
    expect(interactions.total("bob", "987654321")).toBe(1);
  });

  it.each([0, 1, 3, 10, 11, 123])("formats %i interactions exactly in cents", async (count) => {
    const { registry, interactions } = setup();
    for (let i = 0; i < count; i++) interactions.increment("alice", "123456789");
    const { ctx, sendText } = context("bot.billing");
    await registry.billing(ctx);
    expect(sendText.mock.calls[0][1]).toContain(`Pretend total: EUR ${(count / 10).toFixed(2)}`);
    expect(interactions.total("alice", "123456789")).toBe(count);
  });

  it("counts background commands at dispatch, not again when jobs run, and survives reloads", async () => {
    const { bot, jobs, registry, interactions } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jobs.submit("busy", () => gate);
    const ask = vi.fn();
    registry.ask = ask;
    const commands = { "bot.chat": "ask" };
    registerConfiguredCommands(bot, commands, registry, jobs, vi.fn(), interactions);
    try {
      for (let i = 0; i < 4; i++) await bot.handle(context("bot.chat hi", commands).ctx);
      expect(ask).not.toHaveBeenCalled();
      expect(interactions.total("alice", "123456789")).toBe(4);
      registerConfiguredCommands(bot, commands, registry, jobs, vi.fn(), interactions);
    } finally {
      release();
      await jobs.stop();
    }
    expect(ask).toHaveBeenCalledTimes(3);
    expect(interactions.total("alice", "123456789")).toBe(4);
  });

  it("does not count blocked, duplicate or bot-generated messages", async () => {
    const { bot, jobs, registry, interactions, db, runtime } = setup();
    registry.roll = vi.fn();
    bot.use(approvedSenderGuard).use(dedupe(new SeenStore(db))).use(ignoreOwn(runtime));
    registerConfiguredCommands(bot, DEFAULT_CONFIG.commands, registry, jobs, vi.fn(), interactions);
    await bot.handle(context("bot.roll").ctx);
    expect(interactions.total("alice", "123456789")).toBe(0);
    const allowed = () => context("bot.roll", DEFAULT_CONFIG.commands, { approvedSenders: ["chat@g.us"] }).ctx;
    await bot.handle(allowed());
    await bot.handle(allowed());
    const own = allowed();
    own.msg.messageId = "bot-generated";
    own.msg.isBot = true;
    await bot.handle(own);
    expect(interactions.total("alice", "123456789")).toBe(1);
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
