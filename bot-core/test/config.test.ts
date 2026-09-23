import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { ConfigStore } from "../src/state/repos.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { REDACTED, redactSecrets, restoreSecrets } from "../src/config/secrets.js";

describe("ConfigStore.load", () => {
  it("seeds DEFAULT_CONFIG on a fresh database", () => {
    const db = openDatabase(":memory:");
    const store = new ConfigStore(db);
    const cfg = store.load();
    expect(cfg.commands["bot.status"]).toBe("status");
    expect(cfg.approvedSenders).toEqual([]);
  });

  it("backfills new default commands without touching other settings", () => {
    const db = openDatabase(":memory:");
    // Simulate an old install predating most commands.
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(
      "config",
      JSON.stringify({ approvedSenders: ["MyGroup"], commands: { "bot.jokes": "jokes" } }),
    );
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("config_version", "1");

    const cfg = new ConfigStore(db).load();

    // Existing settings preserved.
    expect(cfg.approvedSenders).toEqual(["MyGroup"]);
    expect(cfg.commands["bot.jokes"]).toBe("jokes");
    // Missing default commands backfilled.
    expect(cfg.commands["bot.paint"]).toBe("paint");
    expect(cfg.commands["bot.status"]).toBe("status");
  });

  it("does not re-run the backfill once at the current version", () => {
    const db = openDatabase(":memory:");
    const store = new ConfigStore(db);
    store.load(); // seeds + sets current version

    // Remove a default command; a fresh load must NOT re-add it (version is current).
    const saved = store.load();
    delete saved.commands["bot.paint"];
    store.save(saved);

    const reloaded = store.load();
    expect(reloaded.commands["bot.paint"]).toBeUndefined();
  });
});

describe("secret redaction", () => {
  const base: BotConfig = {
    ...DEFAULT_CONFIG,
    redditClientSecret: "shhh",
    redditRefreshToken: "refresh",
  };

  it("masks set secret fields for outbound responses", () => {
    const out = redactSecrets(base);
    expect(out.redditClientSecret).toBe(REDACTED);
    expect(out.redditRefreshToken).toBe(REDACTED);
  });

  it("leaves empty secrets empty", () => {
    const out = redactSecrets(DEFAULT_CONFIG);
    expect(out.redditClientSecret).toBe("");
  });

  it("restores redacted secrets from the stored config on save", () => {
    const incoming = redactSecrets(base); // what a client would round-trip
    const restored = restoreSecrets(incoming, base);
    expect(restored.redditClientSecret).toBe("shhh");
    expect(restored.redditRefreshToken).toBe("refresh");
  });

  it("keeps an explicitly changed secret", () => {
    const incoming: BotConfig = { ...base, redditClientSecret: "new-value" };
    const restored = restoreSecrets(incoming, base);
    expect(restored.redditClientSecret).toBe("new-value");
  });
});
