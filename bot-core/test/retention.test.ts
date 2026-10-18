import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { openDatabase } from "../src/state/db.js";
import { RetentionWorker } from "../src/state/retention.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../src/config/schema.js";

const DAY = 86_400_000;
const NOW = 200 * DAY;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const config = { retentionEnabled: true, analyticsRetentionDays: 90, deliveryRetentionDays: 30 };
  const logger = pino({ level: "silent" });
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  const worker = new RetentionWorker(db, () => config, logger);
  return { db, config, info, error, worker };
}

describe("retention settings", () => {
  it("supplies agreed defaults for old configurations without overwriting saved values", () => {
    expect(ConfigSchema.parse({})).toMatchObject({
      retentionEnabled: true, analyticsRetentionDays: 90, deliveryRetentionDays: 30,
    });
    expect(ConfigSchema.parse({ retentionEnabled: false, analyticsRetentionDays: 180, deliveryRetentionDays: 60 }))
      .toMatchObject({ retentionEnabled: false, analyticsRetentionDays: 180, deliveryRetentionDays: 60 });
  });

  it.each([0, -1, 1.5, 3651, "90", null])("rejects invalid retention days: %s", (days) => {
    expect(ConfigSchema.safeParse({ analyticsRetentionDays: days }).success).toBe(false);
    expect(ConfigSchema.safeParse({ deliveryRetentionDays: days }).success).toBe(false);
  });
});

describe("retention cleanup", () => {
  it("uses exact age cutoffs and cleans only terminal deliveries, including old existing rows", () => {
    const { db, worker, info } = setup();
    const analyticsCutoff = NOW - 90 * DAY;
    const deliveryCutoff = NOW - 30 * DAY;
    for (const ts of [analyticsCutoff - 1, analyticsCutoff, analyticsCutoff + 1]) {
      db.prepare("INSERT INTO sentiment_log(ts,sender,sentiment,polarity,message) VALUES (?,'SECRET','positive',1,'SECRET')").run(ts);
      db.prepare("INSERT INTO complaints(ts,sender,message) VALUES (?,'SECRET','SECRET')").run(ts);
    }
    const insert = db.prepare("INSERT INTO outbox(chat_id,body,status,available_at,created_at) VALUES ('SECRET','SECRET',?,0,?)");
    for (const status of ["pending", "sending", "failed", "sent", "cancelled"]) {
      for (const ts of [deliveryCutoff - 1, deliveryCutoff, deliveryCutoff + 1]) insert.run(status, ts);
    }
    worker.run(NOW);
    expect(db.prepare("SELECT ts FROM sentiment_log ORDER BY ts").all()).toEqual([{ ts: analyticsCutoff }, { ts: analyticsCutoff + 1 }]);
    expect(db.prepare("SELECT ts FROM complaints ORDER BY ts").all()).toEqual([{ ts: analyticsCutoff }, { ts: analyticsCutoff + 1 }]);
    expect(db.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status ORDER BY status").all()).toEqual([
      { status: "cancelled", n: 2 }, { status: "failed", n: 3 }, { status: "pending", n: 3 },
      { status: "sending", n: 3 }, { status: "sent", n: 2 },
    ]);
    expect(info).toHaveBeenCalledWith({
      removed: { sentiment: 1, complaints: 1, deliveries: 2 }, analyticsRetentionDays: 90, deliveryRetentionDays: 30,
    }, "Retention cleanup completed");
    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET");
    worker.run(NOW);
    expect(info).toHaveBeenLastCalledWith(expect.objectContaining({ removed: { sentiment: 0, complaints: 0, deliveries: 0 } }),
      "Retention cleanup completed");
  });

  it("does not touch protected bot state, even when it is old", () => {
    const { db, worker } = setup();
    db.exec(`
      INSERT INTO kv VALUES ('config', '{}');
      INSERT INTO reminders(chat_id,text,due_ts,created_ts) VALUES ('chat','keep',0,0);
      INSERT INTO tells(target_norm,target_name,from_name,message,created_ts) VALUES ('alice','Alice','Bob','keep',0);
      INSERT INTO pets VALUES ('chat','{}');
      INSERT INTO pet_events(id,chat_id,stage,sleeping,sent_at) VALUES ('event','chat',0,0,0);
      INSERT INTO outbox(chat_id,body,status,available_at,created_at,pet_event_id) VALUES ('chat','keep','pending',0,0,'event');
      INSERT INTO outbox(chat_id,body,status,available_at,created_at,pet_event_id) VALUES ('chat','delete','sent',0,0,'event');
      INSERT INTO karma VALUES ('alice','Alice',1);
      INSERT INTO trivia_scores VALUES ('chat','alice','Alice',1);
      INSERT INTO trivia_totals VALUES ('chat','alice','Alice',1);
      INSERT INTO trivia_trophies VALUES ('chat','2020-01','alice','Alice',1);
      INSERT INTO duel_wins VALUES ('chat','alice','Alice',1);
      INSERT INTO duel_totals VALUES ('chat','alice','Alice',1);
      INSERT INTO duel_trophies VALUES ('chat','2020-01','alice','Alice',1);
      INSERT INTO user_messages(sender_key,chat_id,name_norm,name,message,ts) VALUES ('scoped','chat','alice','Alice','keep',0);
      INSERT INTO user_profiles VALUES ('scoped','chat','Alice','keep','keep',1,0);
      INSERT INTO siesta_discipline(chat_id,sender_id,armed) VALUES ('chat','alice',1);
    `);
    const tables = ["kv", "reminders", "tells", "pets", "pet_events", "karma", "trivia_scores", "trivia_totals",
      "trivia_trophies", "duel_wins", "duel_totals", "duel_trophies", "user_messages", "user_profiles", "siesta_discipline"];
    const before = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    worker.run(NOW);
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(db.prepare("SELECT status FROM outbox").all()).toEqual([{ status: "pending" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("does nothing when disabled and uses the latest config at every pass", () => {
    const { db, worker, config, info } = setup();
    db.exec("INSERT INTO complaints(ts,sender,message) VALUES (0,'Alice','keep')");
    config.retentionEnabled = false;
    worker.run(NOW);
    expect(info).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM complaints").get()).toEqual({ n: 1 });
    config.retentionEnabled = true;
    config.analyticsRetentionDays = 300;
    worker.run(NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM complaints").get()).toEqual({ n: 1 });
    config.analyticsRetentionDays = 90;
    worker.run(NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM complaints").get()).toEqual({ n: 0 });
  });

  it("rolls back all deletions on failure and logs the error instead of a success", () => {
    const { db, worker, info, error } = setup();
    db.exec(`
      INSERT INTO sentiment_log(ts,sender,sentiment,polarity,message) VALUES (0,'Alice','positive',1,'keep');
      INSERT INTO complaints(ts,sender,message) VALUES (0,'Alice','keep');
      CREATE TRIGGER prevent_cleanup BEFORE DELETE ON complaints BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    `);
    worker.run(NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sentiment_log").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM complaints").get()).toEqual({ n: 1 });
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith({ err: expect.objectContaining({ message: "blocked" }) },
      "Retention cleanup failed; transaction rolled back, retrying next daily pass");
    db.exec("DROP TRIGGER prevent_cleanup");
    worker.run(NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sentiment_log").get()).toEqual({ n: 0 });
  });

  it("runs at startup and daily, starts only once, and disposes its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { worker, info, config } = setup();
    worker.start();
    worker.start();
    expect(info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DAY - 1);
    expect(info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(info).toHaveBeenCalledTimes(2);
    config.retentionEnabled = false;
    vi.advanceTimersByTime(DAY);
    expect(info).toHaveBeenCalledTimes(2);
    worker.stop();
    config.retentionEnabled = DEFAULT_CONFIG.retentionEnabled;
    vi.advanceTimersByTime(DAY);
    expect(info).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
