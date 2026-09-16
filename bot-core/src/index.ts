import pino from "pino";
import { openDatabase } from "./state/db.js";
import {
  ComplaintStore,
  ConfigStore,
  ContactsStore,
  KarmaStore,
  KnownChatsStore,
  RemindersStore,
  SeenActivityStore,
  SeenStore,
  SentimentStore,
  TellStore,
  TriviaScoreStore,
} from "./state/repos.js";
import { RuntimeState } from "./state/runtime.js";
import type { BotConfig } from "./config/schema.js";
import { BaileysTransport } from "./transport/baileys.js";
import { Bot } from "./router/router.js";
import { Context, type Services } from "./router/context.js";
import {
  activityTracker,
  approvedSenderGuard,
  dedupe,
  ignoreOwn,
  logging,
  mediaPolicy,
  siestaGuard,
} from "./middleware/index.js";
import { buildCommandRegistry } from "./handlers/commands/index.js";
import { KARMA_PATTERN, makeKarmaHears } from "./handlers/commands/karma.js";
import { makeAudioHandler } from "./handlers/audio.js";
import { makeFallback } from "./handlers/fallback.js";

const AUTH_DIR = process.env.AUTH_DIR ?? "auth";
const DB_PATH = process.env.DB_PATH ?? "data/bot.db";
const API_PORT = Number(process.env.API_PORT ?? 5000);
const PAIRING_NUMBER = process.env.PAIRING_NUMBER || undefined;

async function main(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

  const db = openDatabase(DB_PATH);
  const configStore = new ConfigStore(db);
  const seen = new SeenStore(db);
  const knownChats = new KnownChatsStore(db);
  const sentiment = new SentimentStore(db);
  const complaints = new ComplaintStore(db);
  const contacts = new ContactsStore(db);
  const seenActivity = new SeenActivityStore(db);
  const tells = new TellStore(db);
  const karma = new KarmaStore(db);
  const reminders = new RemindersStore(db);
  const triviaScores = new TriviaScoreStore(db);
  const runtime = new RuntimeState();

  // Cached config, refreshed when the API saves changes.
  let config: BotConfig = configStore.load();
  const getConfig = () => config;

  const transport = new BaileysTransport({
    authDir: AUTH_DIR,
    logger,
    pairingNumber: PAIRING_NUMBER,
    syncFullHistory: process.env.SYNC_FULL_HISTORY === "true",
    persistContacts: (records) => contacts.upsertMany(records),
    loadContacts: () => contacts.all(),
  });
  const services: Services = { transport, getConfig };

  // Build the router from config-driven command triggers.
  const bot = new Bot();
  bot
    .use(ignoreOwn(runtime))
    .use(logging(logger))
    .use(approvedSenderGuard)
    .use(siestaGuard(runtime))
    .use(mediaPolicy)
    .use(dedupe(seen))
    .use(activityTracker(seenActivity, tells));

  bot.on("audio", makeAudioHandler(logger));
  bot.hears(KARMA_PATTERN, makeKarmaHears(karma));
  bot.fallback(makeFallback({ runtime, sentiment, triviaScores }));

  const commandRegistry = buildCommandRegistry({
    runtime,
    sentiment,
    complaints,
    seenActivity,
    tells,
    karma,
    reminders,
    triviaScores,
  });
  const registerCommands = (cfg: BotConfig) => {
    bot.clearCommands();
    for (const [trigger, name] of Object.entries(cfg.commands)) {
      const handler = commandRegistry[name];
      if (handler) bot.command(trigger, handler);
      else logger.warn({ trigger, name }, "No handler registered for command");
    }
  };
  registerCommands(config);

  transport.onMessage((msg) => {
    // Record the chat name (group subject / DM contact) for the dashboard picker.
    if (!msg.fromMe && msg.chatName) knownChats.upsert([msg.chatName]);
    const ctx = new Context(msg, services);
    void bot.handle(ctx).catch((err) => logger.error({ err }, "handler error"));
  });

  // Groups discovered on connect (and updates) also feed the picker.
  transport.onChatsDiscovered((names) => knownChats.upsert(names));

  const { startApi } = await import("./api/server.js");
  await startApi(
    {
      transport,
      configStore,
      knownChats,
      triviaScores,
      logger,
      onConfigChange: () => {
        config = configStore.load();
        registerCommands(config); // Apply added/removed commands live, no restart needed.
      },
    },
    API_PORT,
  );

  await transport.start();
  logger.info("bot-core started");

  // Deliver due reminders. Persisted in SQLite, so they survive restarts.
  setInterval(() => {
    for (const r of reminders.due(Date.now())) {
      const prefix = config.botReplyPrefix?.trim();
      const who = r.target_name ? ` ${r.target_name},` : "";
      const body = `⏰ Reminder:${who} ${r.text}`;
      void transport
        .sendText(r.chat_id, prefix ? `${prefix}\n${body}` : body)
        .catch((err) => logger.error({ err }, "reminder send failed"));
      reminders.remove(r.id);
    }
  }, 15_000);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
