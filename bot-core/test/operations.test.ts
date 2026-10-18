import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobs } from "../src/router/jobs.js";
import { openDatabase } from "../src/state/db.js";
import { OutboxStore } from "../src/state/outbox.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return { db, outbox: new OutboxStore(db) };
}

describe("background operations snapshot", () => {
  it("tracks running, queued, rejection reasons and drained completions without identifiers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const jobs = new BackgroundJobs(() => {}, 2);
    expect(jobs.snapshot()).toMatchObject({
      capacity: 2, accepting: true, running: null, queued: 0, completed: 0, failed: 0,
      oldestQueuedAt: null, rejected: { capacity: 0, duplicate: 0, stopping: 0 }, recentFailures: [],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jobs.submit("PRIVATE-CHAT-ID", () => gate, 1, "profile");
    jobs.submit("PRIVATE-CHAT-ID", async () => {});
    vi.setSystemTime(2000);
    jobs.submit("PRIVATE-OTHER-ID", async () => {});
    jobs.submit("full", async () => {});
    expect(jobs.snapshot()).toMatchObject({
      running: { kind: "profile", startedAt: 1000 }, queued: 1, oldestQueuedAt: 2000,
      rejected: { duplicate: 1, capacity: 1, stopping: 0 },
    });
    expect(JSON.stringify(jobs.snapshot())).not.toContain("PRIVATE");
    const draining = jobs.stop();
    jobs.submit("late", async () => {});
    expect(jobs.snapshot().accepting).toBe(false);
    release();
    await draining;
    expect(jobs.snapshot()).toMatchObject({
      running: null, queued: 0, oldestQueuedAt: null, completed: 2, failed: 0,
      rejected: { duplicate: 1, capacity: 1, stopping: 1 },
    });
  });

  it("records bounded failures, not raw errors, and returns independent snapshots", async () => {
    const onError = vi.fn();
    const jobs = new BackgroundJobs(onError, 30);
    for (let i = 0; i < 25; i++) jobs.submit(`SECRET-KEY-${i}`, async () => { throw new Error("SECRET-CREDENTIAL"); }, 1, "profile");
    await jobs.stop();
    const snapshot = jobs.snapshot();
    expect(snapshot.failed).toBe(25);
    expect(snapshot.completed).toBe(0);
    expect(snapshot.recentFailures).toHaveLength(20);
    expect(snapshot.recentFailures.map((f) => f.id)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(snapshot.recentFailures[0]).toMatchObject({ kind: "profile", failedAt: expect.any(Number), startedAt: expect.any(Number) });
    expect(onError).toHaveBeenCalledTimes(25);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    snapshot.rejected.capacity = 100;
    snapshot.recentFailures[0].id = 100;
    expect(jobs.snapshot().rejected.capacity).toBe(0);
    expect(jobs.snapshot().recentFailures[0].id).toBe(25);
  });
});

describe("outbox operations snapshot", () => {
  it("reports zeros for empty state and never enqueues or claims on read", () => {
    const { db, outbox } = setup();
    db.prepare("INSERT INTO reminders(chat_id,text,due_ts,created_ts) VALUES ('private','secret',0,0)").run();
    expect(outbox.snapshot(1000)).toEqual({
      counts: { pending: 0, sending: 0, failed: 0, sent: 0, cancelled: 0 },
      ready: 0, retrying: 0, expiredLeases: 0, nextAttemptAt: null, recentFailures: [],
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reminders").get()).toEqual({ n: 1 });
  });

  it("distinguishes retry backoff from ready work and removes resolved failures", () => {
    const { db, outbox } = setup();
    db.prepare("INSERT INTO outbox(chat_id,body,available_at,created_at) VALUES ('PRIVATE-ID','PRIVATE-BODY',0,0)").run();
    const delivery = outbox.claim(1000)!;
    expect(outbox.snapshot(1000)).toMatchObject({ counts: { sending: 1 }, nextAttemptAt: 301000 });
    outbox.failed(delivery, new Error("PRIVATE-ERROR"), 2000);
    expect(outbox.snapshot(3000)).toMatchObject({
      counts: { pending: 1, sending: 0 }, ready: 0, retrying: 1, nextAttemptAt: 7000,
      recentFailures: [{ id: delivery.id, status: "pending", attempts: 1, failedAt: 2000, retryAt: 7000 }],
    });
    expect(JSON.stringify(outbox.snapshot(3000))).not.toContain("PRIVATE");
    expect(outbox.snapshot(7000).ready).toBe(1);
    const retry = outbox.claim(7000)!;
    expect(outbox.snapshot(8000).recentFailures[0]).toMatchObject({ status: "sending", retryAt: 307000 });
    outbox.sent(retry);
    expect(outbox.snapshot(8000)).toMatchObject({ counts: { sent: 1 }, retrying: 0, nextAttemptAt: null, recentFailures: [] });
  });

  it("reports expired leases read-only and records exhausted lease failures when the worker claims", () => {
    const { db, outbox } = setup();
    db.prepare(`INSERT INTO outbox(chat_id,body,status,attempts,available_at,lease_until,created_at)
      VALUES ('private','body','sending',5,0,1000,0)`).run();
    expect(outbox.snapshot(1000)).toMatchObject({ counts: { sending: 1, failed: 0 }, expiredLeases: 1, recentFailures: [] });
    expect(outbox.claim(2000)).toBeUndefined();
    expect(outbox.snapshot(2000)).toMatchObject({
      counts: { sending: 0, failed: 1 }, expiredLeases: 0, nextAttemptAt: null,
      recentFailures: [{ attempts: 5, failedAt: 2000, retryAt: null, status: "failed" }],
    });
  });

  it("keeps attempt exhaustion and failure time, excluding cancelled rows", () => {
    const { db, outbox } = setup();
    db.prepare("INSERT INTO outbox(chat_id,body,available_at,created_at) VALUES ('private','body',0,0)").run();
    for (let i = 0; i < 5; i++) {
      const now = i * 1000000;
      outbox.failed(outbox.claim(now)!, new Error("failure"), now);
    }
    const snapshot = outbox.snapshot(5000000);
    expect(snapshot).toMatchObject({
      counts: { failed: 1 }, ready: 0, retrying: 0, nextAttemptAt: null,
      recentFailures: [{ attempts: 5, status: "failed", failedAt: 4000000, retryAt: null }],
    });
    db.prepare("INSERT INTO outbox(chat_id,body,available_at,created_at) VALUES ('private','cancelled',0,0)").run();
    const next = outbox.claim(5000000)!;
    outbox.failed(next, "failed", 5000000);
    outbox.cancel(outbox.claim(6000000)!);
    expect(outbox.snapshot(6000000).counts.cancelled).toBe(1);
    expect(outbox.snapshot(6000000).recentFailures).toHaveLength(1);
  });

  it("orders and bounds unresolved failures with unknown legacy timestamps last", () => {
    const { db, outbox } = setup();
    const insert = db.prepare(`INSERT INTO outbox(chat_id,body,status,attempts,available_at,created_at,last_error,last_failure_at)
      VALUES ('secret','secret','failed',5,0,0,'secret',?)`);
    insert.run(null);
    for (let i = 1; i <= 25; i++) insert.run(i);
    const snapshot = outbox.snapshot(1000);
    expect(snapshot.counts.failed).toBe(26);
    expect(snapshot.recentFailures).toHaveLength(20);
    expect(snapshot.recentFailures.map((f) => f.failedAt)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
  });

  it("retains unknown legacy times and ignores failed updates from stale claims", () => {
    const { db, outbox } = setup();
    db.prepare(`INSERT INTO outbox(chat_id,body,available_at,created_at,last_error)
      VALUES ('private','body',0,0,'old failure')`).run();
    expect(outbox.snapshot(0).recentFailures[0]).toMatchObject({ failedAt: null, retryAt: 0 });
    const expired = outbox.claim(0)!;
    const current = outbox.claim(300000)!;
    outbox.failed(expired, new Error("stale"), 300001);
    expect(outbox.snapshot(300001).recentFailures[0]).toMatchObject({
      status: "sending", attempts: 2, failedAt: null, retryAt: 600000,
    });
    outbox.failed(current, new Error("current"), 300002);
    expect(outbox.snapshot(300002).recentFailures[0]).toMatchObject({
      status: "pending", attempts: 2, failedAt: 300002, retryAt: 310002,
    });
  });
});
