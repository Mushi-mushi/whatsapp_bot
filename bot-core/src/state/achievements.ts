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

      for (const metricEntry of metrics) {
        const metric = typeof metricEntry === "string" ? metricEntry : metricEntry.metric;
        const value = typeof metricEntry === "string" ? 1 : Number(metricEntry.value ?? 1);
        if (!Number.isFinite(value) || value <= 0) continue;
        changed.add(metric);
        values.set(metric, (values.get(metric) ?? 0) + value);
      }

      if (changed.has("messages")) {
        const previous = this.db.prepare(`SELECT MAX(last_at) AS last_at FROM achievement_activity
          WHERE ${scope.where}`).get(...scope.params) as { last_at: number | null };
        if (previous.last_at !== null) {
          counts.quietDays = Math.max(counts.quietDays, Math.floor((now - previous.last_at) / DAY_MS));
        }
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
        } else if (metric === "quietDays" || metric === "consecutive") {
          // Quiet days and streaks are derived from recent activity, not additive totals.
          counts[metric] = counts[metric] || 0;
        } else {
          counts[metric] += delta;
        }
        this.db.prepare(`DELETE FROM achievement_progress WHERE ${scope.where} AND metric = ?`)
          .run(...scope.params, metric);
        this.db.prepare("INSERT INTO achievement_progress(chat_id,sender_id,metric,count) VALUES (?,?,?,?)")
          .run(scope.chat_id, scope.sender_id, metric, counts[metric]);
      }

      const fresh = ACHIEVEMENTS.filter((badge) =>
        changed.has(badge.metric) && counts[badge.metric] >= badge.target && !earned.has(badge.id));
      const insert = this.db.prepare("INSERT INTO achievement_unlocks(chat_id,sender_id,badge_id,unlocked_at) VALUES (?,?,?,?)");
      for (const badge of fresh) insert.run(scope.chat_id, scope.sender_id, badge.id, now);
      return fresh.length
        ? `Achievement unlocked for ${name || "Player"}!\n${fresh.map((badge) =>
          `${badge.name} - ${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`).join("\n")}`
        : null;
    }).immediate();
  }

  describe(chatId: string, senderId: string): string {
    const { counts, unlocked } = this.progress(chatId, senderId);
    const earned = new Set(unlocked.map((row) => row.badge_id));
    return [
      `Your achievements in this chat (${earned.size}/${ACHIEVEMENTS.length})`,
      ...ACHIEVEMENTS.map((badge) => earned.has(badge.id)
        ? `[Unlocked] ${badge.name} - ${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`
        : `[Locked] ${badge.name} - ${counts[badge.metric]}/${badge.target} ${METRIC_LABELS[badge.metric].toLowerCase()}`),
    ].join("\n");
  }
}
