import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createApi, type ApiDeps } from "../src/api/server.js";
import { openDatabase } from "../src/state/db.js";
import { ConfigStore, ContactsStore, DuelWinStore, KarmaStore, KnownChatsStore, RemindersStore, SeenActivityStore, SiestaDisciplineStore, SuggestionStore, TellStore, TriviaScoreStore, UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileQueueError, ProfileService } from "../src/handlers/profiles/service.js";
import { PetService } from "../src/pets/service.js";
import { PetStore } from "../src/pets/store.js";
import { DEFAULT_PET_SETTINGS } from "../src/pets/settings.js";
import { RuntimeState } from "../src/state/runtime.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { REDACTED } from "../src/config/secrets.js";
import type { BotConfig, ConfigSaveResponse, ProfileDetail, ProfilesResponse } from "../../shared/api.js";
import type { OperationsResponse, RemindersResponse, ReminderCancelResponse, TellsResponse, FailedDeliveriesResponse, DeliveryHistoryResponse, AuditResponse } from "../../shared/api.js";
import { memoryKey } from "../src/state/identity.js";
import { OutboxStore } from "../src/state/outbox.js";
import { BackupWorker } from "../src/state/backups.js";
import { DeliveryWorker } from "../src/state/deliveries.js";
import { AuditStore } from "../src/state/audit.js";

const ALICE = memoryKey("group@g.us", "alice");
const ALICE_PATH = `/api/profiles/${encodeURIComponent(ALICE)}`;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(apiToken: string | undefined = "test-token", allowInsecureApi = false) {
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
    allowInsecureApi,
    jobs, outbox: new OutboxStore(db),
    reminders: new RemindersStore(db),
    tells: new TellStore(db),
    audit: new AuditStore(db),
    backups: new BackupWorker(db, { retentionDays: 14 }, logger),
    configStore, knownChats: new KnownChatsStore(db),
    triviaScores: new TriviaScoreStore(db),
    duelScores: new DuelWinStore(db),
    karma: new KarmaStore(db),
    seenActivity: new SeenActivityStore(db),
    suggestions: new SuggestionStore(db),
    userMemory, userProfiles, profiler, logger,
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

describe("administrative audit API", () => {
  const headers = { authorization: "Bearer test-token" };

  it("authenticates audit reads and mutations, but never audits rejected authentication or read-only requests", async () => {
    const { app, deps } = await setup();
    expect((await app.inject({ url: "/api/operations/audit" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/reminders/1" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/operations/audit", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/operations", headers })).statusCode).toBe(200);
    expect(deps.audit.list(1).total).toBe(0);
  });

  it("records successful, repeated/conflicting and invalid cancellation attempts with safe targets", async () => {
    const { app, deps } = await setup();
    deps.reminders.add("secret-chat", "Secret name", "secret message", 0);
    await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    await app.inject({ method: "DELETE", url: "/api/reminders/invalid-secret", headers });
    const response = await app.inject({ url: "/api/operations/audit", headers });
    expect(response.headers["cache-control"]).toBe("no-store");
    const data = response.json<AuditResponse>();
    expect(data).toMatchObject({ total: 3, page: 1, pageSize: 50, retentionDays: 90, maxEntries: 10000 });
    expect(data.entries.map((e) => [e.action, e.targetId, e.outcome, e.statusCode])).toEqual([
      ["reminder.cancel", null, "rejected", 400],
      ["reminder.cancel", "1", "rejected", 409],
      ["reminder.cancel", "1", "succeeded", 200],
    ]);
    expect(data.entries.every((e) => e.actor === "authenticated-api" && e.completedAt !== null)).toBe(true);
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("test-token");
  });

  it("audits malformed authenticated JSON without persisting its contents", async () => {
    const { app, deps } = await setup();
    const response = await app.inject({ method: "PUT", url: "/api/config",
      headers: { ...headers, "content-type": "application/json" }, payload: '{"secret-value"' });
    expect(response.statusCode).toBe(400);
    expect(deps.audit.list(1).entries[0]).toMatchObject({ action: "config.save", outcome: "rejected", statusCode: 400 });
    expect(JSON.stringify(deps.audit.list(1))).not.toContain("secret-value");
  });

  it("records config outcomes, never secret values, bodies or revision headers", async () => {
    const { app, deps } = await setup();
    const config = await app.inject({ url: "/api/config", headers });
    const save = await app.inject({ method: "PUT", url: "/api/config",
      headers: { ...headers, "if-match": config.headers.etag as string },
      payload: { ...config.json(), redditClientSecret: "secret-credential", askSystemPrompt: "secret-prompt" } });
    expect(save.statusCode).toBe(200);
    const conflict = await app.inject({ method: "PUT", url: "/api/config",
      headers: { ...headers, "if-match": config.headers.etag as string }, payload: config.json() });
    expect(conflict.statusCode).toBe(412);
    const entries = deps.audit.list(1).entries;
    expect(entries.map((e) => [e.action, e.targetId, e.outcome])).toEqual([
      ["config.save", null, "rejected"], ["config.save", null, "succeeded"],
    ]);
    const raw = JSON.stringify(entries);
    for (const secret of ["secret", "reddit", "askSystemPrompt", config.headers.etag]) expect(raw).not.toContain(secret);
  });

  it("records tell cancellation and manual retry scheduling rather than claiming a message was sent", async () => {
    const { app, deps, db } = await setup();
    deps.tells.add("chat", "alice", "Alice", "Bob", "secret text");
    expect((await app.inject({ method: "DELETE", url: "/api/tells/1", headers })).statusCode).toBe(200);
    db.exec("INSERT INTO outbox (chat_id, body, status, attempts, available_at, created_at) VALUES ('secret','secret','failed',5,0,0)");
    const payload = { expectedRetryCount: 0, acknowledgeDuplicateRisk: true };
    expect((await app.inject({ method: "POST", url: "/api/operations/deliveries/1/retry", headers, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/operations/deliveries/1/retry", headers, payload })).statusCode).toBe(409);
    expect(deps.audit.list(1).entries.map((e) => [e.action, e.targetId, e.statusCode])).toEqual([
      ["delivery.retry", "1", 409], ["delivery.retry", "1", 200], ["tell.cancel", "1", 200],
    ]);
    expect(deps.outbox.snapshot(Date.now()).counts).toMatchObject({ pending: 1, sent: 0 });
  });

  it("uses stable keyed opaque references for chat/person targets, with no body/identity data", async () => {
    const { app, deps, db } = await setup();
    const chatId = "secret-chat@g.us";
    const key = memoryKey(chatId, "secret-person");
    await app.inject({ method: "POST", url: "/api/pets/" + chatId + "/evolve", headers, payload: { expectedStage: 0 } });
    await app.inject({ method: "POST", url: "/api/pets/" + chatId + "/request", headers, payload: { kind: "feed" } });
    await app.inject({ method: "DELETE", url: `/api/profiles/${encodeURIComponent(key)}`, headers });
    for (const verb of ["arm", "wake"]) {
      await app.inject({ method: "POST", url: "/api/discipline/" + verb, headers,
        payload: { chatId, senderId: "secret-person@s.whatsapp.net" } });
    }
    const entries = deps.audit.list(1).entries;
    expect(entries[0].targetId).toMatch(/^player:[a-f0-9]{64}$/);
    expect(entries[0].targetId).toBe(entries[1].targetId);
    expect(entries[2].targetId).toMatch(/^profile:[a-f0-9]{64}$/);
    expect(entries[3].targetId).toMatch(/^chat:[a-f0-9]{64}$/);
    expect(entries[3].targetId).toBe(entries[4].targetId);
    expect(JSON.stringify(db.prepare("SELECT * FROM admin_audit").all())).not.toContain("secret");
    expect(entries.map((entry) => entry.action)).toEqual([
      "discipline.wake", "discipline.arm", "profile.forget", "pet.request", "pet.evolve",
    ]);
  });

  it("records specific pet management actions using only controlled labels", async () => {
    const { app, deps } = await setup();
    const chatId = "group@g.us";
    deps.configStore.save({ ...deps.configStore.load(), approvedSenders: [chatId] });
    for (const action of ["enable", "save", "pause", "resume", "disable"]) {
      const list = (await app.inject({ url: "/api/pets", headers })).json();
      const response = await app.inject({ method: "PUT", url: `/api/pets/${chatId}`,
        headers: { ...headers, "if-match": list.groups[0].revision },
        payload: { action, name: "Secret pet name", species: "fox", settings: DEFAULT_PET_SETTINGS } });
      expect(response.statusCode).toBe(200);
    }
    expect(deps.audit.list(1).entries.map((e) => e.action)).toEqual(["pet.disable", "pet.resume", "pet.pause", "pet.save", "pet.enable"]);
    expect(JSON.stringify(deps.audit.list(1))).not.toContain("Secret pet name");
  });

  it("audits all other administrative surfaces and preserves explicit HTTP failures", async () => {
    const { app, deps } = await setup();
    deps.transport.requestPairingCode = vi.fn().mockResolvedValue("secret-pairing-code");
    deps.transport.resyncContacts = vi.fn().mockResolvedValue(undefined);
    deps.transport.relink = vi.fn().mockRejectedValue(new Error("secret transport failure"));
    vi.spyOn(deps.profiler, "requestRefresh").mockRejectedValue(new Error("secret model failure"));
    const cases = [
      ["/api/siesta/cancel", {}, "siesta.cancel", 200],
      ["/api/discipline/sleep", { chatId: "secret-chat", senderId: "secret-person", minutes: 5 }, "discipline.sleep", 200],
      ["/api/trivia/reset", {}, "trivia.reset", 200],
      ["/api/trivia/close-month", { period: "2026-09" }, "trivia.close-month", 200],
      ["/api/pair", { phoneNumber: "secret-phone" }, "connection.pair", 200],
      ["/api/resync", {}, "connection.resync", 200],
      ["/api/relink", {}, "connection.relink", 500],
      ["/api/profiles/secret-key/refresh", {}, "profile.refresh", 502],
    ] as const;
    for (const [url, payload, action, statusCode] of cases) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(statusCode);
      expect(deps.audit.list(1).entries[0]).toMatchObject({ action, statusCode,
        outcome: statusCode >= 500 ? "failed" : "succeeded" });
    }
    expect(JSON.stringify(deps.audit.list(1))).not.toContain("secret");
  });

  it("refuses to execute a mutation when the initial audit write fails and logs the failure", async () => {
    const { app, deps, db } = await setup();
    const error = vi.spyOn(deps.logger, "error");
    deps.reminders.add("chat", null, "keep", 0);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    const response = await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    expect(response.statusCode).toBe(500);
    expect(deps.reminders.list(1).total).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE", url: "/api/reminders/:id" }), "API request failed");
  });

  it("leaves an explicit unknown record and returns an error if completion persistence fails after a mutation", async () => {
    const { app, deps, db } = await setup();
    const error = vi.spyOn(deps.logger, "error");
    deps.reminders.add("chat", null, "cancel", 0);
    db.exec("CREATE TRIGGER fail_audit_complete BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit completion unavailable'); END");
    const response = await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    expect(response.statusCode).toBe(500);
    expect(deps.reminders.list(1).total).toBe(0);
    expect(deps.audit.list(1).entries[0]).toMatchObject({ action: "reminder.cancel", outcome: "unknown", statusCode: null, completedAt: null });
    expect(error).toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_audit_complete");
    expect((await app.inject({ method: "DELETE", url: "/api/reminders/1", headers })).statusCode).toBe(409);
  });

  it("labels explicitly allowed unauthenticated local API mode without inventing an authenticated actor", async () => {
    const { app, deps } = await setup("", true);
    expect((await app.inject({ method: "POST", url: "/api/siesta/cancel" })).statusCode).toBe(200);
    expect(deps.audit.list(1).entries[0].actor).toBe("local-insecure-api");
  });

  it.each(["0", "-1", "1.5", "abc", "1000001", "", "1e2"])("rejects invalid audit page %s without auditing the read", async (page) => {
    const { app, deps } = await setup();
    expect((await app.inject({ url: `/api/operations/audit?page=${page}`, headers })).statusCode).toBe(400);
    expect(deps.audit.list(1).total).toBe(0);
  });
});

describe("delivery recovery and pending tells API", () => {
  const headers = { authorization: "Bearer test-token" };
  const retryBody = { expectedRetryCount: 0, acknowledgeDuplicateRisk: true };
  async function failedSetup() {
    const result = await setup();
    result.db.prepare(`INSERT INTO outbox (chat_id, body, status, attempts, available_at, created_at, last_error)
      VALUES ('secret-chat', 'secret-text', 'failed', 5, 0, 0, 'secret error')`).run();
    return result;
  }

  it.each([
    ["GET", "/api/tells"], ["DELETE", "/api/tells/1"],
    ["GET", "/api/operations/failed-deliveries"], ["GET", "/api/operations/deliveries/1/history"],
    ["POST", "/api/operations/deliveries/1/retry"],
  ] as const)("authenticates %s %s without changing delivery state", async (method, url) => {
    const { app, db, deps } = await failedSetup();
    deps.tells.add("chat", "alice", "Alice", "Bob", "hello");
    expect((await app.inject({ method, url, payload: method === "POST" ? retryBody : undefined })).statusCode).toBe(401);
    expect(deps.tells.list(1).total).toBe(1);
    expect(db.prepare("SELECT status, manual_retry_count FROM outbox").get()).toEqual({ status: "failed", manual_retry_count: 0 });
  });

  it("lists bounded sanitized failures and history without sensitive fields", async () => {
    const { app } = await failedSetup();
    const response = await app.inject({ url: "/api/operations/failed-deliveries", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json<FailedDeliveriesResponse>()).toMatchObject({
      total: 1, page: 1, pageSize: 50, deliveries: [{ id: 1, attempts: 5, retryCount: 0, failureKind: "send-error" }],
    });
    expect(response.body).not.toContain("secret");
    const history = await app.inject({ url: "/api/operations/deliveries/1/history", headers });
    expect(history.headers["cache-control"]).toBe("no-store");
    expect(history.json<DeliveryHistoryResponse>()).toEqual({ id: 1, total: 0, attempts: [] });
    expect((await app.inject({ url: "/api/operations/deliveries/999/history", headers })).statusCode).toBe(404);
  });

  it.each([{}, { expectedRetryCount: 0 }, { ...retryBody, acknowledgeDuplicateRisk: false },
    { ...retryBody, expectedRetryCount: -1 }, { ...retryBody, expectedRetryCount: 0.5 },
    { ...retryBody, expectedRetryCount: "0" }, { ...retryBody, extra: true }])("requires an explicit valid retry acknowledgement: %j", async (payload) => {
    const { app, deps } = await failedSetup();
    expect((await app.inject({ method: "POST", url: "/api/operations/deliveries/1/retry", headers, payload })).statusCode).toBe(400);
    expect(deps.outbox.listFailed(1).total).toBe(1);
  });

  it("schedules a single retry atomically and rejects concurrent/stale requests even after another failure", async () => {
    const { app, deps } = await failedSetup();
    const request = () => app.inject({ method: "POST", url: "/api/operations/deliveries/1/retry", headers, payload: retryBody });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 200)!.json()).toEqual({ ok: true, retriedId: 1 });
    expect(deps.outbox.snapshot(Date.now()).counts).toMatchObject({ pending: 1, sent: 0 });
    const delivery = deps.outbox.claim(Date.now())!;
    expect(delivery.attempts).toBe(5);
    expect((await request()).statusCode).toBe(409);
    deps.outbox.failed(delivery, "failed again", Date.now());
    expect((await request()).statusCode).toBe(409);
    expect(deps.outbox.listFailed(1).deliveries[0].retryCount).toBe(1);
    const next = await app.inject({ method: "POST", url: "/api/operations/deliveries/1/retry", headers,
      payload: { ...retryBody, expectedRetryCount: 1 } });
    expect(next.statusCode).toBe(200);
  });

  it.each(["0", "-1", "abc", "1.2", "9007199254740992"])("rejects invalid IDs on every new record endpoint: %s", async (id) => {
    const { app } = await failedSetup();
    for (const [method, url] of [
      ["DELETE", `/api/tells/${id}`],
      ["GET", `/api/operations/deliveries/${id}/history`],
      ["POST", `/api/operations/deliveries/${id}/retry`],
    ] as const) {
      expect((await app.inject({ method, url, headers, payload: method === "POST" ? retryBody : undefined })).statusCode).toBe(400);
    }
  });

  it.each(["0", "-1", "abc", "1.2", "1000001"])("rejects invalid list pages: %s", async (page) => {
    const { app } = await setup();
    for (const url of [`/api/tells?page=${page}`, `/api/operations/failed-deliveries?page=${page}`]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    }
  });

  it("lists tells by creation and ID with explicit chat and recipient identity", async () => {
    const { app, deps } = await setup();
    for (let i = 0; i < 51; i++) deps.tells.add("chat", "alice", "Alice", "Bob", `message ${i}`);
    const response = await app.inject({ url: "/api/tells", headers });
    expect(response.headers["cache-control"]).toBe("no-store");
    const first = response.json<TellsResponse>();
    expect(first).toMatchObject({ total: 51, page: 1, pageSize: 50 });
    expect(first.tells).toHaveLength(50);
    expect(first.tells[0]).toEqual({ id: 1, targetName: "Alice", fromName: "Bob", text: "message 0", createdAt: expect.any(Number),
      chatId: "chat", chatName: null, targetId: "alice", legacy: false });
    expect((await app.inject({ url: "/api/tells?page=2", headers })).json<TellsResponse>().tells.map((t) => t.id)).toEqual([51]);
    expect((await app.inject({ url: "/api/tells?page=3", headers })).json<TellsResponse>()).toMatchObject({ tells: [], total: 51 });
    expect(deps.outbox.snapshot(Date.now()).counts.pending).toBe(0);
  });

  it("cancels just one pending tell, refuses repeated cancellation, and never cancels an already handed-off delivery", async () => {
    const { app, deps, db } = await setup();
    deps.tells.add("chat", "alice", "Alice", "Bob", "cancel me");
    deps.tells.add("chat", "alice", "Alice", "Bob", "keep me");
    const cancelled = await app.inject({ method: "DELETE", url: "/api/tells/1", headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.headers["cache-control"]).toBe("no-store");
    expect(cancelled.json()).toEqual({ ok: true, cancelledId: 1 });
    expect((await app.inject({ method: "DELETE", url: "/api/tells/1", headers })).statusCode).toBe(409);
    deps.tells.enqueueFor("alice", "chat", "Alice");
    const before = db.prepare("SELECT * FROM outbox").all();
    const conflict = await app.inject({ method: "DELETE", url: "/api/tells/2", headers });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toContain("no delivery was cancelled");
    expect(db.prepare("SELECT * FROM outbox").all()).toEqual(before);
    expect(deps.outbox.claim(Date.now())!.body).toContain("keep me");
    expect(deps.tells.list(1).tells).toEqual([]);
  });
});

describe("scheduled reminders API", () => {
  const headers = { authorization: "Bearer test-token" };

  it("requires authentication for listing and cancellation and leaves data unchanged", async () => {
    const { app, deps } = await setup();
    deps.reminders.add("group@g.us", "Alice", "private reminder", 1000);
    expect((await app.inject({ url: "/api/reminders" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/reminders/1" })).statusCode).toBe(401);
    expect(deps.reminders.list(1).total).toBe(1);
  });

  it("lists overdue and future scheduled reminders by due time and ID, with current chat names", async () => {
    const { app, deps, db } = await setup();
    deps.reminders.add("unknown@g.us", null, "later", Date.now() + 60000);
    deps.reminders.add("first@g.us", "Alice", "<script>plain text</script>", 1);
    deps.reminders.add("second@g.us", "Bob", "same due time", 1);
    db.prepare("INSERT INTO chat_directory VALUES (?,?,?)").run("first@g.us", "Shared name", 1);
    db.prepare("INSERT INTO chat_directory VALUES (?,?,?)").run("second@g.us", "Shared name", 1);
    const response = await app.inject({ url: "/api/reminders", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const data = response.json<RemindersResponse>();
    expect(data).toMatchObject({ total: 3, page: 1, pageSize: 50, sampledAt: expect.any(Number) });
    expect(data.reminders.map((r) => r.id)).toEqual([2, 3, 1]);
    expect(data.reminders[0]).toEqual({
      id: 2, chatId: "first@g.us", chatName: "Shared name", targetName: "Alice", text: "<script>plain text</script>", dueAt: 1, recurrence: "once",
    });
    expect(data.reminders[2]).toMatchObject({ chatName: null, targetName: null });
    expect(deps.outbox.snapshot(Date.now()).counts.pending).toBe(0);
    db.prepare("UPDATE chat_directory SET name='Renamed' WHERE id='first@g.us'").run();
    expect((await app.inject({ url: "/api/reminders", headers })).json<RemindersResponse>().reminders[0].chatName).toBe("Renamed");
  });

  it("returns bounded pages, totals and an honest empty result without claiming reminders", async () => {
    const { app, deps } = await setup();
    const empty = (await app.inject({ url: "/api/reminders", headers })).json<RemindersResponse>();
    expect(empty).toMatchObject({ reminders: [], total: 0, pageSize: 50 });
    for (let i = 0; i < 51; i++) deps.reminders.add("chat", null, `reminder ${i}`, 0);
    const first = (await app.inject({ url: "/api/reminders", headers })).json<RemindersResponse>();
    const second = (await app.inject({ url: "/api/reminders?page=2", headers })).json<RemindersResponse>();
    const pastEnd = (await app.inject({ url: "/api/reminders?page=3", headers })).json<RemindersResponse>();
    expect(first.reminders).toHaveLength(50);
    expect(first.total).toBe(51);
    expect(second.reminders.map((r) => r.id)).toEqual([51]);
    expect(second.page).toBe(2);
    expect(pastEnd.reminders).toEqual([]);
    expect(pastEnd.total).toBe(51);
    expect(deps.reminders.due(0)).toHaveLength(51);
  });

  it.each(["0", "-1", "1.5", "abc", "1000001", "", "1e2"])("rejects invalid page %s", async (page) => {
    const { app } = await setup();
    expect((await app.inject({ url: `/api/reminders?page=${page}`, headers })).statusCode).toBe(400);
  });

  it.each(["0", "-1", "1.5", "abc", "9007199254740992", "1e2"])("rejects invalid reminder ID %s without deleting records", async (id) => {
    const { app, deps } = await setup();
    deps.reminders.add("chat", null, "keep", 0);
    const response = await app.inject({ method: "DELETE", url: `/api/reminders/${id}`, headers });
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(deps.reminders.list(1).total).toBe(1);
  });

  it("cancels only the requested scheduled reminder and does not later enqueue it", async () => {
    const { app, deps } = await setup();
    deps.reminders.add("chat", "Alice", "cancel me", 0);
    deps.reminders.add("chat", "Alice", "keep me", 0);
    const response = await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json<ReminderCancelResponse>()).toEqual({ ok: true, cancelledId: 1 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(deps.reminders.list(1).reminders.map((r) => r.id)).toEqual([2]);
    expect((await app.inject({ method: "DELETE", url: "/api/reminders/1", headers })).statusCode).toBe(409);
    deps.outbox.enqueueReminders(Date.now());
    expect(deps.outbox.snapshot(Date.now()).counts.pending).toBe(1);
    expect(deps.outbox.claim(Date.now())?.body).toContain("keep me");
  });

  it("refuses a stale cancellation after scheduler handoff without changing an unrelated matching outbox ID", async () => {
    const { app, deps, db } = await setup();
    deps.reminders.add("chat", "Alice", "already queued", 0);
    deps.outbox.enqueueReminders(Date.now());
    const before = db.prepare("SELECT * FROM outbox").all();
    const response = await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("no delivery was cancelled");
    expect(db.prepare("SELECT * FROM outbox").all()).toEqual(before);
    expect((await app.inject({ url: "/api/reminders", headers })).json<RemindersResponse>().total).toBe(0);
  });

  it("creates and updates one-time and recurring reminders with audit logging and validation", async () => {
    const { app, deps } = await setup();
    const dueAt = Date.now() + 3600_000;
    const created = await app.inject({
      method: "POST",
      url: "/api/reminders",
      headers,
      payload: { chatId: "group@g.us", targetName: "Alice", text: "Standup", dueAt, recurrence: "daily" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().reminder).toMatchObject({
      id: 1, chatId: "group@g.us", targetName: "Alice", text: "Standup", dueAt, recurrence: "daily",
    });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/reminders/1",
      headers,
      payload: { targetName: null, text: "Weekly review", dueAt: dueAt + 60_000, recurrence: "weekly" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().reminder).toMatchObject({
      id: 1, targetName: null, text: "Weekly review", recurrence: "weekly",
    });

    expect((await app.inject({
      method: "POST", url: "/api/reminders", headers,
      payload: { chatId: "group@g.us", targetName: null, text: "past", dueAt: Date.now() - 1000, recurrence: "once" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PUT", url: "/api/reminders/999", headers,
      payload: { targetName: null, text: "missing", dueAt, recurrence: "once" },
    })).statusCode).toBe(409);

    const actions = deps.audit.list(1).entries.map((e) => e.action);
    expect(actions.slice(0, 4)).toEqual(["reminder.update", "reminder.create", "reminder.update", "reminder.create"]);
  });

  it("exposes per-chat leaderboards and participant last-seen activity", async () => {
    const { app, deps } = await setup();
    deps.knownChats.upsert([{ id: "group@g.us", name: "Friends" }]);
    deps.triviaScores.add("group@g.us", "34600000001@s.whatsapp.net", "Alice", 5);
    deps.duelScores!.add("group@g.us", "34600000001@s.whatsapp.net", "Alice");
    deps.karma!.adjust("group@g.us", "34600000001@s.whatsapp.net", "Alice", 3);
    deps.seenActivity!.record("group@g.us", "34600000001@s.whatsapp.net", "Alice", 12345, "Friends");

    const res = await app.inject({ url: "/api/leaderboards", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0]).toMatchObject({
      chatId: "group@g.us",
      chatName: "Friends",
      trivia: { monthly: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 5 }] },
      duel: { monthly: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 1 }] },
      karma: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 3 }],
      participants: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", lastSeenAt: 12345 }],
    });
  });

  it("lists and deletes logged suggestions with audit tracking", async () => {
    const { app, deps } = await setup();
    deps.knownChats.upsert([{ id: "group@g.us", name: "Friends" }]);
    deps.suggestions!.log("group@g.us", "34600000001@s.whatsapp.net", "Alice", "explicit", "Add horoscopes", null, 100);
    deps.suggestions!.log("group@g.us", "34600000001@s.whatsapp.net", "Alice", "unknown_command", "bot.dance now", "bot.dance", 200);

    const list = (await app.inject({ url: "/api/suggestions", headers })).json();
    expect(list.total).toBe(2);
    expect(list.suggestions.map((s: { kind: string; command: string | null }) => [s.kind, s.command])).toEqual([
      ["unknown_command", "bot.dance"],
      ["explicit", null],
    ]);

    const del = await app.inject({ method: "DELETE", url: "/api/suggestions/1", headers });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, deletedId: 1 });
    expect((await app.inject({ method: "DELETE", url: "/api/suggestions/1", headers })).statusCode).toBe(409);
    expect(deps.audit.list(1).entries[0].action).toBe("suggestion.delete");
  });

  it("does not claim cancellation while a worker is already sending the reminder", async () => {
    const { app, deps, db } = await setup();
    deps.reminders.add("chat", "Alice", "in flight", 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(() => gate);
    const worker = new DeliveryWorker(deps.outbox, send, pino({ level: "silent" }));
    const flushing = worker.flush();
    try {
      expect(send).toHaveBeenCalledOnce();
      const response = await app.inject({ method: "DELETE", url: "/api/reminders/1", headers });
      expect(response.statusCode).toBe(409);
      expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sending" });
    } finally {
      release();
      await flushing;
      await worker.stop();
    }
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sent" });
  });
});

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
    for (const invalid of [{ chatId: " ", senderId: "s" }, { chatId: "c", senderId: " " }]) {
      expect((await app.inject({ method: "POST", url: "/api/discipline/arm", headers, payload: invalid })).statusCode)
        .toBe(400);
    }
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

  it("uses the same verified aliases and device normalization as incoming discipline", async () => {
    const { app, deps, discipline } = await setup();
    deps.contacts.upsertMany([
      { jid: "900@lid", phone: "34600000001", name: "" },
      { jid: "34600000001@s.whatsapp.net", phone: "34600000001", name: "Alice" },
    ]);
    deps.contacts.upsertMany([{ jid: "900@lid", phone: null, name: "" }]);
    for (const senderId of ["900@lid", "34600000001:2@s.whatsapp.net"]) {
      const armed = await app.inject({ method: "POST", url: "/api/discipline/arm", headers,
        payload: { chatId: "group@g.us", senderId } });
      expect(armed.statusCode).toBe(200);
      expect(armed.json().players).toHaveLength(1);
      expect(armed.json().players[0]).toMatchObject({
        senderId: "34600000001@s.whatsapp.net", displayName: "Alice",
      });
      expect(discipline.isArmed("group@g.us", "900@lid")).toBe(true);
    }
    const woken = await app.inject({ method: "POST", url: "/api/discipline/wake", headers,
      payload: { chatId: "group@g.us", senderId: "900@lid" } });
    expect(woken.json().players).toEqual([]);
    expect((await app.inject({ url: "/api/contacts", headers })).json().contacts)
      .toEqual([{ jid: "34600000001@s.whatsapp.net", phone: "34600000001", name: "Alice" }]);
  });

  it("does not resolve a LID to an unrelated person with the same phone digits", async () => {
    const { app, deps } = await setup();
    deps.contacts.upsertMany([{ jid: "900@s.whatsapp.net", phone: "900", name: "Unrelated" }]);
    const armed = await app.inject({ method: "POST", url: "/api/discipline/arm", headers,
      payload: { chatId: "group@g.us", senderId: "900@lid" } });
    expect(armed.json().players[0]).toMatchObject({ senderId: "900@lid", displayName: null });
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