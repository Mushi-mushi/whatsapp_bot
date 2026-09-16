import pino from "pino";
import { openDatabase } from "./state/db.js";
import {
  ComplaintStore,
  ConfigStore,
  ContactsStore,
  KnownChatsStore,
  SeenStore,
  SentimentStore,
} from "./state/repos.js";
import { RuntimeState } from "./state/runtime.js";
import type { BotConfig } from "./config/schema.js";
import { BaileysTransport } from "./transport/baileys.js";
import { Bot } from "./router/router.js";
import { Context, type Services } from "./router/context.js";
import {
  approvedSenderGuard,
  dedupe,
  ignoreOwn,
  logging,
  mediaPolicy,
  siestaGuard,
} from "./middleware/index.js";
import { buildCommandRegistry } from "./handlers/commands/index.js";
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
    .use(ignoreOwn)
    .use(logging(logger))
    .use(approvedSenderGuard)
    .use(siestaGuard(runtime))
    .use(mediaPolicy)
    .use(dedupe(seen));

  bot.on("audio", makeAudioHandler(logger));
  bot.fallback(makeFallback({ runtime, sentiment }));

  const commandRegistry = buildCommandRegistry({ runtime, sentiment, complaints });
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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
