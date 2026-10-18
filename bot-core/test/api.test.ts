import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createApi, type ApiDeps } from "../src/api/server.js";
import { openDatabase } from "../src/state/db.js";
import { ConfigStore, ContactsStore, KnownChatsStore, SiestaDisciplineStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileQueueError, ProfileService } from "../src/handlers/profiles/service.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import { DEFAULT_PET_SETTINGS } from "../src/pets/settings.js";
import { RuntimeState } from "../src/state/runtime.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { REDACTED } from "../src/config/secrets.js";
import type { BotConfig, ConfigSaveResponse, ProfileDetail, ProfilesResponse } from "../../shared/api.js";
import type { OperationsResponse } from "../../shared/api.js";
import { memoryKey } from "../src/state/identity.js";
import { OutboxStore } from "../src/state/outbox.js";
import { BackupWorker } from "../src/state/backups.js";

const ALICE = memoryKey("group@g.us", "alice");
const ALICE_PATH = `/api/profiles/${encodeURIComponent(ALICE)}`;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(apiToken: string | undefined = "test-token") {
  const db = openDatabase(":memory:");
  const listeners = new Set<(status: unknown) => void>();
  const logger = pino({ level: "silent" });
  const runtime = new RuntimeState();
  const userMemory = new UserMemoryStore(db);
  const userProfiles = new UserProfileStore(db);
  const configStore = new ConfigStore(db);
  const discipline = new SiestaDisciplineStore(db);
  const jobs = new BackgroundJobs(() => {});
  const profiler = new ProfileService(userMemory, userProfiles, jobs, () => configStore.load(), logger);
  const deps: ApiDeps = {
    apiToken,
    jobs, outbox: new OutboxStore(db),
    backups: new BackupWorker(db, { retentionDays: 14 }, logger),
    configStore, knownChats: new KnownChatsStore(db),
    triviaScores: new TriviaScoreStore(db), userMemory, userProfiles, profiler, logger,
    pets: new PetService(new PetStore(db), () => configStore.load(), () => true),
    runtime,
    discipline,
    contacts: new ContactsStore(db),
    onConfigChange: vi.fn(),
    transport: {
      getStatus: () => ({ state: "open", health: "online", qrDataUrl: null, pairingCode: null, me: null, lastActivityAt: null }),
      onStatus: (listener: (status: unknown) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } as ApiDeps["transport"],
  };
  const app = await createApi(deps);
  cleanup.push(async () => { await jobs.stop(); runtime.dispose(); await app.close(); db.close(); });
  return { app, deps, listeners, runtime, discipline, jobs, db };
}

describe("profile lifecycle controls", () => {
  const headers = { authorization: "Bearer test-token" };

  it("queues a dashboard refresh behind other inference work", async () => {
    const { app, deps, jobs } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jobs.submit("chat", () => gate);
    const refresh = vi.spyOn(deps.profiler, "refresh").mockResolvedValue(null);
    const requested = vi.spyOn(deps.profiler, "requestRefresh");
    const response = app.inject({ method: "POST", url: `${ALICE_PATH}/refresh`, headers });
    const pending = Promise.resolve(response);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());
    expect(refresh).not.toHaveBeenCalled();
    release();
    expect((await pending).statusCode).toBe(422);
    expect(refresh).toHaveBeenCalledOnce();
  });

  describe("operations API", () => {
    it("authenticates service diagnostics before checking services and isolates failures from operations", async () => {
      const { app } = await setup();
      const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ models: [] }));
      try {
        expect((await app.inject({ url: "/api/operations/services" })).statusCode).toBe(401);
        expect(fetcher).not.toHaveBeenCalled();
        const response = await app.inject({ url: "/api/operations/services", headers });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({
          cacheSeconds: 30, services: [
            { service: "ollama", status: "available" },
            { service: "comfyui", status: "disabled" },
            { service: "transcription", status: "invalid-response" },
          ],
        });
        expect(response.body).not.toContain(DEFAULT_CONFIG.ollamaBaseUrl);
        await app.inject({ url: "/api/operations/services", headers });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect((await app.inject({ url: "/api/operations", headers })).statusCode).toBe(200);
      } finally { fetcher.mockRestore(); }
    });
    it("requires authentication, disables caching and exposes metadata without content or raw errors", async () => {
      const { app, deps, jobs, db } = await setup();
      expect((await app.inject({ url: "/api/operations" })).statusCode).toBe(401);
      db.prepare(`INSERT INTO outbox(chat_id,body,status,attempts,available_at,created_at,last_error,last_failure_at)
        VALUES ('SECRET-CHAT','SECRET-BODY','failed',5,10,0,'SECRET-ERROR',10)`).run();
      jobs.submit("SECRET-KEY", async () => { throw new Error("SECRET-PROMPT"); });
      await jobs.stop();
      const response = await app.inject({ url: "/api/operations", headers: { authorization: "Bearer test-token" } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const data = response.json<OperationsResponse>();
      expect(data).toMatchObject({
        sampledAt: expect.any(Number), startedAt: expect.any(Number), deliveryReady: true,
        jobs: { failed: 1, accepting: false }, outbox: { counts: { failed: 1 }, recentFailures: [{ attempts: 5 }] },
      });
      expect(data.startedAt).toBeLessThanOrEqual(data.sampledAt);
      expect(data.backups).toEqual({
        enabled: false, running: false, intervalHours: 24, retentionDays: 14, nextRunAt: null,
        lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null, lastSizeBytes: null,
      });
      expect(response.body).not.toContain("SECRET");
      vi.spyOn(deps.transport, "getStatus").mockReturnValue({
        state: "close", health: "unknown", qrDataUrl: null, pairingCode: null, me: null, lastActivityAt: null,
      });

      expect((await app.inject({ url: "/api/operations", headers: { authorization: "Bearer test-token" } })).json<OperationsResponse>().deliveryReady).toBe(false);
    });

    it("exposes verified backup and failure metadata without filesystem paths or raw diagnostics", async () => {
      const { app, deps } = await setup();
      const snapshot = {
        ...deps.backups.snapshot(), enabled: true, lastSuccessAt: 1000, lastAttemptAt: 2000,
        lastFailureAt: 2001, lastError: "prune" as const, lastSizeBytes: 4096, nextRunAt: 86402000,
      };
      vi.spyOn(deps.backups, "snapshot").mockReturnValue(snapshot);
      const response = await app.inject({ url: "/api/operations", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json<OperationsResponse>().backups).toEqual(snapshot);
      expect(Object.keys(response.json<OperationsResponse>().backups).sort()).toEqual([
        "enabled", "intervalHours", "lastAttemptAt", "lastError", "lastFailureAt",
        "lastSizeBytes", "lastSuccessAt", "nextRunAt", "retentionDays", "running",
      ]);
    });
  });

  it("reports a busy queue as a retryable failure", async () => {
    const { app, deps } = await setup();
    vi.spyOn(deps.profiler, "requestRefresh").mockRejectedValue(new ProfileQueueError());
    const response = await app.inject({ method: "POST", url: `${ALICE_PATH}/refresh`, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("Try again");
  });

  it("delegates forgetting to the service that invalidates outstanding work", async () => {
    const { app, deps } = await setup();
    deps.userMemory.record(ALICE, "Alice", null, "a remembered message", 50);
    deps.userProfiles.upsert({ sender_key: ALICE, name: "Alice", deep: "deep", short: "short", last_profiled_id: 0 });
    const other = memoryKey("other@g.us", "alice");
    deps.userMemory.record(other, "Alice", null, "another chat", 50);
    deps.userProfiles.upsert({ sender_key: other, name: "Alice", deep: "other deep", short: "other short", last_profiled_id: 0 });
    const forget = vi.spyOn(deps.profiler, "forget");
    const response = await app.inject({ method: "DELETE", url: ALICE_PATH, headers });
    expect(response.statusCode).toBe(200);
    expect(forget).toHaveBeenCalledWith(ALICE);
    expect(deps.userMemory.countSince(ALICE, 0)).toBe(0);
    expect(deps.userProfiles.get(ALICE)).toBeUndefined();
    expect(deps.userMemory.countSince(other, 0)).toBe(1);
    expect(deps.userProfiles.get(other)?.deep).toBe("other deep");
  });
});

describe("API authentication", () => {
  it("fails closed without a token", async () => {
    await expect(createApi({} as ApiDeps)).rejects.toThrow("API_TOKEN");
  });

  it("requires a bearer token for reads and mutations", async () => {
    const { app } = await setup();
    for (const method of ["GET", "PUT"] as const) {
      expect((await app.inject({ method, url: "/api/config" })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/api/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/status", headers: { authorization: "Bearer test-token" } })).statusCode).toBe(200);
  });

  it("never accepts a secret in a URL", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/events?token=test-token" })).statusCode).toBe(401);
  });

  it("does not grant cross-origin access", async () => {
    const { app } = await setup();
    const response = await app.inject({ url: "/api/status", headers: { authorization: "Bearer test-token", origin: "https://other.example" } });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unsubscribes disconnected status streams and closes active streams on shutdown", async () => {
    const { app, listeners } = await setup();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, {
      headers: { authorization: "Bearer test-token" }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(listeners.size).toBe(1);
    controller.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    const second = await fetch(`${address}/api/events`, { headers: { authorization: "Bearer test-token" } });
    expect(listeners.size).toBe(1);
    await app.close();
    expect(listeners.size).toBe(0);
    await second.body!.cancel();
  });
});

describe("siesta controls", () => {
  const headers = { authorization: "Bearer test-token" };

  it("reports and cancels an active siesta through the authenticated API", async () => {
    const { app, runtime } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/siesta/cancel" })).statusCode).toBe(401);
    runtime.siestaUntil = Date.now() + 60_000;
    const status = await app.inject({ url: "/api/siesta", headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ sleeping: true, until: runtime.siestaUntil });

    const cancelled = await app.inject({ method: "POST", url: "/api/siesta/cancel", headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true, cancelled: true });
    expect(runtime.isSleeping()).toBe(false);
    expect((await app.inject({ url: "/api/siesta", headers })).json()).toEqual({ sleeping: false, until: null });
  });

  it("reports cancellation as a no-op when no siesta is active", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "POST", url: "/api/siesta/cancel", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, cancelled: false });
  });
});

describe("sleep discipline controls", () => {
  const headers = { authorization: "Bearer test-token" };

  it("requires authentication", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/discipline" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/discipline/sleep" })).statusCode).toBe(401);
  });

  it("puts a player to sleep, lists them, and wakes them", async () => {
    const { app, discipline } = await setup();
    const body = { chatId: "group@g.us", senderId: "34600@s.whatsapp.net", minutes: 10 };
    const slept = await app.inject({ method: "POST", url: "/api/discipline/sleep", headers, payload: body });
    expect(slept.statusCode).toBe(200);
    expect(slept.json().players).toHaveLength(1);
    expect(discipline.sleepUntil(body.chatId, body.senderId)).toBeGreaterThan(Date.now());

    const list = await app.inject({ url: "/api/discipline", headers });
    expect(list.json().players[0]).toMatchObject({ chatId: body.chatId, senderId: body.senderId, armed: false });
    expect(list.json().players[0].sleepUntil).toBeGreaterThan(Date.now());

    const woken = await app.inject({ method: "POST", url: "/api/discipline/wake", headers, payload: { chatId: body.chatId, senderId: body.senderId } });
    expect(woken.json().players).toHaveLength(0);
    expect(discipline.sleepUntil(body.chatId, body.senderId)).toBeNull();
  });

  it("arms a player and validates request bodies", async () => {
    const { app, discipline } = await setup();
    const target = { chatId: "group@g.us", senderId: "34601@s.whatsapp.net" };
    const armed = await app.inject({ method: "POST", url: "/api/discipline/arm", headers, payload: target });
    expect(armed.statusCode).toBe(200);
    expect(discipline.isArmed(target.chatId, target.senderId)).toBe(true);
    expect(armed.json().players[0]).toMatchObject({ ...target, armed: true, sleepUntil: null });

    const bad = await app.inject({ method: "POST", url: "/api/discipline/sleep", headers, payload: { chatId: "c", senderId: "s", minutes: 999 } });
    expect(bad.statusCode).toBe(400);
  });

  it("resolves a player's display name from synced contacts", async () => {
    const { app, deps } = await setup();
    deps.contacts.upsertMany([{ jid: "34602@s.whatsapp.net", phone: "34602", name: "Alice" }]);
    await app.inject({ method: "POST", url: "/api/discipline/arm", headers, payload: { chatId: "group@g.us", senderId: "34602@s.whatsapp.net" } });
    const list = await app.inject({ url: "/api/discipline", headers });
    expect(list.json().players[0]).toMatchObject({ senderId: "34602@s.whatsapp.net", displayName: "Alice" });

    const contacts = await app.inject({ url: "/api/contacts", headers });
    expect(contacts.json().contacts).toEqual([{ jid: "34602@s.whatsapp.net", name: "Alice", phone: "34602" }]);
  });
});

describe("configuration revisions", () => {
  it("validates and persists retention settings through the revision-protected config API", async () => {
    const { app, deps } = await setup();
    const headers = { authorization: "Bearer test-token" };
    const loaded = await app.inject({ url: "/api/config", headers });
    const original = loaded.json<BotConfig>();
    const updateHeaders = { ...headers, "if-match": loaded.headers.etag! };
    for (const patch of [{ analyticsRetentionDays: 0 }, { deliveryRetentionDays: 1.5 }, { retentionEnabled: "yes" }]) {
      const rejected = await app.inject({ method: "PUT", url: "/api/config", headers: updateHeaders, payload: { ...original, ...patch } });
      expect(rejected.statusCode).toBe(400);
      expect(deps.configStore.load()).toEqual(original);
    }
    const policy = { retentionEnabled: false, analyticsRetentionDays: 180, deliveryRetentionDays: 60 };
    const saved = await app.inject({ method: "PUT", url: "/api/config", headers: updateHeaders, payload: { ...original, ...policy } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ConfigSaveResponse>().config).toMatchObject(policy);
    expect(deps.configStore.load()).toMatchObject(policy);
    expect((await app.inject({ url: "/api/config", headers })).json<BotConfig>()).toMatchObject(policy);
  });
  it("preserves the raw config GET, save envelope, secrets and revision headers", async () => {
    const { app, deps } = await setup();
    const headers = { authorization: "Bearer test-token" };
    deps.configStore.save({ ...DEFAULT_CONFIG, redditClientSecret: "stored-secret", redditRefreshToken: "stored-refresh" });
    const loaded = await app.inject({ url: "/api/config", headers });
    expect(loaded.statusCode).toBe(200);
    const config = loaded.json<BotConfig>();
    expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
    expect(config.redditClientSecret).toBe(REDACTED);
    expect(config.redditRefreshToken).toBe(REDACTED);
    expect(config).not.toHaveProperty("revision");
    expect(loaded.headers.etag).toMatch(/^".+"$/);
    const saved = await app.inject({
      method: "PUT", url: "/api/config", headers: { ...headers, "if-match": loaded.headers.etag! },
      payload: { ...config, botReplyPrefix: "Updated:" },
    });
    expect(saved.statusCode).toBe(200);
    const result = saved.json<ConfigSaveResponse>();
    expect(result).toEqual({ ok: true, config: { ...config, botReplyPrefix: "Updated:" } });
    expect(saved.headers.etag).not.toBe(loaded.headers.etag);
    expect(deps.configStore.load().redditClientSecret).toBe("stored-secret");
  });

  it("rejects missing and stale revisions without overwriting configuration", async () => {
    const { app } = await setup();
    const headers = { authorization: "Bearer test-token" };
    const loaded = await app.inject({ url: "/api/config", headers });
    const config = loaded.json();
    expect((await app.inject({ method: "PUT", url: "/api/config", headers, payload: config })).statusCode).toBe(428);
    const first = await app.inject({ method: "PUT", url: "/api/config", headers: { ...headers, "if-match": loaded.headers.etag! }, payload: { ...config, botReplyPrefix: "changed" } });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({ method: "PUT", url: "/api/config", headers: { ...headers, "if-match": loaded.headers.etag! }, payload: config });
    expect(stale.statusCode).toBe(412);
    expect((await app.inject({ url: "/api/config", headers })).json().botReplyPrefix).toBe("changed");
  });

  describe("profile wire contracts", () => {
    it("lists summaries and returns the full existing detail payload", async () => {
      const { app, deps } = await setup();
      const headers = { authorization: "Bearer test-token" };
      deps.userMemory.record(ALICE, "Alice", null, "Remember this message", 50);
      deps.userProfiles.upsert({ sender_key: ALICE, name: "Alice", deep: "A dossier", short: "A summary", last_profiled_id: 1 });
      const list = await app.inject({ url: "/api/profiles", headers });
      const summary = list.json<ProfilesResponse>().profiles[0];
      expect(summary).toMatchObject({ sender_key: ALICE, chat_id: "group@g.us", chat_name: null, name: "Alice", short: "A summary", messageCount: 1 });
      expect(summary).not.toHaveProperty("deep");
      expect(summary).not.toHaveProperty("last_profiled_id");
      const detail = await app.inject({ url: ALICE_PATH, headers });
      expect(detail.json<ProfileDetail>()).toEqual({ ...summary, deep: "A dossier", last_profiled_id: 1 });
    });

    it("keeps duplicate chat names distinct and uses current names for list/detail/refresh", async () => {
      const { app, deps } = await setup();
      const headers = { authorization: "Bearer test-token" };
      const other = memoryKey("other@g.us", "alice");
      deps.knownChats.upsert([{ id: "group@g.us", name: "Friends" }, { id: "other@g.us", name: "Friends" }]);
      for (const key of [ALICE, other]) {
        deps.userProfiles.upsert({ sender_key: key, name: "Alice", deep: key === ALICE ? "local" : "other", short: "summary", last_profiled_id: 0 });
        deps.userMemory.record(key, "Alice", "Friends", "message", 50);
      }
      const list = (await app.inject({ url: "/api/profiles", headers })).json<ProfilesResponse>();
      expect(list.profiles).toHaveLength(2);
      expect(new Set(list.profiles.map((p) => p.sender_key)).size).toBe(2);
      expect(list.profiles.every((p) => p.chat_name === "Friends" && p.messageCount === 1)).toBe(true);
      deps.knownChats.upsert([{ id: "group@g.us", name: "Renamed" }]);
      const detail = (await app.inject({ url: ALICE_PATH, headers })).json<ProfileDetail>();
      expect(detail).toMatchObject({ sender_key: ALICE, chat_id: "group@g.us", chat_name: "Renamed", deep: "local" });
      const stored = deps.userProfiles.get(ALICE)!;
      const refresh = vi.spyOn(deps.profiler, "requestRefresh").mockResolvedValue(stored);
      const refreshed = await app.inject({ method: "POST", url: `${ALICE_PATH}/refresh`, headers });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toEqual({ ok: true, profile: detail });
      expect(refresh).toHaveBeenCalledWith(ALICE, "Alice");
    });
  });

  describe("group pet dashboard", () => {
    const headers = { authorization: "Bearer test-token" };
    const chatId = "pets@g.us";
    const url = `/api/pets/${encodeURIComponent(chatId)}`;
    const payload = { action: "enable", name: "Mochi", species: "fox", settings: DEFAULT_PET_SETTINGS };

    async function approved() {
      const s = await setup();
      s.deps.configStore.save({ ...s.deps.configStore.load(), approvedSenders: [chatId, "123@s.whatsapp.net"] });
      s.deps.knownChats.upsert([{ id: chatId, name: "Pet Club" }]);
      const list = (await s.app.inject({ url: "/api/pets", headers })).json();
      return { ...s, revision: list.groups[0].revision as string };
    }

    it("authenticates manual requests and rejects duplicate or unapproved challenges", async () => {
      const { app, deps, revision } = await approved();
      const requestUrl = `${url}/request`;
      expect((await app.inject({ method: "POST", url: requestUrl })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: requestUrl, headers })).statusCode).toBe(409);
      await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision }, payload });
      const requested = await app.inject({ method: "POST", url: requestUrl, headers });
      expect(requested.statusCode).toBe(202);
      expect(["feed", "water", "clean"]).toContain(requested.json().pet.request.kind);
      expect(requested.json().pet.request.delivered).toBe(false);
      expect((await app.inject({ method: "POST", url: requestUrl, headers })).statusCode).toBe(409);
      deps.configStore.save({ ...deps.configStore.load(), approvedSenders: [] });
      expect((await app.inject({ method: "POST", url: requestUrl, headers })).statusCode).toBe(403);
    });

    it("exposes evolution progress and permits one confirmed-stage evolution, not a stale replay", async () => {
      const { app, revision } = await approved();
      const evolveUrl = `${url}/evolve`;
      expect((await app.inject({ method: "POST", url: evolveUrl, payload: { expectedStage: 0 } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: evolveUrl, headers, payload: { expectedStage: 0 } })).statusCode).toBe(409);
      await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision }, payload });
      const listed = (await app.inject({ url: "/api/pets", headers })).json();
      expect(listed.groups[0].pet.evolution).toMatchObject({
        nextForm: "Ember Kit", running: true, canForce: true,
      });
      expect(listed.groups[0].pet.evolution.remainingHealthyMs).toBeGreaterThan(86400000 - 1000);
      expect(listed.groups[0].pet.evolution.remainingHealthyMs).toBeLessThanOrEqual(86400000);
      expect((await app.inject({ method: "POST", url: evolveUrl, headers, payload: { expectedStage: 5 } })).statusCode).toBe(400);
      const evolved = await app.inject({ method: "POST", url: evolveUrl, headers, payload: { expectedStage: 0 } });
      expect(evolved.statusCode).toBe(200);
      expect(evolved.json().pet).toMatchObject({
        stage: 1, healthyDays: 1, evolution: { nextForm: "Spark Fox", remainingHealthyMs: 6 * 86400000 },
      });
      expect((await app.inject({ method: "POST", url: evolveUrl, headers, payload: { expectedStage: 0 } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/pets/unknown@g.us/evolve", headers, payload: { expectedStage: 0 } })).statusCode).toBe(403);
    });

    it.each(["feed", "water", "clean", "play", "silence"])("accepts explicit %s requests regardless of stage", async (kind) => {
      const { app, revision } = await approved();
      await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision }, payload });
      const invalid = await app.inject({ method: "POST", url: `${url}/request`, headers, payload: { kind: "invalid" } });
      expect(invalid.statusCode).toBe(400);
      const requested = await app.inject({ method: "POST", url: `${url}/request`, headers, payload: { kind } });
      expect(requested.statusCode).toBe(202);
      expect(requested.json().pet).toMatchObject({ stage: 0, request: { kind, delivered: false } });
    });

    it("requires auth and lists only saved approved groups", async () => {
      const { app } = await approved();
      expect((await app.inject({ url: "/api/pets" })).statusCode).toBe(401);
      const list = (await app.inject({ url: "/api/pets", headers })).json();
      expect(list.groups).toHaveLength(1);
      expect(list.groups[0]).toMatchObject({ id: chatId, name: "Pet Club", pet: null });
      expect(list.defaults).toEqual(DEFAULT_PET_SETTINGS);
    });

    it("spawns with selected settings, preserves progress and supports pause/resume/disable", async () => {
      const { app, deps, revision } = await approved();
      const response = await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision },
        payload: { ...payload, settings: { ...DEFAULT_PET_SETTINGS, firstRequestMinutes: 5, maxRequestsPerDay: 8 } } });
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.pet).toMatchObject({ name: "Mochi", species: "fox", enabled: true });
      expect(result.pet.nextRequestActiveMinutes).toBeCloseTo(5, 2);
      expect(result.pet.hydration).toBeCloseTo(100, 4);
      expect(result.pet.cleanliness).toBeCloseTo(100, 4);
      expect(deps.pets.store.get(chatId)?.maxRequestsPerDay).toBe(8);
      let rev = result.revision;
      for (const action of ["pause", "resume", "disable", "enable"]) {
        const update = await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": rev },
          payload: { ...payload, action } });
        expect(update.statusCode).toBe(200);
        rev = update.json().revision;
        expect(update.json().pet.enabled).toBe(action !== "disable");
        expect(update.json().pet.paused).toBe(action === "pause");
      }
    });

    it("rejects stale revisions, unsaved approvals and invalid values without mutation", async () => {
      const { app, deps, revision } = await approved();
      expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(428);
      expect((await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": "stale" }, payload })).statusCode).toBe(412);
      for (const settings of [
        { ...DEFAULT_PET_SETTINGS, requestMinHours: 20, requestMaxHours: 4 },
        { ...DEFAULT_PET_SETTINGS, maxRequestsPerDay: 25 },
        { ...DEFAULT_PET_SETTINGS, wakeStart: 8, wakeEnd: 8 },
        { ...DEFAULT_PET_SETTINGS, silenceMinutes: 0 },
      ]) {
        expect((await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision },
          payload: { ...payload, settings } })).statusCode).toBe(400);
      }
      expect(deps.pets.store.get(chatId)).toBeUndefined();
      deps.configStore.save({ ...deps.configStore.load(), approvedSenders: [] });
      expect((await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision }, payload })).statusCode).toBe(403);
    });

    it("keeps revisions stable across stat ticks but detects in-chat changes", async () => {
      const { app, deps, revision } = await approved();
      const created = (await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": revision }, payload })).json();
      deps.pets.tick(Date.now() + 1000);
      const saved = await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": created.revision }, payload: { ...payload, action: "save" } });
      expect(saved.statusCode).toBe(200);
      deps.pets.command(chatId, "hours", "9 23");
      expect((await app.inject({ method: "PUT", url, headers: { ...headers, "if-match": saved.json().revision },
        payload: { ...payload, action: "save" } })).statusCode).toBe(412);
    });
  });
});