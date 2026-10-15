import type Database from "better-sqlite3";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../config/schema.js";
import type { ChatIdentity } from "../transport/types.js";
import { normalizeName } from "../router/normalize.js";

const CONFIG_KEY = "config";
const CONFIG_VERSION_KEY = "config_version";
// Bump when DEFAULT_CONFIG.commands gains new triggers that should be backfilled
// into existing installs. v2 adds weather/fact/8ball/quote/siesta/complain/score/
// top.positive/top.negative/torture/insults. v3 adds ask (Ollama). v4 adds
// seen/tell/remind/karma. v5 adds translate/tldr/roll/trivia. v6 adds paint.
// v7 adds film. v8 adds meteo. v9 adds profile. v10 adds instadelete. v11 adds whoami.
// v12 adds ask.raw (no-profile ask) and as (impersonate a profiled user).
// v13 adds models (list installed Ollama models).
// v14 adds the opt-in, per-group pet. v15 adds owner-controlled AI service toggles.
const CONFIG_VERSION = 15;

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

export interface UserMessage {
  name: string;
  chat_name: string | null;
  message: string;
  ts: number;
}

// A distinct person the bot has heard from, identified by a stable sender_key
// (phone digits, else the raw jid/lid) with their latest display name.
export interface KnownUser {
  sender_key: string;
  name: string;
  name_norm: string;
}

// Rolling, bounded record of what each user says, keyed by a STABLE identity
// (phone/jid) rather than display name so two people sharing a pushName never
// merge. The display name is kept only to resolve name-based lookups (bot.profile
// Alice) and to label output. Powers personalization for bot.ask / bot.profile.
export class UserMemoryStore {
  constructor(private readonly db: Database.Database) {}

  // Append a message and trim this identity's history to the most recent `limit`.
  record(senderKey: string, name: string, chatName: string | null, message: string, limit: number): void {
    this.db
      .prepare(
        "INSERT INTO user_messages (sender_key, name_norm, name, chat_name, message, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(senderKey, normalizeName(name), name, chatName, message, Date.now());
    this.db
      .prepare(
        `DELETE FROM user_messages
         WHERE sender_key = ?
           AND id NOT IN (
             SELECT id FROM user_messages WHERE sender_key = ? ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(senderKey, senderKey, limit);
  }

  // Most recent messages for an identity, returned oldest-first for natural reading.
  recentFor(senderKey: string, limit = 20): UserMessage[] {
    const rows = this.db
      .prepare(
        "SELECT name, chat_name, message, ts FROM user_messages WHERE sender_key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(senderKey, limit) as UserMessage[];
    return rows.reverse();
  }

  // Highest stored row id for an identity (0 if none) — a high-water mark used to
  // tell how many new messages have arrived since a profile was last built.
  latestId(senderKey: string): number {
    const row = this.db
      .prepare("SELECT MAX(id) AS maxId FROM user_messages WHERE sender_key = ?")
      .get(senderKey) as { maxId: number | null };
    return row.maxId ?? 0;
  }

  // How many messages this identity has sent with id greater than `sinceId`.
  countSince(senderKey: string, sinceId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM user_messages WHERE sender_key = ? AND id > ?")
      .get(senderKey, sinceId) as { n: number };
    return row.n;
  }

  // Resolve a typed name to the most-recently-active identity using it. When two
  // people share a name, the one who spoke most recently wins.
  keyForName(nameNorm: string): KnownUser | undefined {
    return this.db
      .prepare(
        `SELECT sender_key, name, name_norm FROM user_messages
         WHERE name_norm = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(nameNorm) as KnownUser | undefined;
  }

  // Like keyForName, but only among people who have spoken in a given chat — used
  // to restrict profile lookups to participants of the current chat.
  keyForNameInChat(nameNorm: string, chatName: string): KnownUser | undefined {
    return this.db
      .prepare(
        `SELECT sender_key, name, name_norm FROM user_messages
         WHERE name_norm = ? AND chat_name = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(nameNorm, chatName) as KnownUser | undefined;
  }

  // Distinct identities the bot has heard from (most recently active first).
  knownUsers(limit = 200): KnownUser[] {
    return this.db
      .prepare(
        `SELECT sender_key, name, name_norm, MAX(id) AS last_id FROM user_messages
         GROUP BY sender_key ORDER BY last_id DESC LIMIT ?`,
      )
      .all(limit) as (KnownUser & { last_id: number })[];
  }

  forget(senderKey: string): number {
    const info = this.db.prepare("DELETE FROM user_messages WHERE sender_key = ?").run(senderKey);
    return info.changes;
  }
}

export interface UserProfile {
  sender_key: string;
  name: string;
  deep: string;
  short: string;
  last_profiled_id: number;
  updated_at: number;
}

// Persisted two-tier personality profiles: `deep` is a long-lived dossier that
// accumulates across refreshes (surviving the rolling user_messages window);
// `short` is a compact briefing cheap enough to inject into bot.ask.
export class UserProfileStore {
  constructor(private readonly db: Database.Database) {}

  get(senderKey: string): UserProfile | undefined {
    return this.db
      .prepare(
        "SELECT sender_key, name, deep, short, last_profiled_id, updated_at FROM user_profiles WHERE sender_key = ?",
      )
      .get(senderKey) as UserProfile | undefined;
  }

  // Summaries for the dashboard (newest first); omits the large deep dossier.
  list(): Omit<UserProfile, "deep" | "last_profiled_id">[] {
    return this.db
      .prepare(
        "SELECT sender_key, name, short, updated_at FROM user_profiles ORDER BY updated_at DESC",
      )
      .all() as Omit<UserProfile, "deep" | "last_profiled_id">[];
  }

  upsert(p: Omit<UserProfile, "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO user_profiles (sender_key, name, deep, short, last_profiled_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sender_key) DO UPDATE SET
           name = excluded.name, deep = excluded.deep, short = excluded.short,
           last_profiled_id = excluded.last_profiled_id, updated_at = excluded.updated_at`,
      )
      .run(p.sender_key, p.name, p.deep, p.short, p.last_profiled_id, Date.now());
  }

  forget(senderKey: string): void {
    this.db.prepare("DELETE FROM user_profiles WHERE sender_key = ?").run(senderKey);
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

export interface TriviaTrophy {
  name: string;
  trophies: number;
}

const TRIVIA_PERIOD_KEY = "trivia_period";

function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export class TriviaScoreStore {
  constructor(private readonly db: Database.Database) {}

  // Lazily closes out the previous month: awards a trophy to each chat's top
  // scorer (ties share it; needs a positive score), then resets the scores.
  private rollover(now: number): void {
    const current = monthKey(now);
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(TRIVIA_PERIOD_KEY) as
      | { value: string }
      | undefined;
    if (row?.value === current) return;
    this.closeMonth(row?.value, now);
  }

  // Awards trophies for `period` (if given) from the current scores, resets them,
  // and marks the month containing `now` as the active one.
  closeMonth(period: string | undefined, now = Date.now()): void {
    this.db.transaction(() => {
      if (period) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO trivia_trophies (chat_id, period, name_norm, name, score)
             SELECT s.chat_id, ?, s.name_norm, s.name, s.correct FROM trivia_scores s
             WHERE s.correct > 0 AND s.correct = (
               SELECT MAX(correct) FROM trivia_scores WHERE chat_id = s.chat_id
             )`,
          )
          .run(period);
        this.db.prepare("DELETE FROM trivia_scores").run();
      }
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(TRIVIA_PERIOD_KEY, monthKey(now));
    })();
  }

  // Adjust a player's score by delta (negative for a wrong answer). Returns the new total.
  add(chatId: string, nameNorm: string, name: string, delta: number, now = Date.now()): number {
    this.rollover(now);
    this.db
      .prepare(
        `INSERT INTO trivia_scores (chat_id, name_norm, name, correct) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, name_norm) DO UPDATE SET correct = correct + excluded.correct, name = excluded.name`,
      )
      .run(chatId, nameNorm, name, delta);
    this.db
      .prepare(
        `INSERT INTO trivia_totals (chat_id, name_norm, name, total) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, name_norm) DO UPDATE SET total = total + excluded.total, name = excluded.name`,
      )
      .run(chatId, nameNorm, name, delta);
    const row = this.db
      .prepare("SELECT correct FROM trivia_scores WHERE chat_id = ? AND name_norm = ?")
      .get(chatId, nameNorm) as { correct: number };
    return row.correct;
  }

  // Lifetime scores (never reset), best first.
  allTime(chatId: string, limit = 5): { name: string; total: number }[] {
    return this.db
      .prepare("SELECT name, total FROM trivia_totals WHERE chat_id = ? ORDER BY total DESC LIMIT ?")
      .all(chatId, limit) as { name: string; total: number }[];
  }

  top(chatId: string, limit = 5, now = Date.now()): TriviaScore[] {
    this.rollover(now);
    return this.db
      .prepare("SELECT name, correct FROM trivia_scores WHERE chat_id = ? ORDER BY correct DESC LIMIT ?")
      .all(chatId, limit) as TriviaScore[];
  }

  // Trophy count per player in a chat, most trophies first.
  trophies(chatId: string, limit = 5): TriviaTrophy[] {
    return this.db
      .prepare(
        `SELECT MAX(name) AS name, COUNT(*) AS trophies FROM trivia_trophies
         WHERE chat_id = ? GROUP BY name_norm ORDER BY trophies DESC, name LIMIT ?`,
      )
      .all(chatId, limit) as TriviaTrophy[];
  }

  // Past monthly winners in a chat, newest first.
  history(chatId: string, months = 6): { period: string; name: string; score: number }[] {
    return this.db
      .prepare(
        `SELECT period, name, score FROM trivia_trophies WHERE chat_id = ?
         ORDER BY period DESC, score DESC LIMIT ?`,
      )
      .all(chatId, months) as { period: string; name: string; score: number }[];
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM trivia_scores").run();
  }
}

const DUEL_PERIOD_KEY = "duel_period";

export interface DuelWin {
  name: string;
  wins: number;
}

// Monthly duel-win tally, mirroring TriviaScoreStore: wins reset each month and a
// trophy goes to the month's top duellist; duel_totals keeps lifetime wins.
export class DuelWinStore {
  constructor(private readonly db: Database.Database) {}

  private rollover(now: number): void {
    const current = monthKey(now);
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(DUEL_PERIOD_KEY) as
      | { value: string }
      | undefined;
    if (row?.value === current) return;
    this.closeMonth(row?.value, now);
  }

  closeMonth(period: string | undefined, now = Date.now()): void {
    this.db.transaction(() => {
      if (period) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO duel_trophies (chat_id, period, name_norm, name, score)
             SELECT w.chat_id, ?, w.name_norm, w.name, w.wins FROM duel_wins w
             WHERE w.wins > 0 AND w.wins = (
               SELECT MAX(wins) FROM duel_wins WHERE chat_id = w.chat_id
             )`,
          )
          .run(period);
        this.db.prepare("DELETE FROM duel_wins").run();
      }
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(DUEL_PERIOD_KEY, monthKey(now));
    })();
  }

  // Record a duel win for a player. Returns their new monthly win count.
  add(chatId: string, nameNorm: string, name: string, now = Date.now()): number {
    this.rollover(now);
    this.db
      .prepare(
        `INSERT INTO duel_wins (chat_id, name_norm, name, wins) VALUES (?, ?, ?, 1)
         ON CONFLICT(chat_id, name_norm) DO UPDATE SET wins = wins + 1, name = excluded.name`,
      )
      .run(chatId, nameNorm, name);
    this.db
      .prepare(
        `INSERT INTO duel_totals (chat_id, name_norm, name, total) VALUES (?, ?, ?, 1)
         ON CONFLICT(chat_id, name_norm) DO UPDATE SET total = total + 1, name = excluded.name`,
      )
      .run(chatId, nameNorm, name);
    const win = this.db
      .prepare("SELECT wins FROM duel_wins WHERE chat_id = ? AND name_norm = ?")
      .get(chatId, nameNorm) as { wins: number };
    return win.wins;
  }

  top(chatId: string, limit = 5, now = Date.now()): DuelWin[] {
    this.rollover(now);
    return this.db
      .prepare("SELECT name, wins FROM duel_wins WHERE chat_id = ? ORDER BY wins DESC LIMIT ?")
      .all(chatId, limit) as DuelWin[];
  }

  allTime(chatId: string, limit = 5): { name: string; total: number }[] {
    return this.db
      .prepare("SELECT name, total FROM duel_totals WHERE chat_id = ? ORDER BY total DESC LIMIT ?")
      .all(chatId, limit) as { name: string; total: number }[];
  }

  trophies(chatId: string, limit = 5): TriviaTrophy[] {
    return this.db
      .prepare(
        `SELECT MAX(name) AS name, COUNT(*) AS trophies FROM duel_trophies
         WHERE chat_id = ? GROUP BY name_norm ORDER BY trophies DESC, name LIMIT ?`,
      )
      .all(chatId, limit) as TriviaTrophy[];
  }
}
