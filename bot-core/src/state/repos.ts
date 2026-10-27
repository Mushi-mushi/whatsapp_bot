import type Database from "better-sqlite3";
import { ConfigSchema, DEFAULT_CONFIG, type BotConfig } from "../config/schema.js";
import type { ChatIdentity } from "../transport/types.js";
import { normalizeName } from "../router/normalize.js";
import type { Contact, PendingTell, ReminderRecurrence, RemindersResponse, ScheduledReminder, SuggestionEntry, SuggestionKind, SuggestionsResponse, TellsResponse } from "../../../shared/api.js";
import { type IdentityResolver, memoryChat, normalizeJid, phoneDigits } from "./identity.js";
export { disciplineKey } from "./identity.js";
import { canonicalMemoryKey, canonicalScope, forPerson, identitiesFor, inChat, memoryKeyAliases, type PersonScope } from "./scoped.js";
import { PlayerScores } from "./player-scores.js";

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
// v16 adds bot.suggest for logging feature suggestions.
// v17 adds the free bot.billing joke bill.
// v18 adds bot.cost and debt-powered bot.mute.
// v19 adds per-chat achievements.
const CONFIG_VERSION = 19;

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
    } catch (cause) {
      throw new Error("Stored bot configuration is invalid. Restore a valid configuration from backup; the original value has been preserved.", { cause });
    }
    return this.backfillCommands(config);
  }

  save(config: BotConfig): BotConfig {
    const parsed = ConfigSchema.parse(config);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(CONFIG_KEY) as { value: string } | undefined;
      const old = previous ? ConfigSchema.parse(JSON.parse(previous.value)) : DEFAULT_CONFIG;
      const identities = identitiesFor(this.db);
      const chatIdentity = (chat: string) => identities.canonical(
        chat.includes("@") ? chat : `${phoneDigits(chat)}@s.whatsapp.net`,
      );
      const enabledBefore = new Set(old.achievementChats.map(chatIdentity));
      const enabledAfter = new Set(parsed.achievementChats.map(chatIdentity));
      this.db.prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
        .run(CONFIG_KEY, JSON.stringify(parsed));
      const now = Date.now();
      const enqueue = this.db.prepare("INSERT INTO outbox(chat_id,body,available_at,created_at) VALUES (?,?,?,?)");
      for (const chat of enabledAfter) if (!enabledBefore.has(chat)) {
        enqueue.run(chat, [
          "Achievements are now enabled in this chat!",
          "Earn badges for messages, bot commands, trivia answers, duel wins, returning after a quiet spell, and messages in a row.",
          "Progress is separate for each person in this chat. Existing progress resumes if achievements were enabled before.",
          "Use bot.achievements to see your badges and progress for free.",
        ].join("\n"), now, now);
      }
      return parsed;
    })();
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
    this.db.prepare("INSERT OR IGNORE INTO chat_directory (id, name, updated_at) SELECT jid, name, updated_at FROM contacts WHERE length(trim(name)) > 0").run();
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

  log(chatId: string, senderId: string, sender: string, sentiment: string, polarity: number, message: string): void {
    const scope = canonicalScope(identitiesFor(this.db), chatId, senderId);
    this.db
      .prepare(
        "INSERT INTO sentiment_log (ts, sender, sentiment, polarity, message, chat_id, sender_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(Date.now(), sender, sentiment, polarity, message, scope.chat_id, scope.sender_id);
  }

  scoreFor(chatId: string, senderId: string): { total: number; count: number } {
    const identities = identitiesFor(this.db);
    const chats = identities.aliasesFor(chatId);
    const senders = identities.aliasesFor(senderId);
    return this.db.prepare(`SELECT COALESCE(SUM(polarity),0) AS total, COUNT(*) AS count FROM sentiment_log
      WHERE chat_id IN (${chats.map(() => "?").join(",")}) AND sender_id IN (${senders.map(() => "?").join(",")})`)
      .get(...chats, ...senders) as { total: number; count: number };
  }

  top(chatId: string, order: "ASC" | "DESC", limit = 5): SentimentEntry[] {
    const chats = identitiesFor(this.db).aliasesFor(chatId);
    return this.db.prepare(`SELECT sender,polarity,message FROM sentiment_log
      WHERE chat_id IN (${chats.map(() => "?").join(",")}) AND sender_id IS NOT NULL
      ORDER BY polarity ${order} LIMIT ?`).all(...chats, limit) as SentimentEntry[];
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

export class SuggestionStore {
  constructor(private readonly db: Database.Database) {}

  log(
    chatId: string,
    senderId: string,
    senderName: string,
    kind: SuggestionKind,
    text: string,
    command: string | null = null,
    now = Date.now(),
  ): number {
    const scope = canonicalScope(identitiesFor(this.db), chatId, senderId);
    const info = this.db
      .prepare(
        "INSERT INTO suggestions (ts, chat_id, sender_id, sender_name, kind, command, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(now, scope.chat_id, scope.sender_id, senderName, kind, command, text);
    return Number(info.lastInsertRowid);
  }

  list(page: number, now = Date.now()): SuggestionsResponse {
    const pageSize = 50;
    return this.db.transaction(() => {
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM suggestions").get() as { total: number };
      const suggestions = this.db.prepare(`SELECT s.id, s.ts AS createdAt, s.chat_id AS chatId, c.name AS chatName,
        s.sender_id AS senderId, s.sender_name AS senderName, s.kind, s.command, s.text
        FROM suggestions s LEFT JOIN chat_directory c ON c.id = s.chat_id
        ORDER BY s.ts DESC, s.id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as SuggestionEntry[];
      return { suggestions, total, page, pageSize, sampledAt: now };
    })();
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM suggestions WHERE id = ?").run(id).changes === 1;
  }
}

export type ContactRecord = Contact;

// Persisted contact directory (jid/lid -> saved name + phone). Populated from the
// WhatsApp sync and verified message aliases. Empty names retain identity only.
export class ContactsStore {
  constructor(private readonly db: Database.Database) {}

  upsertMany(records: ContactRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO contacts (jid, phone, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET phone = COALESCE(excluded.phone, contacts.phone),
       name = CASE WHEN excluded.name = '' THEN contacts.name ELSE excluded.name END,
       updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    const tx = this.db.transaction((list: ContactRecord[]) => {
      const identities = this.identities();
      for (const r of list) {
        if (!r.jid) continue;
        const jid = normalizeJid(r.jid);
        if (r.phone) identities.associate(jid, r.phone);
        const phone = identities.phoneFor(jid) ?? null;
        const name = r.name.includes("@") ? "" : r.name.trim();
        if (name || phone) stmt.run(jid, phone, name, now);
      }
    });
    tx(records);
  }

  all(): ContactRecord[] {
    return this.db.prepare("SELECT jid, phone, name FROM contacts").all() as ContactRecord[];
  }

  identities(): IdentityResolver {
    return identitiesFor(this.db);
  }
}

export interface SeenRecord {
  sender_id: string;
  name: string;
  last_ts: number;
  chat_name: string | null;
}

export class SeenActivityStore {
  constructor(private readonly db: Database.Database) {}

  record(chatId: string, senderId: string, name: string, ts: number, chatName: string | null): void {
    this.db.transaction(() => {
      const identities = identitiesFor(this.db);
      const scope = canonicalScope(identities, chatId, senderId);
      const chats = identities.aliasesFor(chatId);
      const senders = identities.aliasesFor(senderId);
      // This directory holds only the latest label/activity, not historical data.
      this.db.prepare(`DELETE FROM chat_people WHERE chat_id IN (${chats.map(() => "?").join(",")})
        AND sender_id IN (${senders.map(() => "?").join(",")})`).run(...chats, ...senders);
      this.db.prepare("INSERT INTO chat_people (chat_id,sender_id,name_norm,name,last_ts,chat_name) VALUES (?,?,?,?,?,?)")
        .run(scope.chat_id, scope.sender_id, normalizeName(name), name, ts, chatName);
    })();
  }

  people(chatId: string): SeenRecord[] {
    const identities = identitiesFor(this.db);
    const chats = identities.aliasesFor(chatId);
    const rows = this.db.prepare(`SELECT * FROM chat_people WHERE chat_id IN (${chats.map(() => "?").join(",")})
      ORDER BY last_ts,rowid`).all(...chats) as (SeenRecord & PersonScope)[];
    const people = new Map<string, SeenRecord>();
    for (const r of inChat(rows, chatId, identities)) {
      const sender_id = identities.canonical(r.sender_id);
      people.set(sender_id, { sender_id, name: r.name, last_ts: r.last_ts, chat_name: r.chat_name });
    }
    return [...people.values()];
  }

  get(chatId: string, senderId: string): SeenRecord | undefined {
    const id = identitiesFor(this.db).canonical(senderId);
    return this.people(chatId).find((r) => r.sender_id === id);
  }

  resolve(chatId: string, name: string): SeenRecord[] {
    const norm = normalizeName(name);
    return this.people(chatId).filter((r) => normalizeName(r.name) === norm);
  }

  canonical(senderId: string): string {
    return identitiesFor(this.db).canonical(senderId);
  }
}

export interface UserMessage {
  name: string;
  chat_name: string | null;
  message: string;
  ts: number;
}

// A person within one chat, with their latest display name.
export interface KnownUser {
  sender_key: string;
  name: string;
  name_norm: string;
}

// Rolling history keyed by an opaque (chat ID, person ID) tuple.
export class UserMemoryStore {
  constructor(private readonly db: Database.Database) {}

  canonicalKey(senderKey: string): string {
    return canonicalMemoryKey(senderKey, identitiesFor(this.db));
  }

  aliasesForKey(senderKey: string): string[] {
    return this.keysFor(senderKey).keys;
  }

  private keysFor(senderKey: string): { key: string; keys: string[]; placeholders: string } {
    const identities = identitiesFor(this.db);
    const key = canonicalMemoryKey(senderKey, identities);
    const keys = memoryKeyAliases(senderKey, identities);
    return { key, keys, placeholders: keys.map(() => "?").join(",") };
  }

  // Append a message and trim this identity's history to the most recent `limit`.
  record(senderKey: string, name: string, chatName: string | null, message: string, limit: number): void {
    this.db.transaction(() => {
      const { key, keys, placeholders } = this.keysFor(senderKey);
      this.db
        .prepare(
          "INSERT INTO user_messages (sender_key, chat_id, name_norm, name, chat_name, message, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(key, memoryChat(key), normalizeName(name), name, chatName, message, Date.now());
      this.db
        .prepare(
          `DELETE FROM user_messages
           WHERE sender_key IN (${placeholders})
             AND id NOT IN (
               SELECT id FROM user_messages WHERE sender_key IN (${placeholders}) ORDER BY id DESC LIMIT ?
             )`,
        )
        .run(...keys, ...keys, limit);
    })();
  }

  // Most recent messages for an identity, returned oldest-first for natural reading.
  recentFor(senderKey: string, limit = 20): UserMessage[] {
    const { keys, placeholders } = this.keysFor(senderKey);
    const rows = this.db
      .prepare(
        `SELECT name, chat_name, message, ts FROM user_messages WHERE sender_key IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
      )
      .all(...keys, limit) as UserMessage[];
    return rows.reverse();
  }

  // Highest stored row id for an identity (0 if none) — a high-water mark used to
  // tell how many new messages have arrived since a profile was last built.
  latestId(senderKey: string): number {
    const { keys, placeholders } = this.keysFor(senderKey);
    const row = this.db
      .prepare(`SELECT MAX(id) AS maxId FROM user_messages WHERE sender_key IN (${placeholders})`)
      .get(...keys) as { maxId: number | null };
    return row.maxId ?? 0;
  }

  // How many messages this identity has sent with id greater than `sinceId`.
  countSince(senderKey: string, sinceId: number): number {
    const { keys, placeholders } = this.keysFor(senderKey);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM user_messages WHERE sender_key IN (${placeholders}) AND id > ?`)
      .get(...keys, sinceId) as { n: number };
    return row.n;
  }

  usersForNameInChat(nameNorm: string, chatId: string): KnownUser[] {
    return this.knownUsers(chatId).filter((u) => u.name_norm === nameNorm);
  }

  // Distinct identities the bot has heard from (most recently active first).
  knownUsers(chatId: string): KnownUser[] {
    const identities = identitiesFor(this.db);
    const chats = chatId.trim() ? identities.aliasesFor(chatId) : [chatId];
    const placeholders = chats.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT sender_key, name, name_norm FROM user_messages
         WHERE chat_id IN (${placeholders}) AND id IN (
           SELECT MAX(id) FROM user_messages WHERE chat_id IN (${placeholders}) GROUP BY sender_key
         ) ORDER BY id DESC`,
      )
      .all(...chats, ...chats) as KnownUser[];
    const seen = new Set<string>();
    const users: KnownUser[] = [];
    for (const row of rows) {
      const sender_key = canonicalMemoryKey(row.sender_key, identities);
      if (seen.has(sender_key)) continue;
      seen.add(sender_key);
      users.push({ sender_key, name: row.name, name_norm: row.name_norm });
    }
    return users;
  }

  forget(senderKey: string): number {
    const { keys, placeholders } = this.keysFor(senderKey);
    const info = this.db.prepare(`DELETE FROM user_messages WHERE sender_key IN (${placeholders})`).run(...keys);
    return info.changes;
  }
}

export interface UserProfile {
  sender_key: string;
  chat_id: string;
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

  private keysFor(senderKey: string): { key: string; keys: string[]; placeholders: string } {
    const identities = identitiesFor(this.db);
    const key = canonicalMemoryKey(senderKey, identities);
    const keys = memoryKeyAliases(senderKey, identities);
    return { key, keys, placeholders: keys.map(() => "?").join(",") };
  }

  allFor(senderKey: string): UserProfile[] {
    const { keys, placeholders } = this.keysFor(senderKey);
    return this.db
      .prepare(
        `SELECT sender_key, chat_id, name, deep, short, last_profiled_id, updated_at
         FROM user_profiles WHERE sender_key IN (${placeholders}) ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(...keys) as UserProfile[];
  }

  get(senderKey: string): UserProfile | undefined {
    const identities = identitiesFor(this.db);
    const rows = this.allFor(senderKey);
    if (rows.length === 0) return undefined;
    const key = canonicalMemoryKey(senderKey, identities);
    const latest = rows[0];
    return {
      ...latest,
      sender_key: key,
      chat_id: memoryChat(key),
      last_profiled_id: rows.length > 1 ? 0 : latest.last_profiled_id,
    };
  }

  // Summaries for the dashboard (newest first); omits the large deep dossier.
  list(): Omit<UserProfile, "deep" | "last_profiled_id">[] {
    const identities = identitiesFor(this.db);
    const rows = this.db
      .prepare(
        "SELECT sender_key, chat_id, name, short, updated_at FROM user_profiles ORDER BY updated_at DESC, rowid DESC",
      )
      .all() as Omit<UserProfile, "deep" | "last_profiled_id">[];
    const seen = new Set<string>();
    const out: Omit<UserProfile, "deep" | "last_profiled_id">[] = [];
    for (const row of rows) {
      const sender_key = canonicalMemoryKey(row.sender_key, identities);
      if (seen.has(sender_key)) continue;
      seen.add(sender_key);
      out.push({ ...row, sender_key, chat_id: memoryChat(sender_key) });
    }
    return out;
  }

  upsert(p: Omit<UserProfile, "updated_at" | "chat_id">): void {
    this.db.transaction(() => {
      const { key, keys } = this.keysFor(p.sender_key);
      const stale = keys.filter((k) => k !== key);
      if (stale.length > 0) {
        this.db.prepare(`DELETE FROM user_profiles WHERE sender_key IN (${stale.map(() => "?").join(",")})`).run(...stale);
      }
      this.db
        .prepare(
          `INSERT INTO user_profiles (sender_key, chat_id, name, deep, short, last_profiled_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sender_key) DO UPDATE SET
             name = excluded.name, deep = excluded.deep, short = excluded.short,
             last_profiled_id = excluded.last_profiled_id, updated_at = excluded.updated_at`,
        )
        .run(key, memoryChat(key), p.name, p.deep, p.short, p.last_profiled_id, Date.now());
    })();
  }

  forget(senderKey: string): void {
    const { keys, placeholders } = this.keysFor(senderKey);
    this.db.prepare(`DELETE FROM user_profiles WHERE sender_key IN (${placeholders})`).run(...keys);
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

  list(page: number, now = Date.now()): TellsResponse {
    return this.db.transaction(() => {
      const pageSize = 50;
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM tells").get() as { total: number };
      const tells = this.db.prepare(`SELECT t.id, target_name AS targetName, from_name AS fromName,
        message AS text, created_ts AS createdAt, t.chat_id AS chatId, c.name AS chatName,
        target_id AS targetId, CASE WHEN target_id IS NULL OR t.chat_id IS NULL THEN 1 ELSE 0 END AS legacy
        FROM tells t LEFT JOIN chat_directory c ON c.id=t.chat_id ORDER BY created_ts, t.id LIMIT ? OFFSET ?`)
        .all(pageSize, (page - 1) * pageSize) as (Omit<PendingTell, "legacy"> & { legacy: number })[];
      return { tells: tells.map((t) => ({ ...t, legacy: Boolean(t.legacy) })), total, page, pageSize, sampledAt: now };
    })();
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM tells WHERE id = ?").run(id).changes === 1;
  }

  add(chatId: string, targetId: string, targetName: string, fromName: string, message: string): void {
    const scope = canonicalScope(identitiesFor(this.db), chatId, targetId);
    this.db
      .prepare(
        "INSERT INTO tells (target_norm,target_name,from_name,message,created_ts,chat_id,target_id) VALUES (?,?,?,?,?,?,?)",
      )
      .run("", targetName, fromName, message, Date.now(), scope.chat_id, scope.sender_id);
  }

  enqueueFor(targetId: string, chatId: string, senderName: string): void {
    this.db.transaction(() => {
      const candidates = this.db.prepare(`SELECT id,from_name,message,chat_id,target_id AS sender_id
        FROM tells WHERE target_id IS NOT NULL AND chat_id IS NOT NULL ORDER BY id`)
        .all() as (Tell & PersonScope & { id: number })[];
      const rows = forPerson(candidates, chatId, targetId, identitiesFor(this.db));
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

  adjust(chatId: string, senderId: string, name: string, delta: number): number {
    const scope = canonicalScope(identitiesFor(this.db), chatId, senderId);
    this.db
      .prepare(
        `INSERT INTO player_karma (chat_id,sender_id,name,points) VALUES (?,?,?,?)
         ON CONFLICT(chat_id,sender_id) DO UPDATE SET points=points+excluded.points,name=excluded.name`,
      )
      .run(scope.chat_id, scope.sender_id, name, delta);
    return this.get(chatId, senderId)!.points;
  }

  get(chatId: string, senderId: string): KarmaRecord | undefined {
    const id = identitiesFor(this.db).canonical(senderId);
    return this.top(chatId, Number.MAX_SAFE_INTEGER).find((r) => r.senderId === id);
  }

  top(chatId: string, limit = 5): (KarmaRecord & { senderId: string })[] {
    const identities = identitiesFor(this.db);
    const rows = this.db.prepare("SELECT * FROM player_karma").all() as (KarmaRecord & PersonScope)[];
    const players = new Map<string, KarmaRecord & { senderId: string }>();
    for (const r of inChat(rows, chatId, identities)) {
      const senderId = identities.canonical(r.sender_id);
      players.set(senderId, { senderId, name: r.name, points: (players.get(senderId)?.points ?? 0) + r.points });
    }
    for (const p of new SeenActivityStore(this.db).people(chatId)) {
      const player = players.get(p.sender_id);
      if (player) player.name = p.name;
    }
    return [...players.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, limit);
  }
}

export interface Reminder {
  id: number;
  chat_id: string;
  target_name: string | null;
  text: string;
  due_ts: number;
  recurrence: ReminderRecurrence;
}

export class RemindersStore {
  constructor(private readonly db: Database.Database) {}

  add(chatId: string, targetName: string | null, text: string, dueTs: number, recurrence: ReminderRecurrence = "once"): number {
    const info = this.db
      .prepare(
        "INSERT INTO reminders (chat_id, target_name, text, due_ts, created_ts, recurrence) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(chatId, targetName, text, dueTs, Date.now(), recurrence);
    return Number(info.lastInsertRowid);
  }

  get(id: number): ScheduledReminder | undefined {
    return this.db.prepare(`SELECT r.id, r.chat_id AS chatId, c.name AS chatName,
      r.target_name AS targetName, r.text, r.due_ts AS dueAt, r.recurrence
      FROM reminders r LEFT JOIN chat_directory c ON c.id = r.chat_id
      WHERE r.id = ?`).get(id) as ScheduledReminder | undefined;
  }

  update(id: number, targetName: string | null, text: string, dueTs: number, recurrence: ReminderRecurrence): ScheduledReminder | undefined {
    return this.db.transaction(() => {
      const info = this.db
        .prepare("UPDATE reminders SET target_name = ?, text = ?, due_ts = ?, recurrence = ? WHERE id = ?")
        .run(targetName, text, dueTs, recurrence, id);
      if (info.changes !== 1) return undefined;
      return this.get(id);
    })();
  }

  due(now: number): Reminder[] {
    return this.db
      .prepare("SELECT id, chat_id, target_name, text, due_ts, recurrence FROM reminders WHERE due_ts <= ? ORDER BY due_ts")
      .all(now) as Reminder[];
  }

  list(page: number, now = Date.now()): RemindersResponse {
    const pageSize = 50;
    return this.db.transaction(() => {
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM reminders").get() as { total: number };
      const reminders = this.db.prepare(`SELECT r.id, r.chat_id AS chatId, c.name AS chatName,
        r.target_name AS targetName, r.text, r.due_ts AS dueAt, r.recurrence
        FROM reminders r LEFT JOIN chat_directory c ON c.id = r.chat_id
        ORDER BY r.due_ts, r.id LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as ScheduledReminder[];
      return { reminders, total, page, pageSize, sampledAt: now };
    })();
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes === 1;
  }
}

export interface TriviaScore {
  senderId: string;
  name: string;
  correct: number;
}

export interface TriviaTrophy {
  senderId: string;
  name: string;
  trophies: number;
}

export class TriviaScoreStore extends PlayerScores {
  constructor(db: Database.Database) { super(db, "trivia"); }
  add(chatId: string, senderId: string, name: string, delta: number, now = Date.now()): number {
    return this.addPoints(chatId, senderId, name, delta, now);
  }
  top(chatId: string, limit = 5, now = Date.now()): TriviaScore[] {
    return this.current(chatId, limit, now).map(({ senderId, name, score }) => ({ senderId, name, correct: score }));
  }
}

export interface DuelWin {
  senderId: string;
  name: string;
  wins: number;
}

export class DuelWinStore extends PlayerScores {
  constructor(db: Database.Database) { super(db, "duel"); }
  add(chatId: string, senderId: string, name: string, now = Date.now()): number {
    return this.addPoints(chatId, senderId, name, 1, now);
  }
  top(chatId: string, limit = 5, now = Date.now()): DuelWin[] {
    return this.current(chatId, limit, now).map(({ senderId, name, score }) => ({ senderId, name, wins: score }));
  }
}
// UTC calendar day (YYYY-MM-DD) used to enforce the once-a-day siesta limit.
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// Stable per-person key for siesta discipline. Group participants arrive under an
// opaque LID (raw.key.participant) while the dashboard arms them by their phone
// JID from contacts, so both sides must collapse to the same identity. Prefer the
// phone number when known, falling back to the
// phone JID, then the raw id (LID) when no phone is known.
export interface DisciplineEntry {
  chatId: string;
  senderId: string;
  lastSiestaDay: string | null;
  sleepUntil: number | null;
  armed: boolean;
}

interface DisciplineRow {
  chat_id: string;
  sender_id: string;
  last_siesta_day: string | null;
  sleep_until: number | null;
  armed: number;
}

// Per-(chat, sender) siesta discipline: tracks the daily siesta allowance,
// an active "forced sleep" window (messages deleted until it elapses), and an
// "armed" flag so the sender's next bot.siesta puts them to sleep instead.
export class SiestaDisciplineStore {
  constructor(private readonly db: Database.Database) {}

  private matching(chatId: string, senderId: string): DisciplineRow[] {
    const identities = new ContactsStore(this.db).identities();
    const chat = identities.canonical(chatId);
    const sender = identities.canonical(senderId);
    const rows = (chat.endsWith("@g.us")
      ? this.db.prepare("SELECT * FROM siesta_discipline WHERE chat_id = ?").all(chat)
      : this.db.prepare("SELECT * FROM siesta_discipline").all()) as DisciplineRow[];
    return rows.filter((r) => identities.canonical(r.chat_id) === chat &&
      identities.canonical(r.sender_id) === sender);
  }

  private target(chatId: string, senderId: string): [string, string] {
    const identities = new ContactsStore(this.db).identities();
    return [identities.canonical(chatId), identities.canonical(senderId)];
  }

  private toEntry(row: DisciplineRow): DisciplineEntry {
    return {
      chatId: row.chat_id,
      senderId: row.sender_id,
      lastSiestaDay: row.last_siesta_day,
      sleepUntil: row.sleep_until,
      armed: row.armed !== 0,
    };
  }

  get(chatId: string, senderId: string): DisciplineEntry | null {
    const rows = this.matching(chatId, senderId);
    if (!rows.length) return null;
    // Read verified legacy aliases together without rekeying/deleting their rows.
    const days = rows.flatMap((r) => r.last_siesta_day ? [r.last_siesta_day] : []).sort();
    const untils = rows.flatMap((r) => r.sleep_until == null ? [] : [r.sleep_until]);
    return {
      chatId, senderId,
      lastSiestaDay: days.at(-1) ?? null,
      sleepUntil: untils.length ? Math.max(...untils) : null,
      armed: rows.some((r) => r.armed !== 0),
    };
  }

  countToday(chatId: string, senderId: string, day: string): number {
    const identities = new ContactsStore(this.db).identities();
    const [chat, sender] = this.target(chatId, senderId);
    const rows = this.db.prepare("SELECT chat_id, sender_id, used FROM siesta_usage WHERE day = ?")
      .all(day) as { chat_id: string; sender_id: string; used: number }[];
    return rows.filter((row) => identities.canonical(row.chat_id) === chat &&
      identities.canonical(row.sender_id) === sender).reduce((sum, row) => sum + row.used, 0);
  }

  resetUsageForUser(senderId: string): void {
    this.db.transaction(() => {
      const identities = new ContactsStore(this.db).identities();
      const sender = identities.canonical(senderId);
      const usage = this.db.prepare("SELECT chat_id, sender_id FROM siesta_usage").all() as { chat_id: string; sender_id: string }[];
      const remove = this.db.prepare("DELETE FROM siesta_usage WHERE chat_id = ? AND sender_id = ?");
      for (const row of usage) {
        if (identities.canonical(row.sender_id) === sender) remove.run(row.chat_id, row.sender_id);
      }
      const discipline = this.db.prepare("SELECT chat_id, sender_id FROM siesta_discipline").all() as { chat_id: string; sender_id: string }[];
      const clearDay = this.db.prepare("UPDATE siesta_discipline SET last_siesta_day = NULL WHERE chat_id = ? AND sender_id = ?");
      for (const row of discipline) {
        if (identities.canonical(row.sender_id) === sender) clearDay.run(row.chat_id, row.sender_id);
      }
    }).immediate();
  }

  usedToday(chatId: string, senderId: string, day: string): boolean {
    return this.countToday(chatId, senderId, day) > 0;
  }

  isArmed(chatId: string, senderId: string): boolean {
    return this.get(chatId, senderId)?.armed ?? false;
  }

  // The remaining forced-sleep window end for the sender, or null if awake.
  sleepUntil(chatId: string, senderId: string, now = Date.now()): number | null {
    const until = this.get(chatId, senderId)?.sleepUntil ?? null;
    return until != null && until > now ? until : null;
  }

  // Record an allowed siesta without losing usage under verified aliases.
  recordAllowedSiesta(chatId: string, senderId: string, day: string): void {
    this.db.transaction(() => {
      const used = this.countToday(chatId, senderId, day);
      const identities = new ContactsStore(this.db).identities();
      [chatId, senderId] = this.target(chatId, senderId);
      const rows = this.db.prepare("SELECT chat_id, sender_id FROM siesta_usage").all() as { chat_id: string; sender_id: string }[];
      const remove = this.db.prepare("DELETE FROM siesta_usage WHERE chat_id = ? AND sender_id = ?");
      for (const row of rows) {
        if (identities.canonical(row.chat_id) === chatId && identities.canonical(row.sender_id) === senderId) {
          remove.run(row.chat_id, row.sender_id);
        }
      }
      this.db.prepare("INSERT INTO siesta_usage(chat_id, sender_id, day, used) VALUES (?, ?, ?, ?)")
        .run(chatId, senderId, day, used + 1);
      this.db
        .prepare(
          `INSERT INTO siesta_discipline (chat_id, sender_id, last_siesta_day)
           VALUES (?, ?, ?)
           ON CONFLICT(chat_id, sender_id) DO UPDATE SET last_siesta_day = excluded.last_siesta_day`,
        )
        .run(chatId, senderId, day);
    }).immediate();
  }

  // Put the sender to sleep until `until`; also clears any armed flag.
  putToSleep(chatId: string, senderId: string, until: number): void {
    this.db.transaction(() => {
      this.wake(chatId, senderId);
      [chatId, senderId] = this.target(chatId, senderId);
      this.db
        .prepare(
          `INSERT INTO siesta_discipline (chat_id, sender_id, sleep_until, armed)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(chat_id, sender_id) DO UPDATE SET sleep_until = excluded.sleep_until, armed = 0`,
        )
        .run(chatId, senderId, until);
    })();
  }

  // Arm the sender so their next bot.siesta puts them to sleep.
  arm(chatId: string, senderId: string): void {
    [chatId, senderId] = this.target(chatId, senderId);
    this.db
      .prepare(
        `INSERT INTO siesta_discipline (chat_id, sender_id, armed)
         VALUES (?, ?, 1)
         ON CONFLICT(chat_id, sender_id) DO UPDATE SET armed = 1`,
      )
      .run(chatId, senderId);
  }

  // Wake the sender and disarm them, leaving the daily allowance untouched.
  wake(chatId: string, senderId: string): void {
    this.db.transaction(() => {
      const update = this.db.prepare(
        "UPDATE siesta_discipline SET sleep_until = NULL, armed = 0 WHERE chat_id = ? AND sender_id = ?",
      );
      for (const row of this.matching(chatId, senderId)) update.run(row.chat_id, row.sender_id);
    })();
  }

  // Currently sleeping or armed senders, for the dashboard.
  listActive(now = Date.now()): DisciplineEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM siesta_discipline
         WHERE armed = 1 OR (sleep_until IS NOT NULL AND sleep_until > ?)
         ORDER BY sleep_until DESC`,
      )
      .all(now) as DisciplineRow[];
    return rows.map((row) => this.toEntry(row));
  }
}