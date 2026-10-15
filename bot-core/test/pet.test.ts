import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import sharp from "sharp";
import { openDatabase } from "../src/state/db.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { ConfigStore, RemindersStore, SeenStore } from "../src/state/repos.js";
import { OutboxStore } from "../src/state/outbox.js";
import { DeliveryWorker } from "../src/state/deliveries.js";
import { PetStore } from "../src/pets/store.js";
import { PetService } from "../src/pets/service.js";
import { createPet, DAY, HOUR, RIDDLES, STAGES, SPECIES, SPECIES_IDS } from "../src/pets/model.js";
import { petPortrait } from "../src/pets/art.js";
import { DEFAULT_PET_SETTINGS } from "../src/pets/settings.js";
import { makePet } from "../src/handlers/commands/pet.js";
import { Bot } from "../src/router/router.js";
import { Context } from "../src/router/context.js";
import { approvedSenderGuard, dedupe, ignoreOwn, mediaPolicy, petObserver } from "../src/middleware/index.js";
import { RuntimeState } from "../src/state/runtime.js";
import type { IncomingMessage, Transport } from "../src/transport/types.js";

const databases: ReturnType<typeof openDatabase>[] = [];
const CHAT = "cloud@g.us";
const NOW = Date.parse("2026-10-15T10:00:00Z");
const logger = pino({ level: "silent" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatId: CHAT, chatName: "Cloud Club", senderId: "alice@s.whatsapp.net",
    senderName: "Alice", senderPhone: "123456789", messageId: "msg",
    fromMe: false, isGroup: true, text: "hello", kind: "text", timestamp: Date.now(),
    raw: { key: { id: "msg", remoteJid: CHAT } }, ...overrides,
  };
}

function setup(random = () => 0) {
  const db = openDatabase(":memory:");
  databases.push(db);
  let config = { ...DEFAULT_CONFIG, approvedSenders: [CHAT, "second@g.us"] };
  let ready = true;
  const store = new PetStore(db);
  const getConfig = () => config;
  const isReady = () => ready;
  const pets = new PetService(store, getConfig, isReady, random);
  const transport = {
    sendText: vi.fn(async (_chatId: string, _text: string) => {}),
    sendImage: vi.fn(async (_chatId: string, _image: Buffer, _caption?: string) => {}),
    sendVideo: vi.fn(async () => {}),
    sendReply: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    downloadAudio: vi.fn(async () => Buffer.alloc(0)),
    downloadImage: vi.fn(async () => Buffer.alloc(0)),
    downloadQuotedImage: vi.fn(async () => null),
    requestPairingCode: vi.fn(async () => ""),
    resyncContacts: vi.fn(async () => {}),
    relink: vi.fn(async () => {}),
    getStatus: () => ({
      state: "open" as const, health: "online" as const, me: "owner",
      qrDataUrl: null, pairingCode: null, lastActivityAt: NOW,
    }),
    onMessage: () => () => {},
    onStatus: () => () => {},
    onChatsDiscovered: () => () => {},
    isGroupAdmin: vi.fn(async () => false),
  } satisfies Transport;
  const command = makePet(pets);
  const run = async (args: string, overrides: Partial<IncomingMessage> = {}) => {
    const ctx = new Context(message({ text: `bot.pet ${args}`, ...overrides }), { transport, getConfig });
    ctx.args = args;
    await command(ctx);
  };
  const enable = () => pets.command(CHAT, "enable", "Mochi");
  const change = (patch: Partial<ReturnType<typeof createPet>>) => {
    const pet = store.get(CHAT)!;
    Object.assign(pet, patch);
    store.save(pet);
  };
  const outbox = new OutboxStore(db);
  const acknowledgeAll = () => {
    let delivery;
    while ((delivery = outbox.claim(Date.now()))) {
      const current = delivery;
      outbox.sent(current, () => pets.delivered(current));
    }
  };
  return {
    db, store, pets, getConfig, isReady, transport, command, run, enable, change, outbox, acknowledgeAll,
    setReady: (value: boolean) => { ready = value; },
    unapprove: () => { config = { ...config, approvedSenders: [] }; },
  };
}

describe("group pet commands", () => {
  it("routes water and cleaning commands for any group member and shows both stats", async () => {
    const s = setup();
    s.enable();
    s.change({ hydration: 20, cleanliness: 25 });
    await s.run("water");
    await s.run("clean");
    expect(s.store.get(CHAT)).toMatchObject({ hydration: 55, cleanliness: 60 });
    await s.run("status");
    expect(s.transport.sendImage.mock.calls.at(-1)?.[2]).toContain("Water 55/100 | Cleanliness 60/100");
  });
  it.each(SPECIES_IDS)("supports explicit %s selection, multi-word names and species-specific portraits", async (species) => {
    const s = setup();
    await s.run(`enable Sir Cloud species=${species}`, { fromMe: true });
    expect(s.store.get(CHAT)).toMatchObject({ species, name: "Sir Cloud" });
    await s.run("");
    const [, image, caption] = s.transport.sendImage.mock.calls[0];
    expect(image).toEqual(await petPortrait(0, false, species));
    expect(caption).toContain(SPECIES[species].forms[0]);
    expect(caption).toContain(SPECIES[species].name);
    const event = s.outbox.claim(NOW)!;
    expect(s.store.event(event.pet_event_id!)?.species).toBe(species);
  });

  it.each(SPECIES_IDS)("randomly selects %s when the species argument is omitted", (species) => {
    const index = SPECIES_IDS.indexOf(species);
    const s = setup(() => (index + 0.5) / SPECIES_IDS.length);
    s.enable();
    expect(s.store.get(CHAT)?.species).toBe(species);
  });

  it("rejects invalid or duplicate species without creating a pet", async () => {
    const s = setup();
    for (const args of ["enable Mochi species=wolf", "enable species=", "enable species=cat species=fox"]) {
      await s.run(args, { fromMe: true });
      expect(s.store.all()).toHaveLength(0);
      expect(s.transport.sendText.mock.calls.at(-1)?.[1]).toContain("Choose one species");
    }
    await s.run("enable species=FOX", { fromMe: true });
    expect(s.store.get(CHAT)).toMatchObject({ species: "fox", name: "Mochi" });
  });

  it("keeps species on re-enable and rejects attempts to reroll an existing pet", async () => {
    const s = setup();
    await s.run("enable Mochi species=cat", { fromMe: true });
    s.change({ stage: 2, healthyMs: 8 * DAY });
    await s.run("disable", { fromMe: true });
    await s.run("enable species=fox", { fromMe: true });
    expect(s.store.get(CHAT)).toMatchObject({ species: "cat", enabled: false, stage: 2 });
    await s.run("enable", { fromMe: true });
    const resumed = new PetService(s.store, s.getConfig, s.isReady, () => 0.99);
    expect(resumed.store.get(CHAT)).toMatchObject({ species: "cat", enabled: true, healthyMs: 8 * DAY });
  });

  it("migrates legacy pets and queued pictures to the original bird species", () => {
    const s = setup();
    s.enable();
    const pet = s.store.get(CHAT)!;
    const { species: _species, ...legacy } = pet;
    s.db.prepare("UPDATE pets SET state = ? WHERE chat_id = ?").run(JSON.stringify(legacy), CHAT);
    expect(s.store.get(CHAT)?.species).toBe("bird");
    const resumed = new PetService(s.store, s.getConfig, s.isReady);
    expect(resumed.store.all()[0].species).toBe("bird");
    const event = s.outbox.claim(NOW)!;
    expect(s.store.event(event.pet_event_id!)?.species).toBe("bird");
  });

  it("is opt-in, group-only, and requires explicit approval even for the owner", async () => {
    const s = setup();
    await s.run("enable", { isGroup: false, fromMe: true });
    expect(s.store.all()).toHaveLength(0);
    await s.run("enable", { chatId: "unknown@g.us", fromMe: true });
    expect(s.store.all()).toHaveLength(0);
    expect(s.transport.sendText.mock.calls.at(-1)?.[1]).toMatch(/Approve this group/);
  });

  it("restricts settings to the owner or a verified group admin", async () => {
    const s = setup();
    await s.run("enable");
    expect(s.store.all()).toHaveLength(0);
    s.transport.isGroupAdmin.mockRejectedValueOnce(new Error("offline"));
    await s.run("enable");
    expect(s.transport.sendText.mock.calls.at(-1)?.[1]).toMatch(/couldn't verify/);
    s.transport.isGroupAdmin.mockResolvedValue(true);
    await s.run("enable Cloudy");
    expect(s.store.get(CHAT)?.name).toBe("Cloudy");
    await s.run("rename Fluffy", { fromMe: true });
    expect(s.store.get(CHAT)?.name).toBe("Fluffy");
  });

  it("isolates pets by group ID and allows any member to care for them", async () => {
    const s = setup();
    await s.run("enable Mochi", { fromMe: true });
    await s.run("enable Cloud", { chatId: "second@g.us", fromMe: true });
    s.change({ hunger: 40 });
    await s.run("feed");
    expect(s.store.get(CHAT)?.hunger).toBe(75);
    expect(s.store.get("second@g.us")?.hunger).toBe(100);
    await s.run("feed");
    expect(s.store.get(CHAT)?.hunger).toBe(75);
    expect(s.transport.sendText.mock.calls.at(-1)?.[1]).toMatch(/cooldown/);
  });

  it("validates names and waking hours and supports overnight hours", async () => {
    const s = setup();
    await s.run(`enable ${"a".repeat(41)}`, { fromMe: true });
    expect(s.store.all()).toHaveLength(0);
    await s.run("enable Mochi", { fromMe: true });
    for (const args of ["rename", "hours 3 3", "hours 24 4", "hours 8.5 12", "hours 8 22 extra"]) {
      await s.run(args, { fromMe: true });
    }
    expect(s.store.get(CHAT)?.wakeStart).toBe(8);
    await s.run("hours 22 6", { fromMe: true });
    expect(s.store.get(CHAT)).toMatchObject({ wakeStart: 22, wakeEnd: 6 });
  });

  it("sends a PNG portrait with status and backfills the command on old installs", async () => {
    const s = setup();
    s.enable();
    await s.run("");
    const [, image, caption] = s.transport.sendImage.mock.calls[0];
    expect((await sharp(image).metadata()).format).toBe("png");
    expect(caption).toMatch(/Cloud Egg/);
    s.db.prepare("INSERT INTO kv (key,value) VALUES ('config', ?), ('config_version','13')")
      .run(JSON.stringify({ ...DEFAULT_CONFIG, commands: { "bot.ask": "ask" } }));
    expect(new ConfigStore(s.db).load().commands["bot.pet"]).toBe("pet");
  });

  it("rolls back enabling if the durable notification cannot be written", () => {
    const s = setup();
    s.db.exec("CREATE TRIGGER reject_pet_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => s.enable()).toThrow("write failed");
    expect(s.store.all()).toHaveLength(0);
    expect(s.outbox.claim(NOW)).toBeUndefined();
  });

  it("does not execute its own pet-command examples when the reply prefix is empty", async () => {
    const s = setup();
    s.enable();
    s.change({ hunger: 40 });
    s.getConfig().botReplyPrefix = "";
    const bot = new Bot().use(ignoreOwn(new RuntimeState())).command("bot.pet", s.command);
    await bot.handle(new Context(message({ fromMe: true, isBot: true, text: "Use bot.pet feed!" }), {
      transport: s.transport, getConfig: s.getConfig,
    }));
    expect(s.store.get(CHAT)?.hunger).toBe(40);
    expect(s.transport.sendText).not.toHaveBeenCalled();
  });
});

describe("evolution and neglect", () => {
  it("forces exactly one form, resets progress to its threshold and queues the new portrait", () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.pets.requestNow(CHAT);
    expect(s.pets.evolveNow(CHAT, 0)).toEqual({ ok: true });
    expect(s.store.get(CHAT)).toMatchObject({ stage: 1, healthyMs: DAY, request: null });
    const event = s.outbox.claim(NOW)!;
    expect(event.body).toContain("evolution boost");
    expect(s.store.event(event.pet_event_id!)?.stage).toBe(1);
    expect(s.pets.evolveNow(CHAT, 0)).toMatchObject({ ok: false });
    expect(s.store.get(CHAT)?.stage).toBe(1);
    s.pets.tick(NOW + 1000);
    expect(s.store.get(CHAT)?.stage).toBe(1);
  });

  it("refuses forced evolution for missing, unavailable, hibernating or final-form pets", () => {
    const s = setup();
    expect(s.pets.evolveNow(CHAT, 0)).toMatchObject({ ok: false });
    s.enable();
    for (const patch of [{ enabled: false }, { paused: true }, { hibernating: true }, { stage: 4 }]) {
      s.change({ enabled: true, paused: false, hibernating: false, stage: 0, ...patch });
      expect(s.pets.evolveNow(CHAT, patch.stage ?? 0)).toMatchObject({ ok: false });
    }
    s.change({ stage: 0 });
    s.setReady(false);
    expect(s.pets.evolveNow(CHAT, 0)).toMatchObject({ ok: false });
    s.setReady(true);
    s.unapprove();
    expect(s.pets.evolveNow(CHAT, 0)).toMatchObject({ ok: false });
  });

  it("reports remaining healthy time, freeze reasons, and species-specific next forms", () => {
    const s = setup();
    s.enable();
    s.change({ species: "fox", healthyMs: DAY - HOUR });
    expect(s.pets.evolutionStatus(s.store.get(CHAT)!)).toMatchObject({
      nextForm: "Ember Kit", remainingHealthyMs: HOUR, running: true, canForce: true,
    });
    s.change({ hydration: 20 });
    expect(s.pets.evolutionStatus(s.store.get(CHAT)!)).toMatchObject({
      running: false, frozenReason: expect.stringContaining("critical"), canForce: true,
    });
    s.change({ paused: true });
    expect(s.pets.evolutionStatus(s.store.get(CHAT)!)).toMatchObject({
      running: false, frozenReason: "Pet is paused.", canForce: false,
    });
    s.change({ paused: false, stage: 4 });
    expect(s.pets.evolutionStatus(s.store.get(CHAT)!)).toMatchObject({
      nextForm: null, remainingHealthyMs: 0, running: false, canForce: false,
    });
  });

  it("rolls back forced evolution if its announcement cannot be persisted", () => {
    const s = setup();
    s.enable();
    s.db.exec("CREATE TRIGGER reject_evolution BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => s.pets.evolveNow(CHAT, 0)).toThrow("write failed");
    expect(s.store.get(CHAT)).toMatchObject({ stage: 0, healthyMs: 0 });
  });

  it.each([1, 2, 3, 4])("evolves at the exact healthy-time threshold for stage %i", (stage) => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ stage: stage - 1, healthyMs: STAGES[stage].days * DAY - 60_000 });
    s.pets.tick(NOW + 59_999);
    expect(s.store.get(CHAT)?.stage).toBe(stage - 1);
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.stage).toBe(stage);
    expect(s.outbox.claim(NOW + 60_000)?.body).toMatch(/I evolved/);
  });

  it("does not earn healthy time with critical stats", () => {
    const s = setup();
    s.enable();
    s.change({ hunger: 0, healthyMs: DAY - 30_000 });
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)).toMatchObject({ stage: 0, healthyMs: DAY - 30_000 });
  });

  it("hibernates after 24 critical hours and devolves only once after another 48 hours", () => {
    const s = setup();
    s.enable();
    s.change({ stage: 3, healthyMs: 23 * DAY, hunger: 0, criticalMs: DAY - 60_000 });
    s.pets.tick(NOW + 59_999);
    expect(s.store.get(CHAT)?.hibernating).toBe(false);
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.hibernating).toBe(true);
    s.change({ hibernationMs: 2 * DAY - 60_000 });
    s.pets.tick(NOW + 119_999);
    expect(s.store.get(CHAT)?.stage).toBe(3);
    s.pets.tick(NOW + 120_000);
    expect(s.store.get(CHAT)).toMatchObject({ stage: 2, healthyMs: 7 * DAY, devolved: true });
    s.change({ hibernationMs: 100 * DAY });
    s.pets.tick(NOW + 180_000);
    expect(s.store.get(CHAT)?.stage).toBe(2);
  });

  it("never devolves below the egg", () => {
    const s = setup();
    s.enable();
    s.change({ hibernating: true, hibernationMs: 2 * DAY });
    s.pets.tick(NOW + 1000);
    expect(s.store.get(CHAT)?.stage).toBe(0);
  });

  it("freezes clocks during downtime, disconnects, pause, and lost approval", () => {
    const s = setup();
    s.enable();
    s.change({ hunger: 0, criticalMs: DAY - 1 });
    s.pets.tick(NOW + 3 * DAY);
    expect(s.store.get(CHAT)).toMatchObject({ clock: 0, criticalMs: DAY - 1, hibernating: false });
    s.setReady(false);
    s.pets.tick(NOW + 3 * DAY + 60_000);
    expect(s.store.get(CHAT)?.clock).toBe(0);
    s.setReady(true);
    s.pets.command(CHAT, "pause", "", NOW + 3 * DAY + 60_000);
    s.pets.tick(NOW + 3 * DAY + 120_000);
    expect(s.store.get(CHAT)?.clock).toBe(0);
    s.pets.command(CHAT, "resume", "", NOW + 3 * DAY + 120_000);
    s.unapprove();
    s.pets.tick(NOW + 3 * DAY + 180_000);
    expect(s.store.get(CHAT)?.clock).toBe(0);
  });

  it.each([true, false])("rescues in either step order without restoring a lost form (feed first: %s)", (feedFirst) => {
    const s = setup();
    s.enable();
    s.change({ stage: 1, healthyMs: DAY, hibernating: true, devolved: true });
    const answer = RIDDLES[s.store.get(CHAT)!.rescueRiddle].answers[0];
    s.pets.command(CHAT, feedFirst ? "feed" : "answer", feedFirst ? "" : answer);
    expect(s.store.get(CHAT)?.hibernating).toBe(true);
    s.pets.command(CHAT, feedFirst ? "answer" : "feed", feedFirst ? answer : "");
    expect(s.store.get(CHAT)).toMatchObject({
      stage: 1, healthyMs: DAY, hibernating: false, hunger: 60, happiness: 60, energy: 60,
      graceUntil: DAY,
    });
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.hunger).toBe(60);
    expect(s.store.get(CHAT)?.stage).toBe(1);
  });

  it("persists rescue progress and state across service recreation", () => {
    const s = setup();
    s.enable();
    s.change({ stage: 2, hibernating: true, healthyMs: 8 * DAY });
    s.pets.command(CHAT, "feed", "");
    vi.setSystemTime(NOW + 10 * DAY);
    const resumed = new PetService(new PetStore(s.db), s.getConfig, s.isReady);
    expect(resumed.store.get(CHAT)).toMatchObject({
      name: "Mochi", stage: 2, hibernating: true, rescueFed: true, healthyMs: 8 * DAY,
    });
    resumed.tick();
    expect(resumed.store.get(CHAT)?.hibernationMs).toBe(0);
  });
});

describe("scheduled requests and silence", () => {
  it.each(["feed", "water", "clean", "play", "silence"] as const)("can explicitly request %s at the egg stage", (kind) => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    expect(s.pets.requestNow(CHAT, NOW, kind)).toEqual({ ok: true });
    expect(s.store.get(CHAT)).toMatchObject({ stage: 0, request: { kind, manual: true, deadline: null } });
    s.acknowledgeAll();
    expect(s.store.get(CHAT)?.request?.deadline).toBe((kind === "silence" ? 2 : 30) * 60_000);
    if (kind === "play") {
      s.pets.command(CHAT, "answer", "1");
      expect(s.store.get(CHAT)?.request).toBeNull();
    }
  });
  it.each(["water", "clean"] as const)("schedules and completes %s requests with cooldown bypass", (kind) => {
    const s = setup(() => kind === "water" ? 0.4 : 0.8);
    s.enable();
    s.acknowledgeAll();
    s.change({ hydration: 30, cleanliness: 30, lastWater: 0, lastClean: 0 });
    expect(s.pets.requestNow(CHAT)).toEqual({ ok: true });
    expect(s.store.get(CHAT)?.request?.kind).toBe(kind);
    s.acknowledgeAll();
    s.pets.command(CHAT, kind, "");
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.store.get(CHAT)?.[kind === "water" ? "hydration" : "cleanliness"]).toBe(65);
    expect(s.pets.command(CHAT, kind, "")).toContain("cooldown");
  });

  it("decays both needs and freezes them when paused", () => {
    const s = setup();
    s.enable();
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.hydration).toBeCloseTo(100 - 100 / (48 * 60));
    expect(s.store.get(CHAT)?.cleanliness).toBeCloseTo(100 - 100 / (72 * 60));
    s.pets.command(CHAT, "pause", "", NOW + 60_000);
    const before = s.store.get(CHAT)!;
    s.pets.tick(NOW + 120_000);
    expect(s.store.get(CHAT)?.hydration).toBe(before.hydration);
    expect(s.store.get(CHAT)?.cleanliness).toBe(before.cleanliness);
  });

  it.each(["hydration", "cleanliness"] as const)("critical %s stops evolution and causes hibernation", (stat) => {
    const s = setup();
    s.enable();
    s.change({ [stat]: 0, healthyMs: DAY - 60_000, criticalMs: DAY - 60_000 });
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)).toMatchObject({ stage: 0, healthyMs: DAY - 60_000, hibernating: true });
    s.pets.command(CHAT, "water", "", NOW + 60_000);
    s.pets.command(CHAT, "clean", "", NOW + 60_000);
    expect(s.store.get(CHAT)?.hibernating).toBe(true);
    s.pets.command(CHAT, "feed", "", NOW + 60_000);
    s.pets.command(CHAT, "answer", "clock", NOW + 60_000);
    expect(s.store.get(CHAT)).toMatchObject({ hibernating: false, hydration: 60, cleanliness: 60 });
  });

  it("backfills old pets at full water and cleanliness without resetting existing needs", () => {
    const s = setup();
    s.enable();
    const pet = s.store.get(CHAT)!;
    const { hydration: _water, cleanliness: _clean, lastWater: _lastWater, lastClean: _lastClean, ...legacy } = pet;
    s.db.prepare("UPDATE pets SET state = ? WHERE chat_id = ?").run(JSON.stringify({ ...legacy, hunger: 42 }), CHAT);
    expect(s.store.get(CHAT)).toMatchObject({ hunger: 42, hydration: 100, cleanliness: 100, lastWater: -HOUR, lastClean: -HOUR });
    s.pets.command(CHAT, "water", "");
    expect(s.store.get(CHAT)?.hydration).toBe(100);
  });
  it("manually requests outside hours, with no recent activity and a zero daily cap", () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ wakeStart: 22, wakeEnd: 6, lastActivity: NOW - 7 * HOUR, maxRequestsPerDay: 0 });
    expect(s.pets.requestNow(CHAT)).toEqual({ ok: true });
    expect(s.pets.requestNow(CHAT)).toMatchObject({ ok: false });
    const delivery = s.outbox.claim(NOW)!;
    expect(s.pets.deliveryDecision(delivery)).toBe(true);
    expect(s.store.get(CHAT)?.request?.deadline).toBeNull();
    s.outbox.sent(delivery, () => s.pets.delivered(delivery));
    expect(s.store.get(CHAT)?.request).toMatchObject({ manual: true, deadline: 30 * 60_000 });
    expect(s.store.get(CHAT)?.requestsToday).toBe(1);
  });
  it("refuses manual requests for missing, disabled, paused, hibernating or offline pets", () => {
    const s = setup();
    expect(s.pets.requestNow(CHAT)).toMatchObject({ ok: false });
    s.enable();
    for (const patch of [{ enabled: false }, { paused: true }, { hibernating: true }]) {
      s.change({ enabled: true, paused: false, hibernating: false, ...patch });
      expect(s.pets.requestNow(CHAT)).toMatchObject({ ok: false });
      expect(s.store.get(CHAT)?.request).toBeNull();
    }
    s.change({ hibernating: false });
    s.setReady(false);
    expect(s.pets.requestNow(CHAT)).toMatchObject({ ok: false });
  });
  it("updates the first delay even when time has elapsed since creation", () => {
    const s = setup();
    s.enable();
    s.pets.configure(CHAT, { ...DEFAULT_PET_SETTINGS, firstRequestMinutes: 5 }, "Mochi", NOW + 100);
    expect(s.store.get(CHAT)?.nextRequest).toBe(5 * 60_000);
  });
  it("uses configured first delay, spacing, daily cap, activity window and response duration", () => {
    const s = setup(() => 0);
    s.enable();
    s.acknowledgeAll();
    s.pets.configure(CHAT, { ...DEFAULT_PET_SETTINGS, firstRequestMinutes: 1,
      requestMinHours: 0.25, requestMaxHours: 0.25, maxRequestsPerDay: 1,
      activityWindowHours: 0.25, responseMinutes: 5 }, "Mochi");
    s.pets.tick(NOW + 59_999);
    expect(s.store.get(CHAT)?.request).toBeNull();
    vi.setSystemTime(NOW + 60_000);
    s.pets.tick();
    s.acknowledgeAll();
    expect(s.store.get(CHAT)?.request?.deadline).toBe(6 * 60_000);
    expect(s.store.get(CHAT)?.nextRequest).toBe(16 * 60_000);
    s.pets.command(CHAT, "feed", "");
    s.change({ nextRequest: 0 });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
  });

  it("zero daily requests disables requests without stopping care or evolution", () => {
    const s = setup();
    s.enable();
    s.pets.configure(CHAT, { ...DEFAULT_PET_SETTINGS, maxRequestsPerDay: 0 }, "Mochi");
    s.change({ nextRequest: 0, healthyMs: DAY - 60_000, hunger: 40 });
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)).toMatchObject({ stage: 1, request: null });
    s.pets.command(CHAT, "feed", "", NOW + 60_000);
    expect(s.store.get(CHAT)!.hunger).toBeGreaterThan(70);
  });

  it("only requests during waking hours in recently active groups, capped at three/day", () => {
    const s = setup();
    s.enable();
    s.change({ nextRequest: 0, wakeStart: 22, wakeEnd: 6 });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
    s.change({ wakeStart: 8, wakeEnd: 22, lastActivity: NOW - 7 * HOUR });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
    s.change({ lastActivity: NOW, requestDay: "2026-10-15", requestsToday: 3 });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
    s.change({ requestsToday: 2 });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request?.kind).toBe("feed");
    expect(s.store.get(CHAT)?.requestsToday).toBe(2);
    s.pets.tick();
    s.acknowledgeAll();
    expect(s.store.get(CHAT)?.requestsToday).toBe(3);
  });

  it("starts the request deadline only after successful outbox delivery", async () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ nextRequest: 0 });
    s.pets.tick();
    expect(s.store.get(CHAT)?.request?.deadline).toBeNull();
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const worker = new DeliveryWorker(s.outbox, send, logger, () => true, {
      canSend: (d) => s.pets.deliveryDecision(d), onSent: (d) => s.pets.delivered(d),
    });
    await worker.flush();
    expect(s.store.get(CHAT)?.request?.deadline).toBeNull();
    vi.setSystemTime(NOW + 5001);
    await worker.flush();
    expect(s.store.get(CHAT)?.request?.startedAt).toBe(NOW + 5001);
    expect(s.store.get(CHAT)?.request?.deadline).toBe(30 * 60_000 + 5001);
    await worker.stop();
  });

  it("unlocks number games after hatching and accepts the correct shared answer", () => {
    const s = setup(() => 0.99);
    s.enable();
    s.acknowledgeAll();
    s.change({ stage: 1, nextRequest: 0, happiness: 40 });
    s.pets.tick();
    s.acknowledgeAll();
    expect(s.store.get(CHAT)?.request?.kind).toBe("play");
    s.pets.command(CHAT, "answer", "1");
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.command(CHAT, "answer", "5");
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.store.get(CHAT)?.happiness).toBe(70);
  });

  it("allows a delivered feeding request to bypass the normal cooldown", () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ nextRequest: 0, lastFeed: 0, hunger: 40 });
    s.pets.tick();
    s.acknowledgeAll();
    s.pets.command(CHAT, "feed", "");
    expect(s.store.get(CHAT)?.hunger).toBe(75);
    expect(s.store.get(CHAT)?.request).toBeNull();
  });

  it("expires an ignored feeding request at exactly 30 active minutes", () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ nextRequest: 0 });
    s.pets.tick();
    s.acknowledgeAll();
    s.change({ clock: 29 * 60_000 });
    s.pets.tick(NOW + 59_999);
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.outbox.claim(NOW + 60_000)?.body).toMatch(/expired/);
  });

  it("does not send a hibernation picture cancelled by a rescue while artwork was rendering", () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ hunger: 0, criticalMs: DAY - 1000 });
    vi.setSystemTime(NOW + 1000);
    s.pets.tick();
    const delivery = s.outbox.claim(Date.now())!;
    expect(s.pets.canDeliver(delivery)).toBe(true);
    s.pets.command(CHAT, "feed", "");
    s.pets.command(CHAT, "answer", "clock");
    expect(s.store.get(CHAT)?.hibernating).toBe(false);
    expect(s.pets.canDeliver(delivery)).toBe(false);
  });

  it("defers pet sends while unavailable without consuming attempts or delaying reminders", async () => {
    const s = setup();
    s.enable();
    s.setReady(false);
    const send = vi.fn(async (_chatId: string, _body: string) => {});
    const worker = new DeliveryWorker(s.outbox, send, logger, () => true, {
      canSend: (d) => s.pets.deliveryDecision(d), onSent: (d) => s.pets.delivered(d),
    });
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT attempts,status FROM outbox").get()).toEqual({ attempts: 0, status: "pending" });
    s.setReady(true);
    vi.setSystemTime(NOW + 15_000);
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("cancels unsent messages and active requests on disable or lost approval", () => {
    const s = setup();
    s.enable();
    s.change({ nextRequest: 0 });
    s.pets.tick();
    s.pets.command(CHAT, "disable", "");
    expect(s.outbox.claim(NOW)).toBeUndefined();
    expect(s.store.get(CHAT)?.request).toBeNull();
    s.pets.command(CHAT, "enable", "");
    s.change({ nextRequest: 0 });
    s.pets.tick();
    s.unapprove();
    const delivery = s.outbox.claim(NOW)!;
    expect(s.pets.canDeliver(delivery)).toBe(false);
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
  });

  it("defers unsolicited pictures outside waking hours without blocking reminders", async () => {
    const s = setup();
    s.enable();
    s.change({ wakeStart: 22, wakeEnd: 6 });
    new RemindersStore(s.db).add(CHAT, null, "still deliver me", NOW);
    const send = vi.fn(async (_chatId: string, _body: string) => {});
    const worker = new DeliveryWorker(s.outbox, send, logger, () => true, {
      canSend: (d) => s.pets.deliveryDecision(d), onSent: (d) => s.pets.delivered(d),
    });
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("still deliver me");
    const row = s.db.prepare("SELECT attempts,status FROM outbox WHERE pet_event_id IS NOT NULL").get();
    expect(row).toEqual({ attempts: 0, status: "pending" });
    await worker.stop();
  });

  it("releases a permanently failed request so future requests are not stuck", async () => {
    const s = setup();
    s.enable();
    s.acknowledgeAll();
    s.change({ nextRequest: 0 });
    s.pets.tick();
    s.db.prepare("UPDATE outbox SET status = 'failed' WHERE pet_event_id = ?")
      .run(s.store.get(CHAT)!.request!.eventId);
    s.pets.tick();
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.store.get(CHAT)?.nextRequest).toBe(8 * HOUR);
  });

  function silence() {
    const s = setup(() => 0.99);
    s.enable();
    s.acknowledgeAll();
    s.change({ stage: 2, nextRequest: 0, energy: 30 });
    s.pets.tick();
    s.acknowledgeAll();
    return s;
  }

  it("requires the full two minutes and rewards a successful silence challenge", () => {
    const s = silence();
    expect(s.store.get(CHAT)?.request?.kind).toBe("silence");
    s.pets.tick(NOW + 60_000);
    s.pets.tick(NOW + 119_999);
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.tick(NOW + 120_000);
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.store.get(CHAT)!.energy).toBeGreaterThan(89);
  });

  it("measures silence from acknowledgement, not from the previous scheduler tick", () => {
    const s = setup(() => 0.99);
    s.enable();
    s.acknowledgeAll();
    s.change({ stage: 2, nextRequest: 0 });
    s.pets.tick();
    vi.setSystemTime(NOW + 14_500);
    s.acknowledgeAll();
    expect(s.store.get(CHAT)?.request?.deadline).toBe(134_500);
    s.pets.tick(NOW + 60_000);
    s.pets.tick(NOW + 120_000);
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.tick(NOW + 134_499);
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.tick(NOW + 134_500);
    expect(s.store.get(CHAT)?.request).toBeNull();
  });

  it.each(["text", "sticker", "audio", "image", "video"] as const)("a human %s wakes the pet", (kind) => {
    const s = silence();
    s.pets.observe(message({ kind, timestamp: NOW + 1000 }), NOW + 1000);
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.outbox.claim(NOW + 1000)?.body).toMatch(/woke me/);
  });

  it("counts owner chatter but ignores bot output, old history, and other chats", () => {
    const s = silence();
    s.pets.observe(message({ fromMe: true, isBot: true, text: null, kind: "image" }));
    s.pets.observe(message({ fromMe: true, text: `${DEFAULT_CONFIG.botReplyPrefix}\nhello` }));
    s.pets.observe(message({ timestamp: NOW - 120_000 }));
    s.pets.observe(message({ chatId: "second@g.us" }));
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    s.pets.observe(message({ fromMe: true }));
    expect(s.store.get(CHAT)?.request).toBeNull();
  });

  it("cancels silence on disconnect or restart rather than claiming unobserved success", () => {
    const s = silence();
    s.setReady(false);
    s.pets.tick(NOW + 60_000);
    expect(s.store.get(CHAT)?.request).toBeNull();
    expect(s.store.get(CHAT)!.energy).toBe(30);
    s.setReady(true);
    s.change({ nextRequest: 0, lastTick: NOW });
    s.pets.tick();
    s.acknowledgeAll();
    const resumed = new PetService(s.store, s.getConfig, s.isReady);
    expect(resumed.store.get(CHAT)?.request).toBeNull();
  });

  it("observes stickers and owner chatter before their usual middleware filters, after deduplication", async () => {
    const s = silence();
    const seen = new SeenStore(s.db);
    const bot = new Bot()
      .use(approvedSenderGuard).use(dedupe(seen)).use(petObserver(s.pets))
      .use(ignoreOwn(new RuntimeState())).use(mediaPolicy);
    seen.mark("msg", "duplicate");
    await bot.handle(new Context(message({ messageId: "duplicate", kind: "sticker" }), {
      transport: s.transport, getConfig: s.getConfig,
    }));
    expect(s.store.get(CHAT)?.request).not.toBeNull();
    await bot.handle(new Context(message({ messageId: "owner-chat", fromMe: true }), {
      transport: s.transport, getConfig: s.getConfig,
    }));
    expect(s.store.get(CHAT)?.request).toBeNull();
  });
});

describe("original stage pictures", () => {
  it("renders forty distinct 512x512 PNGs and caches each species/stage variant", async () => {
    const pictures = await Promise.all(SPECIES_IDS.flatMap((species) => STAGES.flatMap((_, stage) => [
      petPortrait(stage, false, species), petPortrait(stage, true, species),
    ])));
    expect(new Set(pictures.map((p) => p.toString("base64"))).size).toBe(40);
    for (const image of pictures) {
      expect(await sharp(image).metadata()).toMatchObject({ format: "png", width: 512, height: 512 });
    }
    expect(await petPortrait(0)).toBe(pictures[0]);
    expect(() => petPortrait(5)).toThrow(/Invalid pet portrait/);
  });
});
