import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createApi, type ApiDeps } from "../src/api/server.js";
import { openDatabase } from "../src/state/db.js";
import { ConfigStore, KnownChatsStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileService } from "../src/handlers/profiles/service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(apiToken: string | undefined = "test-token") {
  const db = openDatabase(":memory:");
  const listeners = new Set<(status: unknown) => void>();
  const logger = pino({ level: "silent" });
  const userMemory = new UserMemoryStore(db);
  const userProfiles = new UserProfileStore(db);
  const configStore = new ConfigStore(db);
  const profiler = new ProfileService(userMemory, userProfiles, new BackgroundJobs(() => {}), () => configStore.load(), logger);
  const deps: ApiDeps = {
    apiToken,
    configStore, knownChats: new KnownChatsStore(db),
    triviaScores: new TriviaScoreStore(db), userMemory, userProfiles, profiler, logger,
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
  return { app, deps, listeners };
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
});