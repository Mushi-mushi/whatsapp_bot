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
  SiestaDisciplineStore,
  SuggestionStore,
  TellStore,
  TriviaScoreStore,
  DuelWinStore,
  UserMemoryStore,
  UserProfileStore,
} from "./state/repos.js";
import { RuntimeState } from "./state/runtime.js";
import { OutboxStore } from "./state/outbox.js";
import { AuditStore } from "./state/audit.js";
import { AskQuotaStore } from "./state/ask-quota.js";
import { DeliveryWorker } from "./state/deliveries.js";
import { RetentionWorker } from "./state/retention.js";
import { BackupWorker, backupOptions } from "./state/backups.js";
import type { BotConfig } from "./config/schema.js";
import type { ConfigController } from "./config/controller.js";
import { BaileysTransport } from "./transport/baileys.js";
import { Bot } from "./router/router.js";
import { BackgroundJobs } from "./router/jobs.js";
import { registerConfiguredCommands } from "./router/commands.js";
import { Context, type Services } from "./router/context.js";
import {
  activityTracker,
  approvedSenderGuard,
  dedupe,
  ignoreOwn,
  instagramGuard,
  learnFromOwner,
  logging,
  mediaPolicy,
  petObserver,
  participantTracker,
  siestaGuard,
  sleepGuard,
} from "./middleware/index.js";
import { buildCommandRegistry } from "./handlers/commands/index.js";
import { ProfileService } from "./handlers/profiles/service.js";
import { KARMA_PATTERN, makeKarmaHears } from "./handlers/commands/karma.js";
import { makeAudioHandler } from "./handlers/audio.js";
import { makeFallback } from "./handlers/fallback.js";
import { paintImage } from "./handlers/commands/paint.js";
import { PetStore } from "./pets/store.js";
import { PetService } from "./pets/service.js";
import { petPortrait } from "./pets/art.js";

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
  const suggestions = new SuggestionStore(db);
  const contacts = new ContactsStore(db);
  const seenActivity = new SeenActivityStore(db);
  const tells = new TellStore(db);
  const karma = new KarmaStore(db);
  const reminders = new RemindersStore(db);
  const triviaScores = new TriviaScoreStore(db);
  const duelScores = new DuelWinStore(db);
  const userMemory = new UserMemoryStore(db);
  const userProfiles = new UserProfileStore(db);
  const discipline = new SiestaDisciplineStore(db);
  const runtime = new RuntimeState((err, chatId) => logger.error({ err, chatId }, "trivia scheduled work failed"));

  // Cached config, refreshed when the API saves changes.
  let config: BotConfig = configStore.load();
  const getConfig = () => config;

  // Reload cached config and re-apply command registration after a config change.
  const reloadConfig = () => {
    config = configStore.load();
    registerCommands(config);
  };
  // Lets commands (e.g. bot.instadelete) persist a config change and apply it live.
  const settings: ConfigController = {
    get: getConfig,
    update: (patch) => {
      const saved = configStore.save({ ...configStore.load(), ...patch });
      reloadConfig();
      return saved;
    },
  };

  const transport = new BaileysTransport({
    authDir: AUTH_DIR,
    logger,
    pairingNumber: PAIRING_NUMBER,
    syncFullHistory: process.env.SYNC_FULL_HISTORY === "true",
    persistContacts: (records) => contacts.upsertMany(records),
    loadContacts: () => contacts.all(),
  });
  const services: Services = { transport, getConfig };
  const pets = new PetService(new PetStore(db), getConfig, () =>
    transport.getStatus().state === "open" &&
    transport.getStatus().health === "online");

  // Build the router from config-driven command triggers.
  const bot = new Bot();
  const jobs = new BackgroundJobs((err) => logger.error({ err }, "background job failed"));
  const profiler = new ProfileService(userMemory, userProfiles, jobs, getConfig, logger);
  bot
    .use(logging(logger))
    .use(approvedSenderGuard)
    .use(dedupe(seen))
    .use(participantTracker(seenActivity))
    .use(learnFromOwner(userMemory, profiler))
    .use(petObserver(pets))
    .use(ignoreOwn(runtime, seenActivity))
    .use(sleepGuard(discipline, logger))
    .use(siestaGuard(runtime))
    .use(instagramGuard(logger))
    .use(activityTracker(tells))
    .use(mediaPolicy);

  bot.on("audio", jobs.wrap(makeAudioHandler(logger)));
  bot.on("image", jobs.wrap(paintImage));
  bot.hears(KARMA_PATTERN, makeKarmaHears(karma, seenActivity));
  bot.fallback(makeFallback({ runtime, sentiment, suggestions, triviaScores, duelScores, userMemory, profiler }));

  const commandRegistry = buildCommandRegistry({
    runtime,
    discipline,
    askQuota: new AskQuotaStore(db),
    sentiment,
    complaints,
    suggestions,
    seenActivity,
    tells,
    karma,
    reminders,
    triviaScores,
    duelScores,
    userMemory,
    profiler,
    settings,
    pets,
  });
  const registerCommands = (cfg: BotConfig) => {
    registerConfiguredCommands(bot, cfg.commands, commandRegistry, jobs,
      (trigger, name) => logger.warn({ trigger, name }, "No handler registered for command"));
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
  const outbox = new OutboxStore(db);
  const backups = new BackupWorker(db, backupOptions(process.env), logger);
  const app = await startApi(
    {
      transport,
      configStore,
      jobs,
      outbox,
      backups,
      reminders,
      tells,
      audit: new AuditStore(db),
      knownChats,
      triviaScores,
      duelScores,
      karma,
      seenActivity,
      suggestions,
      userMemory,
      userProfiles,
      profiler,
      pets,
      runtime,
      discipline,
      contacts,
      logger,
      apiToken: API_TOKEN,
      allowInsecureApi: process.env.ALLOW_INSECURE_API === "true",
      onConfigChange: reloadConfig,
    },
    API_PORT,
  );

  await transport.start();
  logger.info("bot-core started");

  const deliveries = new DeliveryWorker(outbox, async (chatId, body, delivery) => {
    const prefix = config.botReplyPrefix?.trim();
    const text = prefix ? `${prefix}\n${body}` : body;
    if (delivery.pet_event_id) {
      const event = pets.store.event(delivery.pet_event_id);
      if (!event) throw new Error("Pet delivery is missing its event");
      const image = await petPortrait(event.stage, !!event.sleeping, event.species);
      // Artwork generation may yield while the group disables or pauses its pet.
      if (pets.deliveryDecision(delivery) !== true) throw new Error("Pet delivery state changed before sending");
      await transport.sendImage(chatId, image, text);
    } else {
      await transport.sendText(chatId, text);
    }
  }, logger, () => transport.getStatus().state === "open", {
    canSend: (delivery) => pets.deliveryDecision(delivery),
    onSent: (delivery) => pets.delivered(delivery),
  });
  deliveries.start();
  pets.start(logger);
  const retention = new RetentionWorker(db, getConfig, logger);
  backups.start();
  retention.start();

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
    pets.stop();
    retention.stop();
    await backups.stop();
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
