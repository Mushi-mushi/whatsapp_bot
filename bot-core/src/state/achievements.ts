import type Database from "better-sqlite3";
import type { BotConfig } from "../config/schema.js";
import { phoneDigits } from "./identity.js";
import { canonicalScope, identitiesFor } from "./scoped.js";

export type AchievementMetric =
  | "messages" | "commands" | "trivia" | "duels"
  | "quietDays" | "consecutive"
  | "muteMinutes" | "muteCount" | "billCents";

export type AchievementDelta = AchievementMetric | { metric: AchievementMetric; value: number };

const DAY_MS = 86_400_000;

export const SECRET_ACHIEVEMENTS = [
  { id: "unmute-speedrun", target: 1, name: "Unmute Any% Speedrun", requirement: "Spoke within 10 seconds of a mute expiring" },
  { id: "regret-nothing", target: 1, name: "I Regret Nothing", requirement: "Muted again within 10 minutes of a mute expiring" },
  { id: "still-worth-it", target: 1, name: "Still Worth It", requirement: "Won trivia while owing at least EUR 50" },
  { id: "debt-free", target: 1, name: "Debt-Free, Briefly", requirement: "Reached zero fake debt after owing at least EUR 10" },
  { id: "repeat-7", target: 7, name: "Repeat Customer", requirement: "Used the bot on 7 different days" },
  { id: "repeat-30", target: 30, name: "Loyal Customer", requirement: "Used the bot on 30 different days" },
  { id: "night-owl", target: 5, name: "Night Owl", requirement: "Spoke between midnight and 5 a.m. on 5 different nights" },
  { id: "photo-finish", target: 1, name: "Photo Finish", requirement: "Won a trivia duel by one point" },
  { id: "comeback", target: 1, name: "Comeback Kid", requirement: "Won a duel after trailing by at least 3 points" },
  { id: "runner-up", target: 5, name: "So Close...", requirement: "Finished runner-up in 5 trivia duels" },
  { id: "wrong-streak", target: 5, name: "The Oracle Is Broken", requirement: "Answered trivia incorrectly 5 times in a row" },
  { id: "siestas", target: 10, name: "Let Them Sleep", requirement: "Successfully put the bot into siesta 10 times" },
  { id: "pet-days", target: 7, name: "Pet's Favourite", requirement: "Cared for the group pet on 7 different days" },
  { id: "command-variety", target: 10, name: "Jack of All Bots", requirement: "Tried 10 different commands" },
  { id: "return-king", target: 1, name: "The Return of the King", requirement: "Answered trivia correctly within 10 minutes of returning after 30 days" },
] as const;

type SecretId = typeof SECRET_ACHIEVEMENTS[number]["id"];

export const ACHIEVEMENTS = [
  { id: "messages-1", metric: "messages", target: 1, name: "First words" },
  { id: "messages-100", metric: "messages", target: 100, name: "Chatterbox" },
  { id: "messages-1000", metric: "messages", target: 1000, name: "Chat legend" },
  { id: "commands-1", metric: "commands", target: 1, name: "Button pusher" },
  { id: "commands-25", metric: "commands", target: 25, name: "Bot regular" },
  { id: "commands-100", metric: "commands", target: 100, name: "Power user" },
  { id: "trivia-1", metric: "trivia", target: 1, name: "Bright spark" },
  { id: "trivia-10", metric: "trivia", target: 10, name: "Quiz whiz" },
  { id: "trivia-100", metric: "trivia", target: 100, name: "Walking encyclopedia" },
  { id: "duels-1", metric: "duels", target: 1, name: "First victory" },
  { id: "duels-5", metric: "duels", target: 5, name: "Duel champion" },
  { id: "duels-25", metric: "duels", target: 25, name: "Unstoppable" },
  { id: "quiet-1", metric: "quietDays", target: 1, name: "Back from the dead" },
  { id: "quiet-7", metric: "quietDays", target: 7, name: "Long time no see" },
  { id: "quiet-30", metric: "quietDays", target: 30, name: "The prodigal chatter" },
  { id: "consecutive-5", metric: "consecutive", target: 5, name: "Monologue" },
  { id: "consecutive-10", metric: "consecutive", target: 10, name: "Is anyone there?" },
  { id: "consecutive-25", metric: "consecutive", target: 25, name: "One-person show" },
  { id: "mute-minutes-60", metric: "muteMinutes", target: 60, name: "Muted briefly" },
  { id: "mute-minutes-360", metric: "muteMinutes", target: 360, name: "Silence budget" },
  { id: "mute-minutes-1440", metric: "muteMinutes", target: 1440, name: "Full-day timeout" },
  { id: "mute-count-1", metric: "muteCount", target: 1, name: "Censored once" },
  { id: "mute-count-5", metric: "muteCount", target: 5, name: "Public warning" },
  { id: "mute-count-25", metric: "muteCount", target: 25, name: "Chronically loud" },
  { id: "bill-cents-1000", metric: "billCents", target: 1_000, name: "Notorious debtor" },
  { id: "bill-cents-5000", metric: "billCents", target: 5_000, name: "Budget breaker" },
  { id: "bill-cents-25000", metric: "billCents", target: 25_000, name: "King of debt" },
] as const;

const METRIC_LABELS: Record<AchievementMetric, string> = {
  messages: "Messages", commands: "Commands", trivia: "Correct trivia answers", duels: "Duel wins",
  quietDays: "Days quiet before returning", consecutive: "Messages in a row",
  muteMinutes: "Mute minutes", muteCount: "Times muted", billCents: "Fake debt in cents",
};

export class AchievementStore {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => BotConfig) {}

  enabled(chatId: string): boolean {
    const config = this.getConfig();
    if (config.achievementChats.length === 0) return false;
    const identities = identitiesFor(this.db);
    const chat = identities.canonical(chatId);
    const matches = (entry: string) => {
      const jid = entry.includes("@") ? entry : phoneDigits(entry) ? `${phoneDigits(entry)}@s.whatsapp.net` : null;
      return jid !== null && identities.canonical(jid) === chat;
    };
    return config.approvedSenders.some(matches) && config.achievementChats.some(matches);
  }

  private scope(chatId: string, senderId: string) {
    const identities = identitiesFor(this.db);
    const chats = identities.aliasesFor(chatId);
    const senders = identities.aliasesFor(senderId);
    return {
      ...canonicalScope(identities, chatId, senderId),
      where: `chat_id IN (${chats.map(() => "?").join(",")}) AND sender_id IN (${senders.map(() => "?").join(",")})`,
      params: [...chats, ...senders],
    };
  }

  private facts(chatId: string, senderId: string, kind: string) {
    const scope = this.scope(chatId, senderId);
    return this.db.prepare(`SELECT fact_key, value, updated_at FROM achievement_facts
      WHERE ${scope.where} AND kind = ? ORDER BY updated_at DESC, rowid DESC`)
      .all(...scope.params, kind) as { fact_key: string; value: number; updated_at: number }[];
  }

  private fact(chatId: string, senderId: string, kind: string, key: string, value: number, now: number): void {
    const scope = this.scope(chatId, senderId);
    this.db.prepare(`DELETE FROM achievement_facts WHERE ${scope.where} AND kind = ? AND fact_key = ?`)
      .run(...scope.params, kind, key);
    this.db.prepare(`INSERT INTO achievement_facts(chat_id,sender_id,kind,fact_key,value,updated_at)
      VALUES (?,?,?,?,?,?)`).run(scope.chat_id, scope.sender_id, kind, key, value, now);
  }

  private secret(chatId: string, senderId: string, name: string, id: SecretId, value: number, now: number): string | null {
    const badge = SECRET_ACHIEVEMENTS.find((entry) => entry.id === id)!;
    if (value < badge.target) return null;
    const scope = this.scope(chatId, senderId);
    const earned = this.db.prepare(`SELECT 1 FROM achievement_unlocks WHERE ${scope.where} AND badge_id = ?`)
      .get(...scope.params, id);
    if (earned) return null;
    this.db.prepare("INSERT INTO achievement_unlocks(chat_id,sender_id,badge_id,unlocked_at) VALUES (?,?,?,?)")
      .run(scope.chat_id, scope.sender_id, id, now);
    return `Secret achievement unlocked for ${name || "Player"}!\n${badge.name} - ${badge.requirement}`;
  }

  private day(now: number) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.getConfig().achievementTimezone, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(now));
    const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
    return { key: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
  }

  private distinct(chatId: string, senderId: string, kind: string, key: string, now: number): number {
    this.fact(chatId, senderId, kind, key, 1, now);
    return new Set(this.facts(chatId, senderId, kind).map((row) => row.fact_key)).size;
  }

  command(chatId: string, senderId: string, name: string, command: string, now = Date.now()): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => {
      const days = this.distinct(chatId, senderId, "command-day", this.day(now).key, now);
      const commands = this.distinct(chatId, senderId, "command", command, now);
      return [
        this.secret(chatId, senderId, name, "repeat-7", days, now),
        this.secret(chatId, senderId, name, "repeat-30", days, now),
        this.secret(chatId, senderId, name, "command-variety", commands, now),
      ].filter(Boolean).join("\n\n") || null;
    }).immediate();
  }

  unmutedMessage(chatId: string, senderId: string, name: string, muteUntil: number, now = Date.now()): string | null {
    if (!this.enabled(chatId) || muteUntil <= 0 || now < muteUntil || now - muteUntil > 10_000) return null;
    return this.secret(chatId, senderId, name, "unmute-speedrun", 1, now);
  }

  muted(chatId: string, senderId: string, name: string, previousUntil: number, now = Date.now()): string | null {
    if (!this.enabled(chatId) || previousUntil <= 0 || now < previousUntil || now - previousUntil > 600_000) return null;
    return this.secret(chatId, senderId, name, "regret-nothing", 1, now);
  }

  care(chatId: string, senderId: string, name: string, now = Date.now()): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => this.secret(chatId, senderId, name, "pet-days",
      this.distinct(chatId, senderId, "pet-day", this.day(now).key, now), now)).immediate();
  }

  siesta(chatId: string, senderId: string, name: string, now = Date.now()): string | null {
    return this.counter(chatId, senderId, name, "siestas", now);
  }

  private counter(chatId: string, senderId: string, name: string, id: SecretId, now: number): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => {
      const value = this.facts(chatId, senderId, id).reduce((sum, row) => sum + row.value, 0) + 1;
      this.fact(chatId, senderId, id, "", value, now);
      return this.secret(chatId, senderId, name, id, value, now);
    }).immediate();
  }

  triviaAnswer(chatId: string, senderId: string, name: string, correct: boolean, debt: number, now = Date.now()): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => {
      const streak = correct ? 0 : (this.facts(chatId, senderId, "wrong")[0]?.value ?? 0) + 1;
      this.fact(chatId, senderId, "wrong", "", streak, now);
      const returned = this.facts(chatId, senderId, "returned")[0]?.value;
      return [
        this.secret(chatId, senderId, name, "wrong-streak", streak, now),
        correct && debt >= 5_000 ? this.secret(chatId, senderId, name, "still-worth-it", 1, now) : null,
        correct && returned !== undefined && now >= returned && now - returned <= 600_000
          ? this.secret(chatId, senderId, name, "return-king", 1, now) : null,
      ].filter(Boolean).join("\n\n") || null;
    }).immediate();
  }

  duelResult(chatId: string, players: { id: string; name: string; score: number; trailed?: boolean }[],
    winnerId: string, now = Date.now()): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => {
      const winner = players.find((player) => player.id === winnerId)!;
      const others = players.filter((player) => player.id !== winnerId);
      const second = Math.max(...others.map((player) => player.score));
      const notices = [
        others.length && winner.score - second === 1
          ? this.secret(chatId, winner.id, winner.name, "photo-finish", 1, now) : null,
        winner.trailed ? this.secret(chatId, winner.id, winner.name, "comeback", 1, now) : null,
        ...others.filter((player) => player.score === second)
          .map((player) => this.counter(chatId, player.id, player.name, "runner-up", now)),
      ];
      return notices.filter(Boolean).join("\n\n") || null;
    }).immediate();
  }

  debtChanged(senderId: string, before: number, after: number, now = Date.now()): void {
    this.db.transaction(() => {
      for (const chat of this.getConfig().achievementChats) {
        if (!this.enabled(chat)) continue;
        const scope = this.scope(chat, senderId);
        const active = this.db.prepare(`SELECT 1 FROM achievement_progress WHERE ${scope.where} LIMIT 1`).get(...scope.params);
        if (!active) continue;
        const peak = Math.max(before, after, ...this.facts(chat, senderId, "debt-peak").map((row) => row.value));
        this.fact(chat, senderId, "debt-peak", "", peak, now);
        const name = this.facts(chat, senderId, "name")[0]?.fact_key || "Player";
        const notice = after === 0 && before > 0 && peak >= 1_000
          ? this.secret(chat, senderId, name, "debt-free", 1, now) : null;
        if (notice) this.db.prepare("INSERT INTO outbox(chat_id,body,available_at,created_at) VALUES (?,?,?,?)")
          .run(scope.chat_id, notice, now, now);
      }
    }).immediate();
  }

  progress(chatId: string, senderId: string) {
    const scope = this.scope(chatId, senderId);
    const rows = this.db.prepare(`SELECT metric,
      CASE WHEN metric IN ('quietDays','consecutive') THEN MAX(count) ELSE SUM(count) END AS count
      FROM achievement_progress
      WHERE ${scope.where} GROUP BY metric`).all(...scope.params) as { metric: AchievementMetric; count: number }[];
    const counts: Record<AchievementMetric, number> = {
      messages: 0, commands: 0, trivia: 0, duels: 0, quietDays: 0, consecutive: 0,
      muteMinutes: 0, muteCount: 0, billCents: 0,
    };
    for (const row of rows) counts[row.metric] = row.count;
    const unlocked = this.db.prepare(`SELECT badge_id, MIN(unlocked_at) AS unlocked_at FROM achievement_unlocks
      WHERE ${scope.where} GROUP BY badge_id`).all(...scope.params) as { badge_id: string; unlocked_at: number }[];
    return { counts, unlocked };
  }

  record(chatId: string, senderId: string, name: string, metrics: AchievementDelta[], now = Date.now()): string | null {
    if (!this.enabled(chatId)) return null;
    return this.db.transaction(() => {
      const scope = this.scope(chatId, senderId);
      const { counts, unlocked } = this.progress(chatId, senderId);
      const earned = new Set(unlocked.map((row) => row.badge_id));
      const changed = new Set<AchievementMetric>();
      const values = new Map<AchievementMetric, number>();
      const secretNotices: (string | null)[] = [];

      for (const metricEntry of metrics) {
        const metric = typeof metricEntry === "string" ? metricEntry : metricEntry.metric;
        const value = typeof metricEntry === "string" ? 1 : metricEntry.value;
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid achievement delta");
        changed.add(metric);
        values.set(metric, (values.get(metric) ?? 0) + value);
      }

      if (changed.has("messages")) {
        const previous = this.db.prepare(`SELECT MAX(last_at) AS last_at FROM achievement_activity
          WHERE ${scope.where}`).get(...scope.params) as { last_at: number | null };
        if (previous.last_at !== null) {
          counts.quietDays = Math.max(counts.quietDays, Math.floor((now - previous.last_at) / DAY_MS));
          if (now - previous.last_at >= 30 * DAY_MS) this.fact(chatId, senderId, "returned", "", now, now);
        }
        const day = this.day(now);
        if (day.hour < 5) secretNotices.push(this.secret(chatId, senderId, name, "night-owl",
          this.distinct(chatId, senderId, "night", day.key, now), now));
        this.db.prepare(`DELETE FROM achievement_facts WHERE ${scope.where} AND kind = 'name'`).run(...scope.params);
        this.fact(chatId, senderId, "name", name, 1, now);
        this.db.prepare(`DELETE FROM achievement_activity WHERE ${scope.where}`).run(...scope.params);
        this.db.prepare("INSERT INTO achievement_activity(chat_id,sender_id,last_at) VALUES (?,?,?)")
          .run(scope.chat_id, scope.sender_id, Math.max(now, previous.last_at ?? now));
        const identities = identitiesFor(this.db);
        const chats = identities.aliasesFor(chatId);
        const chatWhere = `chat_id IN (${chats.map(() => "?").join(",")})`;
        const streak = this.db.prepare(`SELECT sender_id, count FROM achievement_streaks
          WHERE ${chatWhere} ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(...chats) as
          { sender_id: string; count: number } | undefined;
        const consecutive = streak && identities.canonical(streak.sender_id) === scope.sender_id ? streak.count + 1 : 1;
        this.db.prepare(`DELETE FROM achievement_streaks WHERE ${chatWhere}`).run(...chats);
        this.db.prepare("INSERT INTO achievement_streaks(chat_id,sender_id,count,updated_at) VALUES (?,?,?,?)")
          .run(scope.chat_id, scope.sender_id, consecutive, now);
        counts.consecutive = Math.max(counts.consecutive, consecutive);
        changed.add("quietDays");
        changed.add("consecutive");
      }

      for (const metric of changed) {
        const delta = values.get(metric) ?? 1;
        if (metric === "messages") {
          counts.messages += 1;
        } else if (metric !== "quietDays" && metric !== "consecutive") {
          counts[metric] += delta;
        }
        if (!Number.isSafeInteger(counts[metric])) throw new Error("Achievement progress exceeds supported range");
        this.db.prepare(`DELETE FROM achievement_progress WHERE ${scope.where} AND metric = ?`)
          .run(...scope.params, metric);
        this.db.prepare("INSERT INTO achievement_progress(chat_id,sender_id,metric,count) VALUES (?,?,?,?)")
          .run(scope.chat_id, scope.sender_id, metric, counts[metric]);
      }

      const fresh = ACHIEVEMENTS.filter((badge) =>
        changed.has(badge.metric) && counts[badge.metric] >= badge.target && !earned.has(badge.id));
      const insert = this.db.prepare("INSERT INTO achievement_unlocks(chat_id,sender_id,badge_id,unlocked_at) VALUES (?,?,?,?)");
      for (const badge of fresh) insert.run(scope.chat_id, scope.sender_id, badge.id, now);
      const notice = fresh.length
        ? `Achievement unlocked for ${name || "Player"}!\n${fresh.map((badge) =>
          `${badge.name} - ${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`).join("\n")}`
        : null;
      return [notice, ...secretNotices].filter(Boolean).join("\n\n") || null;
    }).immediate();
  }

  describe(chatId: string, senderId: string): string {
    const { counts, unlocked } = this.progress(chatId, senderId);
    const earned = new Set(unlocked.map((row) => row.badge_id));
    return [
      `Your achievements in this chat (${earned.size}/${ACHIEVEMENTS.length + SECRET_ACHIEVEMENTS.length})`,
      ...ACHIEVEMENTS.map((badge) => earned.has(badge.id)
        ? `[Unlocked] ${badge.name} - ${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`
        : `[Locked] ${badge.name} - ${counts[badge.metric]}/${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`),
      ...SECRET_ACHIEVEMENTS.filter((badge) => earned.has(badge.id))
        .map((badge) => `[Unlocked] ${badge.name} - ${badge.requirement}`),
      `${SECRET_ACHIEVEMENTS.filter((badge) => !earned.has(badge.id)).length} secret achievements still hidden. Keep exploring!`,
    ].join("\n");
  }
}
