import type Database from "better-sqlite3";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../config/schema.js";

const CONFIG_KEY = "config";
const CONFIG_VERSION_KEY = "config_version";
// Bump when DEFAULT_CONFIG.commands gains new triggers that should be backfilled
// into existing installs. v2 adds weather/fact/8ball/quote/siesta/complain/score/
// top.positive/top.negative/torture/insults. v3 adds ask (Ollama).
const CONFIG_VERSION = 3;

// Config persisted as a single JSON row, validated through the zod schema on read/write.
export class ConfigStore {
  constructor(private readonly db: Database.Database) {}

  load(): BotConfig {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(CONFIG_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      this.save(DEFAULT_CONFIG);
      this.setVersion(CONFIG_VERSION);
      return DEFAULT_CONFIG;
    }
    let config: BotConfig;
    try {
      config = ConfigSchema.parse(JSON.parse(row.value));
    } catch {
      return DEFAULT_CONFIG;
    }
    return this.backfillCommands(config);
  }

  save(config: BotConfig): BotConfig {
    const parsed = ConfigSchema.parse(config);
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(CONFIG_KEY, JSON.stringify(parsed));
    return parsed;
  }

  private getVersion(): number {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(CONFIG_VERSION_KEY) as
      | { value: string }
      | undefined;
    return row ? Number(row.value) || 0 : 0;
  }

  private setVersion(version: number): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(CONFIG_VERSION_KEY, String(version));
  }

  // One-time, additive migration: add any new default command triggers the install
  // predates. Never removes triggers and never touches other settings (approvedSenders).
  private backfillCommands(config: BotConfig): BotConfig {
    if (this.getVersion() >= CONFIG_VERSION) return config;
    const commands = { ...config.commands };
    let changed = false;
    for (const [trigger, name] of Object.entries(DEFAULT_CONFIG.commands)) {
      if (!(trigger in commands)) {
        commands[trigger] = name;
        changed = true;
      }
    }
    const next = changed ? { ...config, commands } : config;
    if (changed) this.save(next);
    this.setVersion(CONFIG_VERSION);
    return next;
  }
}

export class SeenStore {
  private readonly maxPerSender = 5000;

  constructor(private readonly db: Database.Database) {}

  has(senderNorm: string, messageId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM seen_messages WHERE sender_norm = ? AND message_id = ?")
      .get(senderNorm, messageId);
    return !!row;
  }

  mark(senderNorm: string, messageId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO seen_messages (sender_norm, message_id, seen_at) VALUES (?, ?, ?)",
      )
      .run(senderNorm, messageId, Date.now());
    // Bound history per sender.
    this.db
      .prepare(
        `DELETE FROM seen_messages
         WHERE sender_norm = ?
           AND message_id NOT IN (
             SELECT message_id FROM seen_messages
             WHERE sender_norm = ? ORDER BY seen_at DESC LIMIT ?
           )`,
      )
      .run(senderNorm, senderNorm, this.maxPerSender);
  }
}

export class KnownChatsStore {
  constructor(private readonly db: Database.Database) {
    // Drop any raw JIDs recorded before chat-name resolution existed.
    this.db.prepare("DELETE FROM known_chats WHERE chat_name LIKE '%@%'").run();
  }

  upsert(names: string[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO known_chats (chat_name, updated_at) VALUES (?, ?) ON CONFLICT(chat_name) DO UPDATE SET updated_at = excluded.updated_at",
    );
    const now = Date.now();
    const tx = this.db.transaction((list: string[]) => {
      for (const name of list) {
        const clean = name.trim();
        // Skip raw JIDs — only human-readable chat names belong in the picker.
        if (clean && !clean.includes("@")) stmt.run(clean, now);
      }
    });
    tx(names);
  }

  list(): string[] {
    const rows = this.db
      .prepare("SELECT chat_name FROM known_chats ORDER BY chat_name COLLATE NOCASE")
      .all() as { chat_name: string }[];
    return rows.map((r) => r.chat_name);
  }
}

export interface SentimentEntry {
  sender: string;
  polarity: number;
  message: string;
}

export class SentimentStore {
  constructor(private readonly db: Database.Database) {}

  log(sender: string, sentiment: string, polarity: number, message: string): void {
    this.db
      .prepare(
        "INSERT INTO sentiment_log (ts, sender, sentiment, polarity, message) VALUES (?, ?, ?, ?, ?)",
      )
      .run(Date.now(), sender, sentiment, polarity, message);
  }

  scoreFor(sender: string): { total: number; count: number } {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(polarity), 0) AS total, COUNT(*) AS count FROM sentiment_log WHERE sender = ? COLLATE NOCASE",
      )
      .get(sender) as { total: number; count: number };
    return { total: row.total, count: row.count };
  }

  top(order: "ASC" | "DESC", limit = 5): SentimentEntry[] {
    return this.db
      .prepare(
        `SELECT sender, polarity, message FROM sentiment_log ORDER BY polarity ${order} LIMIT ?`,
      )
      .all(limit) as SentimentEntry[];
  }
}

export class ComplaintStore {
  constructor(private readonly db: Database.Database) {}

  log(sender: string, message: string): void {
    this.db
      .prepare("INSERT INTO complaints (ts, sender, message) VALUES (?, ?, ?)")
      .run(Date.now(), sender, message);
  }
}

export interface ContactRecord {
  jid: string;
  phone: string | null;
  name: string;
}

// Persisted contact directory (jid/lid -> saved name + phone). Populated from the
// WhatsApp contacts sync so DM name resolution + name-based approval survive restarts.
export class ContactsStore {
  constructor(private readonly db: Database.Database) {}

  upsertMany(records: ContactRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO contacts (jid, phone, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET phone = excluded.phone, name = excluded.name, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    const tx = this.db.transaction((list: ContactRecord[]) => {
      for (const r of list) {
        // Only keep human-readable names (skip raw JIDs).
        if (r.jid && r.name && !r.name.includes("@")) stmt.run(r.jid, r.phone, r.name, now);
      }
    });
    tx(records);
  }

  all(): ContactRecord[] {
    return this.db.prepare("SELECT jid, phone, name FROM contacts").all() as ContactRecord[];
  }
}
