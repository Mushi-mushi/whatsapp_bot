import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { openDatabase } from "../src/state/db.js";
import { UserMemoryStore, UserProfileStore } from "../src/state/repos.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { ProfileService } from "../src/handlers/profiles/service.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";

const ollama = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../src/util/ollama.js", () => ({
  ollamaChat: ollama.chat,
  ollamaErrorMessage: () => "err",
}));

const silent = pino({ level: "silent" });

function setup(cfg: BotConfig = DEFAULT_CONFIG) {
  const db = openDatabase(":memory:");
  const memory = new UserMemoryStore(db);
  const profiles = new UserProfileStore(db);
  const jobs = new BackgroundJobs(() => {});
  const service = new ProfileService(memory, profiles, jobs, () => cfg, silent);
  return { memory, profiles, service };
}

beforeEach(() => {
  ollama.chat.mockReset();
  // First call = deep dossier, second = short briefing.
  ollama.chat
    .mockResolvedValueOnce({ ok: true, content: "DEEP: likes hiking and coffee" })
    .mockResolvedValueOnce({ ok: true, content: "Hiker and coffee lover." });
});

describe("ProfileService.refresh", () => {
  it("builds and stores a deep + short profile", async () => {
    const { memory, profiles, service } = setup();
    for (let i = 0; i < 5; i++) memory.record("k1", "Alice", null, `message about hiking ${i}`, 50);

    const result = await service.refresh("k1", "Alice");
    expect(result?.deep).toBe("DEEP: likes hiking and coffee");
    expect(profiles.get("k1")?.short).toBe("Hiker and coffee lover.");
    expect(service.shortFor("k1")).toBe("Hiker and coffee lover.");
    // last_profiled_id advances to the newest recorded message.
    expect(profiles.get("k1")?.last_profiled_id).toBe(memory.latestId("k1"));
  });

  it("merges the existing dossier into the new one", async () => {
    const { memory, service } = setup();
    for (let i = 0; i < 5; i++) memory.record("k1", "Alice", null, `hiking ${i}`, 50);
    await service.refresh("k1", "Alice");

    ollama.chat
      .mockResolvedValueOnce({ ok: true, content: "DEEP v2" })
      .mockResolvedValueOnce({ ok: true, content: "short v2" });
    memory.record("k1", "Alice", null, "now i also love climbing", 50);
    await service.refresh("k1", "Alice");

    // The second deep-builder call should have received the previous dossier.
    const deepCall = ollama.chat.mock.calls[2][1] as { role: string; content: string }[];
    expect(deepCall[1].content).toContain("DEEP: likes hiking and coffee");
  });

  it("does nothing with too few messages", async () => {
    const { memory, service } = setup();
    memory.record("k1", "Alice", null, "just one", 50);
    expect(await service.refresh("k1", "Alice")).toBeNull();
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("falls back to the deep text when the short call fails", async () => {
    const { memory, service } = setup();
    ollama.chat.mockReset();
    ollama.chat
      .mockResolvedValueOnce({ ok: true, content: "DEEP only" })
      .mockResolvedValueOnce({ ok: false, reason: "timeout" });
    for (let i = 0; i < 5; i++) memory.record("k1", "Alice", null, `msg ${i}`, 50);

    const result = await service.refresh("k1", "Alice");
    expect(result?.short).toBe("DEEP only");
  });
});

describe("ProfileService.maybeRefresh (staleness)", () => {
  it("schedules a rebuild once enough new messages arrive", async () => {
    const cfg = { ...DEFAULT_CONFIG, profileRefreshEvery: 3 };
    const { memory, profiles, service } = setup(cfg);
    for (let i = 0; i < 5; i++) memory.record("k1", "Alice", null, `msg ${i}`, 50);

    service.maybeRefresh("k1", "Alice");
    // The background job runs synchronously via the queue pump.
    await new Promise((r) => setTimeout(r, 0));
    expect(profiles.get("k1")).toBeTruthy();
  });

  it("does not reschedule when the profile is fresh", async () => {
    const cfg = { ...DEFAULT_CONFIG, profileRefreshEvery: 100 };
    const { memory, profiles, service } = setup(cfg);
    for (let i = 0; i < 5; i++) memory.record("k1", "Alice", null, `msg ${i}`, 50);
    await service.refresh("k1", "Alice");
    ollama.chat.mockClear();

    service.maybeRefresh("k1", "Alice");
    await new Promise((r) => setTimeout(r, 0));
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(profiles.get("k1")?.deep).toBe("DEEP: likes hiking and coffee");
  });
});
