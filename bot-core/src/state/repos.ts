import type Database from "better-sqlite3";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../config/schema.js";
import type { ChatIdentity } from "../transport/types.js";

const CONFIG_KEY = "config";
const CONFIG_VERSION_KEY = "config_version";
// Bump when DEFAULT_CONFIG.commands gains new triggers that should be backfilled
// into existing installs. v2 adds weather/fact/8ball/quote/siesta/complain/score/
// top.positive/top.negative/torture/insults. v3 adds ask (Ollama). v4 adds
// seen/tell/remind/karma. v5 adds translate/tldr/roll/trivia. v6 adds paint.
const CONFIG_VERSION = 6;

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
    this.db.prepare("INSERT OR IGNORE INTO chat_directory (id, name, updated_at) SELECT jid, name, updated_at FROM contacts").run();
  }

  upsert(chats: ChatIdentity[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO chat_directory (id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
    );
    const now = Date.now();
    const tx = this.db.transaction((list: ChatIdentity[]) => {
      for (const chat of list) {
        if (chat.id && chat.name.trim()) stmt.run(chat.id, chat.name.trim(), now);
      }
    });
    tx(chats);
  }

  list(): ChatIdentity[] {
    return this.db.prepare("SELECT id, name FROM chat_directory ORDER BY name COLLATE NOCASE").all() as ChatIdentity[];
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

export interface SeenRecord {
  name: string;
  last_ts: number;
  chat_name: string | null;
}

export class SeenActivityStore {
  constructor(private readonly db: Database.Database) {}

  record(nameNorm: string, name: string, ts: number, chatName: string | null): void {
    this.db
      .prepare(
        `INSERT INTO seen_activity (name_norm, name, last_ts, chat_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(name_norm) DO UPDATE SET name = excluded.name, last_ts = excluded.last_ts, chat_name = excluded.chat_name`,
      )
      .run(nameNorm, name, ts, chatName);
  }

  get(nameNorm: string): SeenRecord | undefined {
    return this.db
      .prepare("SELECT name, last_ts, chat_name FROM seen_activity WHERE name_norm = ?")
      .get(nameNorm) as SeenRecord | undefined;
  }
}

export interface Tell {
  target_name: string;
  from_name: string;
  message: string;
  created_ts: number;
}

export class TellStore {
  constructor(private readonly db: Database.Database) {}

  add(targetNorm: string, targetName: string, fromName: string, message: string): void {
    this.db
      .prepare(
        "INSERT INTO tells (target_norm, target_name, from_name, message, created_ts) VALUES (?, ?, ?, ?, ?)",
      )
      .run(targetNorm, targetName, fromName, message, Date.now());
  }

  enqueueFor(targetNorm: string, chatId: string, senderName: string): void {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, from_name, message FROM tells WHERE target_norm = ? ORDER BY id")
        .all(targetNorm) as (Tell & { id: number })[];
      const now = Date.now();
      for (const row of rows) {
        this.db.prepare("INSERT INTO outbox (chat_id, body, available_at, created_at) VALUES (?, ?, ?, ?)")
          .run(chatId, `${senderName}, ${row.from_name} said: ${row.message}`, now, now);
        this.db.prepare("DELETE FROM tells WHERE id = ?").run(row.id);
      }
    })();
  }
}

export interface KarmaRecord {
  name: string;
  points: number;
}

export class KarmaStore {
  constructor(private readonly db: Database.Database) {}

  adjust(nameNorm: string, name: string, delta: number): number {
    this.db
      .prepare(
        `INSERT INTO karma (name_norm, name, points) VALUES (?, ?, ?)
         ON CONFLICT(name_norm) DO UPDATE SET points = points + excluded.points, name = excluded.name`,
      )
      .run(nameNorm, name, delta);
    const row = this.db
      .prepare("SELECT points FROM karma WHERE name_norm = ?")
      .get(nameNorm) as { points: number };
    return row.points;
  }

  get(nameNorm: string): KarmaRecord | undefined {
    return this.db
      .prepare("SELECT name, points FROM karma WHERE name_norm = ?")
      .get(nameNorm) as KarmaRecord | undefined;
  }

  top(limit = 5): KarmaRecord[] {
    return this.db
      .prepare("SELECT name, points FROM karma ORDER BY points DESC LIMIT ?")
      .all(limit) as KarmaRecord[];
  }
}

export interface Reminder {
  id: number;
  chat_id: string;
  target_name: string | null;
  text: string;
  due_ts: number;
}

export class RemindersStore {
  constructor(private readonly db: Database.Database) {}

  add(chatId: string, targetName: string | null, text: string, dueTs: number): void {
    this.db
      .prepare(
        "INSERT INTO reminders (chat_id, target_name, text, due_ts, created_ts) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chatId, targetName, text, dueTs, Date.now());
  }

  due(now: number): Reminder[] {
    return this.db
      .prepare("SELECT id, chat_id, target_name, text, due_ts FROM reminders WHERE due_ts <= ? ORDER BY due_ts")
      .all(now) as Reminder[];
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  }
}

export interface TriviaScore {
  name: string;
  correct: number;
}

export class TriviaScoreStore {
  constructor(private readonly db: Database.Database) {}

  // Adjust a player's score by delta (negative for a wrong answer). Returns the new total.
  add(chatId: string, nameNorm: string, name: string, delta: number): number {
    this.db
      .prepare(
        `INSERT INTO trivia_scores (chat_id, name_norm, name, correct) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, name_norm) DO UPDATE SET correct = correct + excluded.correct, name = excluded.name`,
      )
      .run(chatId, nameNorm, name, delta);
    const row = this.db
      .prepare("SELECT correct FROM trivia_scores WHERE chat_id = ? AND name_norm = ?")
      .get(chatId, nameNorm) as { correct: number };
    return row.correct;
  }

  top(chatId: string, limit = 5): TriviaScore[] {
    return this.db
      .prepare("SELECT name, correct FROM trivia_scores WHERE chat_id = ? ORDER BY correct DESC LIMIT ?")
      .all(chatId, limit) as TriviaScore[];
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM trivia_scores").run();
  }
}
