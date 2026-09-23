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
import { OutboxStore } from "./state/outbox.js";
import { DeliveryWorker } from "./state/deliveries.js";
import type { BotConfig } from "./config/schema.js";
import { BaileysTransport } from "./transport/baileys.js";
import { Bot } from "./router/router.js";
import { BackgroundJobs } from "./router/jobs.js";
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
import { paintImage } from "./handlers/commands/paint.js";

const AUTH_DIR = process.env.AUTH_DIR ?? "auth";
const DB_PATH = process.env.DB_PATH ?? "data/bot.db";
const API_PORT = Number(process.env.API_PORT ?? 5000);
const API_TOKEN = process.env.API_TOKEN || undefined;
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
  const jobs = new BackgroundJobs((err) => logger.error({ err }, "background job failed"));
  bot
    .use(ignoreOwn(runtime))
    .use(logging(logger))
    .use(approvedSenderGuard)
    .use(siestaGuard(runtime))
    .use(dedupe(seen))
    .use(activityTracker(seenActivity, tells))
    .use(mediaPolicy);

  bot.on("audio", jobs.wrap(makeAudioHandler(logger)));
  bot.on("image", jobs.wrap(paintImage));
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
      if (handler) bot.command(trigger, ["ask", "translate", "tldr", "paint"].includes(name) ? jobs.wrap(handler) : handler);
      else logger.warn({ trigger, name }, "No handler registered for command");
    }
  };
  registerCommands(config);

  const unsubscribeMessages = transport.onMessage((msg) => {
    // Record the chat name (group subject / DM contact) for the dashboard picker.
    if (!msg.fromMe && msg.chatName) knownChats.upsert([{ id: msg.chatId, name: msg.chatName }]);
    const ctx = new Context(msg, services);
    void bot.handle(ctx).catch((err) => logger.error({ err }, "handler error"));
  });

  // Groups discovered on connect (and updates) also feed the picker.
  const unsubscribeChats = transport.onChatsDiscovered((names) => knownChats.upsert(names));

  const { startApi } = await import("./api/server.js");
  const app = await startApi(
    {
      transport,
      configStore,
      knownChats,
      triviaScores,
      logger,
      apiToken: API_TOKEN,
      allowInsecureApi: process.env.ALLOW_INSECURE_API === "true",
      onConfigChange: () => {
        config = configStore.load();
        registerCommands(config); // Apply added/removed commands live, no restart needed.
      },
    },
    API_PORT,
  );

  await transport.start();
  logger.info("bot-core started");

  const deliveries = new DeliveryWorker(new OutboxStore(db), async (chatId, body) => {
    const prefix = config.botReplyPrefix?.trim();
    await transport.sendText(chatId, prefix ? `${prefix}\n${body}` : body);
  }, logger, () => transport.getStatus().state === "open");
  deliveries.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const deadline = setTimeout(() => {
      logger.error("Shutdown deadline exceeded; unfinished deliveries retain their leases");
      process.exit(1);
    }, 30_000);
    unsubscribeMessages();
    unsubscribeChats();
    await bot.stop();
    await jobs.stop();
    await deliveries.stop();
    runtime.dispose();
    await transport.stop();
    try {
      await app.close();
    } catch (err) {
      logger.error({ err }, "error closing API");
    }
    try {
      db.close();
    } catch (err) {
      logger.error({ err }, "error closing database");
    }
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
