import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { ConfigSchema } from "../config/schema.js";
import { redactSecrets, restoreSecrets } from "../config/secrets.js";
import type { ConfigStore, ContactsStore, DuelWinStore, KarmaStore, KnownChatsStore, RemindersStore, SeenActivityStore, SiestaDisciplineStore, SuggestionStore, TellStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../state/repos.js";
import type { InteractionStore } from "../state/interactions.js";
import { ContactResolver } from "../transport/contacts.js";
import type { ProfileService } from "../handlers/profiles/service.js";
import { ProfileQueueError } from "../handlers/profiles/service.js";
import type { AskQuotaStore } from "../state/ask-quota.js";
import type { UsageResetRequest, UsageResetResponse } from "../../../shared/api.js";
import type { Transport } from "../transport/types.js";
import { ollamaListModels } from "../util/ollama.js";
import { ServiceDiagnostics } from "../util/service-status.js";
import { z } from "zod";
import type { PetService } from "../pets/service.js";
import { SPECIES, isSpecies, statusText, type Pet } from "../pets/model.js";
import { DEFAULT_PET_SETTINGS, PetSettingsSchema, petSettings } from "../pets/settings.js";
import type { RuntimeState } from "../state/runtime.js";
import type { BackgroundJobs } from "../router/jobs.js";
import type { OutboxStore } from "../state/outbox.js";
import type { BackupWorker } from "../state/backups.js";
import type { AuditStore } from "../state/audit.js";
import { registerAudit } from "./audit.js";
import type { TriviaBanStore } from "../state/trivia-bans.js";
import { triviaCategories } from "../handlers/commands/trivia.js";
import type { TriviaSettingsResponse } from "../../../shared/api.js";
import { MUTE_DEBT_CENTS_PER_MINUTE } from "../router/pricing.js";
import type {
  BotConfig, ChatsResponse, ContactsResponse, DisciplinePlayer, DisciplineResponse,
  DisciplineMutationResponse, SiestaStatus, GroupPet, PetsResponse, PetActionResponse,
  PetUpdate, ConfigSaveResponse, ProfileDetail, ProfilesResponse,
  ProfileRefreshResponse,
  PetRequest, PetEvolutionRequest, DisciplineTarget, DisciplineSleepRequest,
  OperationsResponse,
  ReminderCreateRequest, ReminderUpdateRequest, ReminderMutationResponse, ReminderCancelResponse,
  TellCancelResponse, SuggestionDeleteResponse, DeliveryRetryResponse,
  LeaderboardsResponse, BillingResponse, BillingChargeResponse,
} from "../../../shared/api.js";

export interface ApiDeps {
  transport: Transport;
  configStore: ConfigStore;
  knownChats: KnownChatsStore;
  triviaScores: TriviaScoreStore;
  triviaBans: TriviaBanStore;
  duelScores?: DuelWinStore;
  karma?: KarmaStore;
  seenActivity?: SeenActivityStore;
  suggestions?: SuggestionStore;
  userMemory: UserMemoryStore;
  userProfiles: UserProfileStore;
  profiler: ProfileService;
  pets: PetService;
  runtime: RuntimeState;
  discipline: SiestaDisciplineStore;
  askQuota: AskQuotaStore;
  interactions: InteractionStore;
  contacts: ContactsStore;
  jobs: BackgroundJobs;
  outbox: OutboxStore;
  backups: BackupWorker;
  reminders: RemindersStore;
  tells: TellStore;
  audit: AuditStore;
  onConfigChange: () => void;
  logger: Logger;
  apiToken?: string;
  allowInsecureApi?: boolean;
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function revision(config: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

export async function createApi(deps: ApiDeps): Promise<FastifyInstance> {
  if (!deps.apiToken && !deps.allowInsecureApi) throw new Error("API_TOKEN is required");
  const app = Fastify({ logger: false });
  const startedAt = Date.now() - Math.floor(process.uptime() * 1000);
  const diagnostics = new ServiceDiagnostics(deps.logger);
  app.addHook("onError", async (req, _reply, error) => {
    deps.logger.error({ err: error, method: req.method, url: req.routeOptions.url }, "API request failed");
  });
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });

  if (deps.apiToken) {
    const token = deps.apiToken;
    app.addHook("onRequest", async (req, reply) => {
      const provided = extractToken(req);
      if (!provided || !tokensMatch(provided, token)) {
        reply.code(401).send({ ok: false, error: "unauthorized" });
      }
    });
  } else {
    deps.logger.warn("API_TOKEN not set — the API and dashboard are UNAUTHENTICATED.");
  }
  registerAudit(app, deps.audit, deps.apiToken);

  deps.runtime.triviaBanUntil = (chatId, categoryId) => deps.triviaBans.until(chatId, categoryId);
  const triviaBanTarget = z.object({ chatId: z.string().trim().min(1), categoryId: z.number().int() });
  app.get("/api/trivia/settings", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { categories: triviaCategories().map(({ id, name }) => ({ id, name })), bans: deps.triviaBans.list(), sampledAt: Date.now() } satisfies TriviaSettingsResponse;
  });
  app.post("/api/trivia/bans", async (req, reply) => {
    const parsed = triviaBanTarget.extend({ days: z.number().int().min(1).max(365) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Choose a chat, category and whole number of days (1-365)." });
    const { chatId, categoryId, days } = parsed.data;
    const category = triviaCategories().find((entry) => entry.id === categoryId);
    if (!category || !deps.knownChats.list().some((chat) => chat.id === chatId)) {
      return reply.code(400).send({ ok: false, error: "Unknown chat or trivia category." });
    }
    const ban = deps.triviaBans.set(chatId, categoryId, category.name, days);
    if (deps.runtime.triviaGames.get(chatId)?.categoryId === categoryId ||
        deps.runtime.triviaSessions.get(chatId)?.category?.id === categoryId ||
        deps.runtime.triviaDuels.get(chatId)?.category?.id === categoryId) deps.runtime.cancelTrivia(chatId);
    return { ok: true, ban, announcementQueued: true };
  });
  app.delete("/api/trivia/bans", async (req, reply) => {
    const parsed = triviaBanTarget.strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Choose a chat and category." });
    deps.triviaBans.remove(parsed.data.chatId, parsed.data.categoryId);
    return { ok: true };
  });

  app.get("/api/status", async () => deps.transport.getStatus());
  const listPage = z.object({
    page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(1_000_000)).default("1"),
  });
  const recordId = z.object({
    id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe()),
  });
  app.get("/api/operations/audit", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = listPage.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid audit page. Use a whole number from 1 to 1000000." });
    return deps.audit.list(parsed.data.page);
  });
  const reminderFields = z.object({
    targetName: z.string().trim().max(80).nullable().transform((v) => (v && v.length > 0 ? v : null)),
    text: z.string().trim().min(1, "Reminder message is required.").max(500, "Reminder message is too long (max 500 chars)."),
    dueAt: z.number().int().safe(),
    recurrence: z.enum(["once", "daily", "weekly"]).default("once"),
  });
  const reminderCreateSchema = reminderFields.extend({
    chatId: z.string().trim().min(1, "Target chat is required."),
  }).strict() satisfies z.ZodType<ReminderCreateRequest, z.ZodTypeDef, unknown>;
  const reminderUpdateSchema = reminderFields.strict() satisfies z.ZodType<ReminderUpdateRequest, z.ZodTypeDef, unknown>;

  app.get("/api/reminders", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = listPage.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "Invalid reminders page. Use a whole number from 1 to 1000000." };
    }
    return deps.reminders.list(parsed.data.page);
  });
  app.post("/api/reminders", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = reminderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" ") || "Invalid reminder." };
    }
    const now = Date.now();
    if (parsed.data.dueAt <= now || parsed.data.dueAt > now + 365 * 86_400_000) {
      reply.code(400);
      return { ok: false, error: "Due time must be in the future (up to 365 days ahead)." };
    }
    const id = deps.reminders.add(parsed.data.chatId, parsed.data.targetName, parsed.data.text, parsed.data.dueAt, parsed.data.recurrence);
    const reminder = deps.reminders.get(id)!;
    return { ok: true, reminder } satisfies ReminderMutationResponse;
  });
  app.put("/api/reminders/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsedId = recordId.safeParse(req.params);
    if (!parsedId.success) {
      reply.code(400);
      return { ok: false, error: "Invalid reminder ID." };
    }
    const parsed = reminderUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" ") || "Invalid reminder." };
    }
    const now = Date.now();
    if (parsed.data.dueAt <= now || parsed.data.dueAt > now + 365 * 86_400_000) {
      reply.code(400);
      return { ok: false, error: "Due time must be in the future (up to 365 days ahead)." };
    }
    const updated = deps.reminders.update(parsedId.data.id, parsed.data.targetName, parsed.data.text, parsed.data.dueAt, parsed.data.recurrence);
    if (!updated) {
      reply.code(409);
      return { ok: false, error: "Reminder is no longer scheduled. It may already be queued, sent or cancelled." };
    }
    return { ok: true, reminder: updated } satisfies ReminderMutationResponse;
  });
  app.delete("/api/reminders/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = recordId.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "Invalid reminder ID." };
    }
    if (!deps.reminders.remove(parsed.data.id)) {
      reply.code(409);
      return { ok: false, error: "Reminder is no longer scheduled. It may already be queued, sent or cancelled; no delivery was cancelled." };
    }
    return { ok: true, cancelledId: parsed.data.id } satisfies ReminderCancelResponse;
  });
  app.get("/api/tells", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = listPage.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid tells page. Use a whole number from 1 to 1000000." });
    return deps.tells.list(parsed.data.page);
  });
  app.delete("/api/tells/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = recordId.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid tell ID." });
    if (!deps.tells.remove(parsed.data.id)) {
      return reply.code(409).send({ ok: false, error: "Tell is no longer pending. It may already be queued, sent or cancelled; no delivery was cancelled." });
    }
    return { ok: true, cancelledId: parsed.data.id } satisfies TellCancelResponse;
  });
  app.get("/api/suggestions", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = listPage.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid suggestions page. Use a whole number from 1 to 1000000." });
    return deps.suggestions ? deps.suggestions.list(parsed.data.page) : { suggestions: [], total: 0, page: parsed.data.page, pageSize: 50, sampledAt: Date.now() };
  });
  app.delete("/api/suggestions/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = recordId.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid suggestion ID." });
    if (!deps.suggestions?.remove(parsed.data.id)) {
      return reply.code(409).send({ ok: false, error: "Suggestion is no longer present." });
    }
    return { ok: true, deletedId: parsed.data.id } satisfies SuggestionDeleteResponse;
  });
  app.get("/api/operations/failed-deliveries", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = listPage.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid failed deliveries page. Use a whole number from 1 to 1000000." });
    return deps.outbox.listFailed(parsed.data.page);
  });
  app.get("/api/operations/deliveries/:id/history", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = recordId.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid delivery ID." });
    const history = deps.outbox.history(parsed.data.id);
    if (!history) return reply.code(404).send({ ok: false, error: "Delivery not found; it may have been pruned." });
    return history;
  });
  app.post("/api/operations/deliveries/:id/retry", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const params = recordId.safeParse(req.params);
    const body = z.object({ expectedRetryCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
      acknowledgeDuplicateRisk: z.literal(true) }).strict().safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ ok: false, error: "A valid delivery ID, retry count and duplicate-risk acknowledgement are required." });
    }
    if (!deps.outbox.retryFailed(params.data.id, body.data.expectedRetryCount)) {
      return reply.code(409).send({ ok: false, error: "Delivery changed or is no longer failed. Refresh before retrying; no retry was scheduled." });
    }
    deps.logger.info({ id: params.data.id, retryCount: body.data.expectedRetryCount + 1 }, "manual delivery retry scheduled");
    return { ok: true, retriedId: params.data.id } satisfies DeliveryRetryResponse;
  });
  app.get("/api/operations/services", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return diagnostics.check(deps.configStore.load());
  });
  app.delete("/api/operations/jobs/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ ok: false, error: "Invalid job ID." });
    const status = deps.jobs.cancel(params.data.id);
    if (status === "not-found") return reply.code(409).send({ ok: false, error: "This job has already finished or was cancelled. Refresh operations." });
    if (status === "unsupported") return reply.code(409).send({ ok: false, error: "This running command cannot be safely interrupted. Queued commands and running profile refreshes can be cancelled." });
    return { ok: true, status };
  });
  app.post("/api/usage/reset", async (req, reply) => {
    const parsed = z.object({
      senderId: z.string().trim().regex(/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/),
      command: z.enum(["ask", "siesta"]),
      chatId: z.string().trim().regex(/^[^\s@]+@(g\.us|s\.whatsapp\.net|lid)$/).optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Select a valid player JID, either ask or siesta, and a valid chat ID for a chat-specific reset." });
    const { senderId, command, chatId }: UsageResetRequest = parsed.data;
    const identities = deps.contacts.identities();
    const approved = new Set(deps.configStore.load().approvedSenders.map((entry) =>
      identities.canonical(entry.includes("@") ? entry : `${entry.replace(/\D/g, "")}@s.whatsapp.net`)));
    if (chatId && !approved.has(identities.canonical(chatId))) {
      return reply.code(400).send({ ok: false, error: "Select an approved chat before resetting its request counter." });
    }
    const name = resolveName(senderId) ?? identities.canonical(senderId);
    const announce = (chats: string[]) => {
      for (const chat of chats) {
        if (approved.has(chat)) deps.outbox.enqueue(chat,
          `Root override: bot.${command} request count reset for ${name}.${command === "ask" ? " Cooldown cleared. You're good to go!" : " Daily allowance restored."}`);
      }
    };
    if (command === "ask") deps.askQuota.resetForUser(senderId, chatId, announce);
    else deps.discipline.resetUsageForUser(senderId, chatId, announce);
    return { ok: true, command } satisfies UsageResetResponse;
  });
  app.get("/api/health", async () => ({ ok: true, connection: deps.transport.getStatus().state }));
  app.get("/api/operations", async (_req, reply): Promise<OperationsResponse> => {
    reply.header("Cache-Control", "no-store");
    const sampledAt = Date.now();
    return {
      sampledAt, startedAt, deliveryReady: deps.transport.getStatus().state === "open",
      jobs: deps.jobs.snapshot(), outbox: deps.outbox.snapshot(sampledAt), backups: deps.backups.snapshot(),
    };
  });
  app.get("/api/siesta", async (): Promise<SiestaStatus> => ({
    sleeping: deps.runtime.isSleeping(),
    until: deps.runtime.isSleeping() ? deps.runtime.siestaUntil : null,
  }));
  app.post("/api/siesta/cancel", async (_req, reply) => {
    if (!deps.runtime.isSleeping()) return { ok: true, cancelled: deps.runtime.cancelSiesta() };
    const chat = deps.runtime.siestaChatId;
    if (!chat) return reply.code(409).send({ ok: false, error: "The active siesta has no originating chat; no cancellation or announcement was applied." });
    deps.outbox.enqueue(chat, "Root override: siesta cancelled. Nap time is over. Back online!");
    return { ok: true, cancelled: deps.runtime.cancelSiesta() };
  });

  const contactDirectory = (): ContactResolver => {
    const directory = new ContactResolver();
    directory.hydrate(() => deps.contacts.all());
    return directory;
  };
  const resolveName = (jid: string): string | null => {
    const directory = contactDirectory();
    return directory.nameForJid(jid) ?? directory.nameForPhone(directory.phoneFor(jid) ?? "") ?? null;
  };
  // Collapse a dashboard-supplied JID to the same identity the bot sees at message
  // time (phone-based), using the contact's phone when the JID is a LID.
  const canonicalTarget = (jid: string): string => {
    return contactDirectory().canonical(jid);
  };
  const disciplineView = (now = Date.now()): DisciplinePlayer[] => {
    const chats = new Map(deps.knownChats.list().map((c) => [c.id, c.name]));
    return deps.discipline.listActive(now).map((e) => ({
      chatId: e.chatId,
      chatName: chats.get(e.chatId) ?? null,
      senderId: e.senderId,
      displayName: resolveName(e.senderId),
      sleepUntil: e.sleepUntil != null && e.sleepUntil > now ? e.sleepUntil : null,
      armed: e.armed,
    }));
  };
  const disciplineTarget = z.object({
    chatId: z.string().trim().min(1), senderId: z.string().trim().min(1),
  }) satisfies z.ZodType<DisciplineTarget, z.ZodTypeDef, unknown>;
  const disciplineSleep = disciplineTarget.extend({
    minutes: z.number().int().min(1).max(60),
  }) satisfies z.ZodType<DisciplineSleepRequest, z.ZodTypeDef, unknown>;

  app.get("/api/discipline", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { players: disciplineView() } satisfies DisciplineResponse;
  });
  app.post("/api/discipline/sleep", async (req, reply) => {
    const parsed = disciplineSleep.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    const { chatId, senderId, minutes } = parsed.data;
    deps.discipline.putToSleep(chatId, canonicalTarget(senderId), Date.now() + minutes * 60_000);
    return { ok: true, players: disciplineView() } satisfies DisciplineMutationResponse;
  });
  app.post("/api/discipline/arm", async (req, reply) => {
    const parsed = disciplineTarget.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    deps.discipline.arm(parsed.data.chatId, canonicalTarget(parsed.data.senderId));
    return { ok: true, players: disciplineView() } satisfies DisciplineMutationResponse;
  });
  app.post("/api/discipline/wake", async (req, reply) => {
    const parsed = disciplineTarget.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    deps.discipline.wake(parsed.data.chatId, canonicalTarget(parsed.data.senderId));
    return { ok: true, players: disciplineView() } satisfies DisciplineMutationResponse;
  });

  // Known contacts (JID + display name + phone) for the dashboard's player picker.
  app.get("/api/contacts", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const contacts = deps.contacts.all()
      .filter((c) => c.name.trim())
      .map((c) => ({ jid: c.jid, name: c.name, phone: c.phone }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { contacts } satisfies ContactsResponse;
  });
  const billingView = (): BillingResponse["customers"] => {
    const customers = new Map<string, BillingResponse["customers"][number]>();
    for (const contact of deps.contacts.all()) {
      if (!contact.name.trim()) continue;
      const senderId = canonicalTarget(contact.jid);
      if (customers.has(senderId)) continue;
      const debtCents = deps.interactions.debt(senderId);
      customers.set(senderId, {
        senderId,
        name: resolveName(senderId) ?? contact.name,
        phone: contact.phone,
        debtCents,
        interactionCount: deps.interactions.total(senderId),
        muteAllowanceMinutes: Math.floor(debtCents / MUTE_DEBT_CENTS_PER_MINUTE),
      });
    }
    return [...customers.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  app.get("/api/billing", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { customers: billingView(), sampledAt: Date.now() } satisfies BillingResponse;
  });
  app.post("/api/billing/charges", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z.object({
      senderId: z.string().trim().regex(/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/),
      amountCents: z.number().int().min(1).max(1_000_000),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "Select a contact and enter a positive amount up to EUR 10,000." });
    }
    const senderId = canonicalTarget(parsed.data.senderId);
    const customer = billingView().find((entry) => entry.senderId === senderId);
    if (!customer) return reply.code(404).send({ ok: false, error: "That contact is not in the saved contact directory." });
    if (!deps.interactions.addDebt(senderId, parsed.data.amountCents)) {
      return reply.code(409).send({ ok: false, error: "The resulting billing balance exceeds the supported range." });
    }
    const updated = billingView().find((entry) => entry.senderId === senderId)!;
    return { ok: true, customer: updated } satisfies BillingChargeResponse;
  });
  app.post("/api/billing/payments", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z.object({
      senderId: z.string().trim().regex(/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/),
      amountCents: z.number().int().min(1).max(1_000_000),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "Select a contact and enter a positive amount up to EUR 10,000." });
    }
    const senderId = canonicalTarget(parsed.data.senderId);
    const customer = billingView().find((entry) => entry.senderId === senderId);
    if (!customer) return reply.code(404).send({ ok: false, error: "That contact is not in the saved contact directory." });
    if (!deps.interactions.removeDebt(senderId, parsed.data.amountCents)) {
      return reply.code(409).send({ ok: false, error: "The amount cannot exceed the outstanding fake debt." });
    }
    const updated = billingView().find((entry) => entry.senderId === senderId)!;
    return { ok: true, customer: updated } satisfies BillingChargeResponse;
  });

  app.get("/api/config", async (_req, reply) => {
    const config = deps.configStore.load();
    reply.header("ETag", revision(config));
    reply.header("Cache-Control", "no-store");
    return redactSecrets(config) satisfies BotConfig;
  });

  app.put("/api/config", async (req, reply) => {
    const current = deps.configStore.load();
    if (!req.headers["if-match"]) {
      return reply.code(428).send({ ok: false, error: "Reload configuration before saving." });
    }
    if (req.headers["if-match"] !== revision(current)) {
      return reply.code(412).send({ ok: false, error: "Configuration changed elsewhere. Reload before saving; your edits have not been applied." });
    }
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    const merged = restoreSecrets(parsed.data, current);
    const saved = deps.configStore.save(merged);
    deps.onConfigChange();
    reply.header("ETag", revision(saved));
    return { ok: true, config: redactSecrets(saved) } satisfies ConfigSaveResponse;
  });

  app.get("/api/chats", async () => ({ chats: deps.knownChats.list() } satisfies ChatsResponse));

  const petSnapshot = (pet: Pet | undefined) => pet ? {
    name: pet.name, species: pet.species, enabled: pet.enabled, paused: pet.paused,
    settings: petSettings(pet),
  } : null;
  const petView = (pet: Pet | undefined): GroupPet | null => pet ? {
    name: pet.name, species: pet.species, enabled: pet.enabled, paused: pet.paused,
    settings: petSettings(pet), stage: pet.stage, hunger: pet.hunger, happiness: pet.happiness,
    hydration: pet.hydration, cleanliness: pet.cleanliness,
    energy: pet.energy, hibernating: pet.hibernating, healthyDays: pet.healthyMs / 86_400_000,
    status: statusText(pet),
    evolution: deps.pets.evolutionStatus(pet),
    nextRequestActiveMinutes: Math.max(0, (pet.nextRequest - pet.clock) / 60_000),
    request: pet.request ? { kind: pet.request.kind, delivered: pet.request.startedAt !== null } : null,
  } : null;
  const petUpdateSchema = z.object({
    action: z.enum(["save", "enable", "disable", "pause", "resume"]),
    name: z.string().trim().min(1).max(40)
      .refine((name) => ![...name].some((c) => c.charCodeAt(0) < 32), "Use a single-line name.")
      .refine((name) => !/(?:^|\s)species=/i.test(name), "Choose species using the species selector, not the name."),
    species: z.string().refine((value) => value === "random" || isSpecies(value), "Unknown pet species."),
    settings: PetSettingsSchema,
  }).strict() satisfies z.ZodType<PetUpdate, z.ZodTypeDef, unknown>;

  const petActionView = (chatId: string): PetActionResponse => {
    const pet = deps.pets.store.get(chatId);
    const view = petView(pet);
    if (!view) throw new Error("Pet action completed without a saved pet");
    return { pet: view, revision: revision(petSnapshot(pet)) };
  };

  app.get("/api/pets", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const config = deps.configStore.load();
    const known = deps.knownChats.list();
    const groups = config.approvedSenders.filter((id) => id.endsWith("@g.us")).map((id) => {
      const pet = deps.pets.store.get(id);
      return { id, name: known.find((chat) => chat.id === id)?.name ?? id,
        pet: petView(pet), revision: revision(petSnapshot(pet)) };
    });
    return { groups, species: SPECIES, defaults: DEFAULT_PET_SETTINGS } satisfies PetsResponse;
  });

  app.post<{ Params: { chatId: string } }>("/api/pets/:chatId/request", async (req, reply) => {
    const chatId = req.params.chatId;
    if (!chatId.endsWith("@g.us") || !deps.configStore.load().approvedSenders.includes(chatId)) {
      return reply.code(403).send({ error: "This group must be approved before requesting a challenge." });
    }
    const requestSchema = z.object({
      kind: z.enum(["random", "feed", "water", "clean", "play", "silence"]).default("random"),
    }).strict() satisfies z.ZodType<PetRequest, z.ZodTypeDef, unknown>;
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Choose random, feed, water, clean, play or silence." });
    const result = deps.pets.requestNow(chatId, Date.now(), parsed.data.kind === "random" ? undefined : parsed.data.kind);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return reply.code(202).send(petActionView(chatId));
  });

  app.post<{ Params: { chatId: string } }>("/api/pets/:chatId/evolve", async (req, reply) => {
    const chatId = req.params.chatId;
    if (!chatId.endsWith("@g.us") || !deps.configStore.load().approvedSenders.includes(chatId)) {
      return reply.code(403).send({ error: "This group must be approved before evolving its pet." });
    }
    const evolutionSchema = z.object({
      expectedStage: z.number().int().min(0).max(4),
    }).strict() satisfies z.ZodType<PetEvolutionRequest, z.ZodTypeDef, unknown>;
    const parsed = evolutionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Provide the current pet stage (0-4). Reload pets and try again." });
    const result = deps.pets.evolveNow(chatId, parsed.data.expectedStage);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return petActionView(chatId);
  });

  app.put<{ Params: { chatId: string } }>("/api/pets/:chatId", async (req, reply) => {
    const chatId = req.params.chatId;
    if (!chatId.endsWith("@g.us") || !deps.configStore.load().approvedSenders.includes(chatId)) {
      return reply.code(403).send({ error: "Save this group's approval in Access before managing its pet." });
    }
    const current = deps.pets.store.get(chatId);
    if (!req.headers["if-match"]) return reply.code(428).send({ error: "Reload pets before saving." });
    if (req.headers["if-match"] !== revision(petSnapshot(current))) {
      return reply.code(412).send({ error: "Pet settings changed elsewhere. Reload pets before saving; your edits were not applied." });
    }
    const parsed = petUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
    const { action, name, species, settings } = parsed.data;
    if (!current && action !== "enable") return reply.code(404).send({ error: "Spawn a pet first." });
    if (current && species !== current.species) {
      return reply.code(409).send({ error: "An existing pet's species cannot be changed or rerolled." });
    }
    deps.pets.store.transaction(() => {
      if (action === "enable") {
        deps.pets.command(chatId, "enable", `${name}${species === "random" ? "" : ` species=${species}`}`);
      }
      deps.pets.configure(chatId, settings, name);
      if (action !== "save" && action !== "enable") deps.pets.command(chatId, action, "");
    });
    return petActionView(chatId);
  });

  const profileChatName = (chatId: string): string | null => {
    const aliases = new Set(contactDirectory().aliasesFor(chatId));
    return deps.knownChats.list().find((chat) => aliases.has(chat.id))?.name ?? null;
  };

  // Learned personality profiles belong to a person within one chat.
  app.get("/api/profiles", async () => {
    const profiles = deps.userProfiles.list().map((p) => ({
      ...p,
      chat_name: profileChatName(p.chat_id),
      messageCount: deps.userMemory.countSince(p.sender_key, 0),
    }));
    return { profiles } satisfies ProfilesResponse;
  });

  app.get<{ Params: { key: string } }>("/api/profiles/:key", async (req, reply) => {
    const profile = deps.userProfiles.get(req.params.key);
    if (!profile) {
      reply.code(404);
      return { ok: false, error: "No profile for that user yet." };
    }
    return { ...profile, chat_name: profileChatName(profile.chat_id),
      messageCount: deps.userMemory.countSince(profile.sender_key, 0) } satisfies ProfileDetail;
  });

  // Force an immediate rebuild (two LLM calls; the /api route allows long reads).
  app.post<{ Params: { key: string } }>("/api/profiles/:key/refresh", async (req, reply) => {
    const key = req.params.key;
    const name = deps.userProfiles.get(key)?.name ?? deps.userMemory.recentFor(key, 1)[0]?.name ?? key;
    try {
      const profile = await deps.profiler.requestRefresh(key, name);
      if (!profile) {
        reply.code(422);
        return { ok: false, error: "Not enough messages to build a profile yet." };
      }
      return { ok: true, profile: { ...profile, chat_name: profileChatName(profile.chat_id),
        messageCount: deps.userMemory.countSince(key, 0) } } satisfies ProfileRefreshResponse;
    } catch (err) {
      deps.logger.warn({ err, key }, "requested profile refresh failed");
      reply.code(err instanceof ProfileQueueError ? 503 : 502);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Forget this person's profile and messages in this chat only.
  app.delete<{ Params: { key: string } }>("/api/profiles/:key", async (req) => {
    deps.profiler.forget(req.params.key);
    return { ok: true };
  });

  // Wipe the trivia leaderboard (all chats).
  app.post("/api/trivia/reset", async () => {
    deps.triviaScores.clearAll();
    return { ok: true };
  });

  app.get("/api/leaderboards", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const sampledAt = Date.now();
    const directory = contactDirectory();
    const known = deps.knownChats.list();
    const chatIds = new Set<string>();
    const chatNames = new Map<string, string>();
    for (const c of known) {
      const canonical = directory.canonical(c.id);
      chatIds.add(canonical);
      if (c.name.trim()) chatNames.set(canonical, c.name);
    }
    for (const approved of deps.configStore.load().approvedSenders) {
      if (approved.includes("@")) chatIds.add(directory.canonical(approved));
    }
    const chats = [...chatIds]
      .sort((a, b) => (chatNames.get(a) ?? a).localeCompare(chatNames.get(b) ?? b) || a.localeCompare(b))
      .map((chatId) => ({
        chatId,
        chatName: chatNames.get(chatId) ?? null,
        trivia: {
          monthly: deps.triviaScores.top(chatId, 20, sampledAt).map(({ senderId, name, correct }) => ({ senderId, name, score: correct })),
          allTime: deps.triviaScores.allTime(chatId, 20).map(({ senderId, name, total }) => ({ senderId, name, score: total })),
          trophies: deps.triviaScores.trophies(chatId, 20),
          history: deps.triviaScores.history(chatId, 12),
        },
        duel: {
          monthly: (deps.duelScores?.top(chatId, 20, sampledAt) ?? []).map(({ senderId, name, wins }) => ({ senderId, name, score: wins })),
          allTime: (deps.duelScores?.allTime(chatId, 20) ?? []).map(({ senderId, name, total }) => ({ senderId, name, score: total })),
          trophies: deps.duelScores?.trophies(chatId, 20) ?? [],
          history: deps.duelScores?.history(chatId, 12) ?? [],
        },
        karma: (deps.karma?.top(chatId, 20) ?? []).map(({ senderId, name, points }) => ({ senderId, name, score: points })),
        participants: (deps.seenActivity?.people(chatId) ?? [])
          .map((p) => ({ senderId: p.sender_id, name: p.name, lastSeenAt: p.last_ts }))
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.name.localeCompare(b.name)),
      }));
    return { chats, sampledAt } satisfies LeaderboardsResponse;
  });

  // Award trophies for a month (default: last month) from the current scores, then reset them.
  app.post<{ Body?: { period?: string } }>("/api/trivia/close-month", async (req, reply) => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const period = req.body?.period ?? `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      reply.code(400);
      return { ok: false, error: "period must be YYYY-MM" };
    }
    deps.triviaScores.closeMonth(period, now.getTime());
    return { ok: true, period };
  });

  // Re-pull the WhatsApp address book + chats on the live session (no re-link).
  app.post("/api/resync", async (_req, reply) => {
    try {
      await deps.transport.resyncContacts();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: String(err) };
    }
  });

  // Wipe the current WhatsApp session and reconnect so a fresh QR / pairing code
  // is issued. Recovery path when the link goes stale (device logged out).
  app.post("/api/relink", async (_req, reply) => {
    try {
      await deps.transport.relink();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: String(err) };
    }
  });

  // List models available on the configured local Ollama instance.
  app.get("/api/ollama/models", async (_req, reply) => {
    const r = await ollamaListModels(deps.configStore.load());
    if (!r.ok) {
      reply.code(502);
      return { ok: false, models: [] as string[] };
    }
    return { ok: true, models: r.models };
  });

  // Reachability check for the configured ComfyUI backend (bot.paint / bot.film).
  app.get("/api/comfyui/status", async (_req, reply) => {
    const base = deps.configStore.load().paintBaseUrl.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        reply.code(502);
        return { ok: false, reachable: false };
      }
      const data = (await res.json()) as { system?: { comfyui_version?: string } };
      return { ok: true, reachable: true, version: data?.system?.comfyui_version ?? null };
    } catch (err) {
      reply.code(502);
      return { ok: false, reachable: false, error: String(err) };
    }
  });

  app.post("/api/pair", async (req, reply) => {
    const body = req.body as { phoneNumber?: string } | undefined;
    if (!body?.phoneNumber) {
      reply.code(400);
      return { ok: false, error: "phoneNumber required" };
    }
    try {
      const code = await deps.transport.requestPairingCode(body.phoneNumber);
      return { ok: true, code };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: String(err) };
    }
  });

  // Server-Sent Events: push live connection status (state, QR, pairing code).
  app.get("/api/events", (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let closed = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      reply.raw.end();
    };
    const send = (data: unknown) => {
      if (!closed && !reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)) close();
    };
    unsubscribe = deps.transport.onStatus(send);
    streams.add(close);
    reply.raw.on("close", close);
    reply.raw.on("error", close);
    const heartbeat = setInterval(() => { if (!reply.raw.write(": heartbeat\n\n")) close(); }, 15_000);
    heartbeat.unref();
    send(deps.transport.getStatus());
  });

  return app;
}

export async function startApi(deps: ApiDeps, port: number): Promise<FastifyInstance> {
  const app = await createApi(deps);
  await app.listen({ host: deps.apiToken ? "0.0.0.0" : "127.0.0.1", port });
  deps.logger.info({ port }, "API listening");
  return app;
}
