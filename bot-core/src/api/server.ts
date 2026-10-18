import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { ConfigSchema } from "../config/schema.js";
import { redactSecrets, restoreSecrets } from "../config/secrets.js";
import type { ConfigStore, ContactsStore, KnownChatsStore, SiestaDisciplineStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../state/repos.js";
import { disciplineKey } from "../state/repos.js";
import type { ProfileService } from "../handlers/profiles/service.js";
import { ProfileQueueError } from "../handlers/profiles/service.js";
import type { Transport } from "../transport/types.js";
import { ollamaListModels } from "../util/ollama.js";
import { z } from "zod";
import type { PetService } from "../pets/service.js";
import { SPECIES, isSpecies, statusText, type Pet } from "../pets/model.js";
import { DEFAULT_PET_SETTINGS, PetSettingsSchema, petSettings } from "../pets/settings.js";
import type { RuntimeState } from "../state/runtime.js";

export interface ApiDeps {
  transport: Transport;
  configStore: ConfigStore;
  knownChats: KnownChatsStore;
  triviaScores: TriviaScoreStore;
  userMemory: UserMemoryStore;
  userProfiles: UserProfileStore;
  profiler: ProfileService;
  pets: PetService;
  runtime: RuntimeState;
  discipline: SiestaDisciplineStore;
  contacts: ContactsStore;
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

  app.get("/api/status", async () => deps.transport.getStatus());
  app.get("/api/health", async () => ({ ok: true, connection: deps.transport.getStatus().state }));
  app.get("/api/siesta", async () => ({
    sleeping: deps.runtime.isSleeping(),
    until: deps.runtime.isSleeping() ? deps.runtime.siestaUntil : null,
  }));
  app.post("/api/siesta/cancel", async () => ({
    ok: true,
    cancelled: deps.runtime.cancelSiesta(),
  }));

  // Forced-sleep discipline: list sleeping/armed players and manage their state.
  // Resolve a friendly name for a sender JID from the synced contacts (exact JID
  // first, then by phone digits), falling back to null so the UI can show the JID.
  const resolveName = (jid: string): string | null => {
    const contacts = deps.contacts.all();
    const direct = contacts.find((c) => c.jid === jid);
    if (direct?.name) return direct.name;
    const digits = jid.split("@")[0].replace(/\D/g, "");
    if (digits) {
      const byPhone = contacts.find((c) => c.phone && c.phone.replace(/\D/g, "") === digits);
      if (byPhone?.name) return byPhone.name;
    }
    return null;
  };
  // Collapse a dashboard-supplied JID to the same identity the bot sees at message
  // time (phone-based), using the contact's phone when the JID is a LID.
  const canonicalTarget = (jid: string): string => {
    const contact = deps.contacts.all().find((c) => c.jid === jid);
    const phone = contact?.phone ?? (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : "");
    return disciplineKey(jid, phone);
  };
  const disciplineView = (now = Date.now()) => {
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
  const disciplineTarget = z.object({ chatId: z.string().min(1), senderId: z.string().min(1) });
  const disciplineSleep = disciplineTarget.extend({ minutes: z.number().int().min(1).max(60) });

  app.get("/api/discipline", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { players: disciplineView() };
  });
  app.post("/api/discipline/sleep", async (req, reply) => {
    const parsed = disciplineSleep.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    const { chatId, senderId, minutes } = parsed.data;
    deps.discipline.putToSleep(chatId, canonicalTarget(senderId), Date.now() + minutes * 60_000);
    return { ok: true, players: disciplineView() };
  });
  app.post("/api/discipline/arm", async (req, reply) => {
    const parsed = disciplineTarget.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    deps.discipline.arm(parsed.data.chatId, canonicalTarget(parsed.data.senderId));
    return { ok: true, players: disciplineView() };
  });
  app.post("/api/discipline/wake", async (req, reply) => {
    const parsed = disciplineTarget.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    deps.discipline.wake(parsed.data.chatId, canonicalTarget(parsed.data.senderId));
    return { ok: true, players: disciplineView() };
  });

  // Known contacts (JID + display name + phone) for the dashboard's player picker.
  app.get("/api/contacts", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const contacts = deps.contacts.all()
      .filter((c) => c.name.trim())
      .map((c) => ({ jid: c.jid, name: c.name, phone: c.phone }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { contacts };
  });

  app.get("/api/config", async (_req, reply) => {
    const config = deps.configStore.load();
    reply.header("ETag", revision(config));
    reply.header("Cache-Control", "no-store");
    return redactSecrets(config);
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
    return { ok: true, config: redactSecrets(saved) };
  });

  app.get("/api/chats", async () => ({ chats: deps.knownChats.list() }));

  const petSnapshot = (pet: Pet | undefined) => pet ? {
    name: pet.name, species: pet.species, enabled: pet.enabled, paused: pet.paused,
    settings: petSettings(pet),
  } : null;
  const petView = (pet: Pet | undefined) => pet ? {
    ...petSnapshot(pet), stage: pet.stage, hunger: pet.hunger, happiness: pet.happiness,
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
  }).strict();

  app.get("/api/pets", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const config = deps.configStore.load();
    const known = deps.knownChats.list();
    const groups = config.approvedSenders.filter((id) => id.endsWith("@g.us")).map((id) => {
      const pet = deps.pets.store.get(id);
      return { id, name: known.find((chat) => chat.id === id)?.name ?? id,
        pet: petView(pet), revision: revision(petSnapshot(pet)) };
    });
    return { groups, species: SPECIES, defaults: DEFAULT_PET_SETTINGS };
  });

  app.post<{ Params: { chatId: string } }>("/api/pets/:chatId/request", async (req, reply) => {
    const chatId = req.params.chatId;
    if (!chatId.endsWith("@g.us") || !deps.configStore.load().approvedSenders.includes(chatId)) {
      return reply.code(403).send({ error: "This group must be approved before requesting a challenge." });
    }
    const parsed = z.object({
      kind: z.enum(["random", "feed", "water", "clean", "play", "silence"]).default("random"),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Choose random, feed, water, clean, play or silence." });
    const result = deps.pets.requestNow(chatId, Date.now(), parsed.data.kind === "random" ? undefined : parsed.data.kind);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    const pet = deps.pets.store.get(chatId);
    return reply.code(202).send({ pet: petView(pet), revision: revision(petSnapshot(pet)) });
  });

  app.post<{ Params: { chatId: string } }>("/api/pets/:chatId/evolve", async (req, reply) => {
    const chatId = req.params.chatId;
    if (!chatId.endsWith("@g.us") || !deps.configStore.load().approvedSenders.includes(chatId)) {
      return reply.code(403).send({ error: "This group must be approved before evolving its pet." });
    }
    const parsed = z.object({ expectedStage: z.number().int().min(0).max(4) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Provide the current pet stage (0-4). Reload pets and try again." });
    const result = deps.pets.evolveNow(chatId, parsed.data.expectedStage);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    const pet = deps.pets.store.get(chatId);
    return { pet: petView(pet), revision: revision(petSnapshot(pet)) };
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
    const saved = deps.pets.store.get(chatId);
    return { pet: petView(saved), revision: revision(petSnapshot(saved)) };
  });

  // Learned personality profiles (deep dossier + short briefing) per user.
  app.get("/api/profiles", async () => {
    const profiles = deps.userProfiles.list().map((p) => ({
      ...p,
      messageCount: deps.userMemory.countSince(p.sender_key, 0),
    }));
    return { profiles };
  });

  app.get<{ Params: { key: string } }>("/api/profiles/:key", async (req, reply) => {
    const profile = deps.userProfiles.get(req.params.key);
    if (!profile) {
      reply.code(404);
      return { ok: false, error: "No profile for that user yet." };
    }
    return { ...profile, messageCount: deps.userMemory.countSince(profile.sender_key, 0) };
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
      return { ok: true, profile: { ...profile, messageCount: deps.userMemory.countSince(key, 0) } };
    } catch (err) {
      deps.logger.warn({ err, key }, "requested profile refresh failed");
      reply.code(err instanceof ProfileQueueError ? 503 : 502);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Forget a user: drop their profile and recorded messages.
  app.delete<{ Params: { key: string } }>("/api/profiles/:key", async (req) => {
    deps.profiler.forget(req.params.key);
    return { ok: true };
  });

  // Wipe the trivia leaderboard (all chats).
  app.post("/api/trivia/reset", async () => {
    deps.triviaScores.clearAll();
    return { ok: true };
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
