import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createApi, type ApiDeps } from "../src/api/server.js";
import { openDatabase } from "../src/state/db.js";
import { ConfigStore, KnownChatsStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import { DEFAULT_PET_SETTINGS } from "../src/pets/settings.js";
import { RuntimeState } from "../src/state/runtime.js";

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
  const profiler = new ProfileService(userMemory, userProfiles, new BackgroundJobs(() => {}), () => configStore.load(), logger);
  const deps: ApiDeps = {
    apiToken,
    configStore, knownChats: new KnownChatsStore(db),
    triviaScores: new TriviaScoreStore(db), userMemory, userProfiles, profiler, logger,
    pets: new PetService(new PetStore(db), () => configStore.load(), () => true),
    runtime,
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
  cleanup.push(async () => { await app.close(); db.close(); });
  return { app, deps, listeners, runtime };
}

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

describe("configuration revisions", () => {
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
      expect(result.pet).toMatchObject({ hydration: 100, cleanliness: 100 });
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