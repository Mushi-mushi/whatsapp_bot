import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { achievementBadge } from "../src/achievements/art.js";
import { ACHIEVEMENTS, SECRET_ACHIEVEMENTS, AchievementStore } from "../src/state/achievements.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../src/state/db.js";
import { DeliveryWorker } from "../src/state/deliveries.js";
import { OutboxStore } from "../src/state/outbox.js";

const CHAT = "group@g.us";
const PN = "34600000001@s.whatsapp.net";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

function setup() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  let config: BotConfig = { ...DEFAULT_CONFIG, approvedSenders: [CHAT], achievementChats: [CHAT] };
  const store = new AchievementStore(db, () => config);
  return { db, store, outbox: new OutboxStore(db), configure: (patch: Partial<BotConfig>) => { config = { ...config, ...patch }; } };
}

describe("original achievement artwork", () => {
  it("renders a distinct compact PNG for all 42 badges, including every secret and tier", async () => {
    const hashes = new Set<string>();
    for (const badge of [...ACHIEVEMENTS, ...SECRET_ACHIEVEMENTS]) {
      const image = await achievementBadge(badge.id);
      expect(await sharp(image).metadata()).toMatchObject({ format: "png", width: 384, height: 384 });
      expect(image.length).toBeLessThan(80 * 1024);
      const stats = await sharp(image).stats();
      expect(stats.channels[0].stdev).toBeGreaterThan(25);
      hashes.add(createHash("sha256").update(image).digest("hex"));
    }
    expect(hashes.size).toBe(ACHIEVEMENTS.length + SECRET_ACHIEVEMENTS.length);
  });

  it("caches artwork but rejects unknown badge IDs rather than sending a generic fallback", async () => {
    const first = achievementBadge("messages-1");
    expect(achievementBadge("messages-1")).toBe(first);
    await first;
    expect(() => achievementBadge("unknown")).toThrow("Unknown achievement badge");
  });
});

describe("durable achievement image delivery", () => {
  it("queues one image for each new badge, with a player caption, and never queues duplicates on lookup", () => {
    const { store, outbox } = setup();
    store.record(CHAT, PN, "Alice", [{ metric: "commands", value: 100 }], NOW);
    const delivered: string[] = [];
    for (let i = 0; i < 3; i++) {
      const notice = outbox.claim(NOW)!;
      delivered.push(notice.achievement_badge_id!);
      expect(notice.chat_id).toBe(CHAT);
      expect(notice.body).toContain("Alice");
      outbox.sent(notice);
    }
    expect(delivered).toEqual(["commands-1", "commands-25", "commands-100"]);
    store.record(CHAT, PN, "Renamed", ["commands"], NOW);
    store.describe(CHAT, PN);
    expect(outbox.claim(NOW)).toBeUndefined();
  });

  it("never queues secret pictures before unlock and includes only the earned secret", () => {
    const { store, outbox } = setup();
    store.describe(CHAT, PN);
    for (let i = 0; i < 9; i++) store.siesta(CHAT, PN, "Alice", NOW);
    expect(outbox.claim(NOW)).toBeUndefined();
    store.siesta(CHAT, PN, "Alice", NOW);
    const notice = outbox.claim(NOW)!;
    expect(notice.achievement_badge_id).toBe("siestas");
    expect(notice.body).toContain("Let Them Sleep");
    expect(notice.body).not.toContain("Night Owl");
    outbox.sent(notice);
    expect(outbox.claim(NOW)).toBeUndefined();
  });

  it.each(["regular", "secret"] as const)("rolls back %s unlocks and progress if image metadata cannot be saved", (kind) => {
    const { db, store, outbox } = setup();
    db.exec("CREATE TRIGGER reject_badge BEFORE INSERT ON achievement_badge_deliveries BEGIN SELECT RAISE(ABORT, 'metadata unavailable'); END;");
    expect(() => kind === "regular"
      ? store.record(CHAT, PN, "Alice", ["messages"], NOW)
      : store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW)).toThrow("metadata unavailable");
    expect(store.progress(CHAT, PN).unlocked).toEqual([]);
    expect(store.progress(CHAT, PN).counts.messages).toBe(0);
    expect(outbox.claim(NOW)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM achievement_activity").get()).toEqual({ count: 0 });
  });

  it("preserves badge metadata through retries and cancels unsent pictures when achievements are disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { store, outbox, configure, db } = setup();
    let online = false;
    const send = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(undefined);
    const worker = new DeliveryWorker(outbox, send, pino({ level: "silent" }), () => online, {
      canSend: (delivery) => !delivery.achievement_badge_id || store.enabled(delivery.chat_id),
      onSent: () => {},
    });
    cleanup.push(() => worker.stop());
    store.record(CHAT, PN, "Alice", ["commands"], NOW);
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    online = true;
    await worker.flush();
    expect(send.mock.calls[0][2].achievement_badge_id).toBe("commands-1");
    vi.setSystemTime(NOW + 5_001);
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2].achievement_badge_id).toBe("commands-1");
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sent" });
    store.unmutedMessage(CHAT, PN, "Alice", NOW, NOW + 5_001);
    configure({ achievementChats: [] });
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT status FROM outbox WHERE id = 2").get()).toEqual({ status: "cancelled" });
    expect(store.describe(CHAT, PN)).toContain("[Unlocked] Unmute Any% Speedrun");
  });

  it("leaves ordinary outbox messages as text and cascades image metadata when deliveries are pruned", () => {
    const { db, store, outbox } = setup();
    outbox.enqueue(CHAT, "Root override: siesta cancelled.", NOW);
    const text = outbox.claim(NOW)!;
    expect(text.achievement_badge_id).toBeNull();
    outbox.sent(text);
    store.record(CHAT, PN, "Alice", ["commands"], NOW);
    expect(db.prepare("SELECT COUNT(*) AS count FROM achievement_badge_deliveries").get()).toEqual({ count: 1 });
    db.prepare("DELETE FROM outbox").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM achievement_badge_deliveries").get()).toEqual({ count: 0 });
    expect(store.progress(CHAT, PN).unlocked).toHaveLength(1);
  });

  it("migrates schema 16 without resetting old badges and persists newly queued artwork across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-badge-art-"));
    const path = join(directory, "bot.db");
    const config = { ...DEFAULT_CONFIG, approvedSenders: [CHAT], achievementChats: [CHAT] };
    let db = openDatabase(path);
    try {
      db.exec(`DROP TABLE achievement_badge_deliveries; PRAGMA user_version=16;
        INSERT INTO achievement_unlocks VALUES ('${CHAT}','${PN}','messages-1',1);`);
      db.close();
      db = openDatabase(path);
      let store = new AchievementStore(db, () => config);
      expect(db.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(store.progress(CHAT, PN).unlocked).toHaveLength(1);
      expect(new OutboxStore(db).claim(NOW)).toBeUndefined();
      store.record(CHAT, PN, "Alice", ["commands"], NOW);
      db.close();
      db = openDatabase(path);
      store = new AchievementStore(db, () => config);
      expect(store.progress(CHAT, PN).unlocked).toHaveLength(2);
      expect(new OutboxStore(db).claim(NOW)).toMatchObject({
        achievement_badge_id: "commands-1", chat_id: CHAT,
      });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      if (db.open) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(directory);
    }
  });
});
