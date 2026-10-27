import type Database from "better-sqlite3";
import { disciplineKey } from "./repos.js";
import { identitiesFor } from "./scoped.js";
import { DEFAULT_COST_CENTS, MUTE_COST_CENTS_PER_MINUTE, MUTE_DEBT_CENTS_PER_MINUTE } from "../router/pricing.js";
import type { AchievementStore } from "./achievements.js";

export class InteractionStore {
  constructor(private readonly db: Database.Database, private readonly achievements?: AchievementStore) {}

  addDebt(senderId: string, cents: number): boolean {
    if (!Number.isSafeInteger(cents) || cents < 1) throw new Error("Invalid billing amount");
    return this.db.transaction(() => {
      const sender = identitiesFor(this.db).canonical(disciplineKey(senderId));
      const before = this.debt(sender);
      if (!Number.isSafeInteger(before + cents)) return false;
      this.db.prepare(`
        INSERT INTO user_interactions (sender_id, count, debt_cents) VALUES (?, 0, ?)
        ON CONFLICT(sender_id) DO UPDATE SET debt_cents = debt_cents + excluded.debt_cents
      `).run(sender, cents);
      this.achievements?.debtChanged(sender, before, before + cents);
      return true;
    }).immediate();
  }

  removeDebt(senderId: string, cents: number): boolean {
    if (!Number.isSafeInteger(cents) || cents < 1) throw new Error("Invalid billing amount");
    return this.db.transaction(() => {
      const identities = identitiesFor(this.db);
      const sender = identities.canonical(disciplineKey(senderId));
      const debt = this.debt(sender);
      if (cents > debt) return false;
      const count = this.total(sender);
      const aliases = identities.aliasesFor(sender);
      this.db.prepare(`DELETE FROM user_interactions WHERE sender_id IN (${aliases.map(() => "?").join(",")})`)
        .run(...aliases);
      this.db.prepare("INSERT INTO user_interactions(sender_id, count, debt_cents) VALUES (?, ?, ?)")
        .run(sender, count, debt - cents);
      this.achievements?.debtChanged(sender, debt, debt - cents);
      return true;
    }).immediate();
  }

  increment(senderId: string, phone?: string | null, cents = DEFAULT_COST_CENTS): void {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid interaction cost");
    this.db.transaction(() => {
      const sender = identitiesFor(this.db).canonical(disciplineKey(senderId, phone));
      const before = this.debt(sender);
      this.db.prepare(`
        INSERT INTO user_interactions (sender_id, count, debt_cents) VALUES (?, 1, ?)
        ON CONFLICT(sender_id) DO UPDATE SET count = count + 1, debt_cents = debt_cents + excluded.debt_cents
      `).run(sender, cents);
      this.achievements?.debtChanged(sender, before, before + cents);
    }).immediate();
  }

  total(senderId: string, phone?: string | null): number {
    const aliases = identitiesFor(this.db).aliasesFor(disciplineKey(senderId, phone));
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count FROM user_interactions
      WHERE sender_id IN (${aliases.map(() => "?").join(",")})
    `).get(...aliases) as { count: number };
    return row.count;
  }

  debt(senderId: string, phone?: string | null): number {
    const aliases = identitiesFor(this.db).aliasesFor(disciplineKey(senderId, phone));
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(debt_cents), 0) AS cents FROM user_interactions
      WHERE sender_id IN (${aliases.map(() => "?").join(",")})
    `).get(...aliases) as { cents: number };
    return row.cents;
  }

  muteUntil(chatId: string, senderId: string): number {
    const identities = identitiesFor(this.db);
    const chats = identities.aliasesFor(chatId);
    const senders = identities.aliasesFor(senderId);
    const row = this.db.prepare(`SELECT COALESCE(MAX(until_ts), 0) AS until_ts FROM user_mutes
      WHERE chat_id IN (${chats.map(() => "?").join(",")})
      AND sender_id IN (${senders.map(() => "?").join(",")})`).get(...chats, ...senders) as { until_ts: number };
    return row.until_ts;
  }

  mute(chatId: string, callerId: string, targetId: string, minutes: number, now = Date.now()):
    { ok: true; until: number } | { ok: false; allowance: number } {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || !Number.isSafeInteger(minutes * 60_000 + now)) {
      throw new Error("Invalid mute duration");
    }
    return this.db.transaction(() => {
      const identities = identitiesFor(this.db);
      const caller = identities.canonical(callerId);
      const target = identities.canonical(targetId);
      if (caller === target) throw new Error("Cannot mute yourself");
      const debt = this.debt(target);
      const allowance = Math.floor(debt / MUTE_DEBT_CENTS_PER_MINUTE);
      if (minutes > allowance) return { ok: false as const, allowance };
      const until = Math.max(now, this.muteUntil(chatId, target)) + minutes * 60_000;
      if (!Number.isSafeInteger(until)) throw new Error("Mute expiry exceeds supported range");
      // Consolidate old PN/LID balances before debiting, preserving lifetime counts.
      const count = this.total(target);
      const aliases = identities.aliasesFor(target);
      this.db.prepare(`DELETE FROM user_interactions WHERE sender_id IN (${aliases.map(() => "?").join(",")})`).run(...aliases);
      this.db.prepare("INSERT INTO user_interactions(sender_id, count, debt_cents) VALUES (?, ?, ?)")
        .run(target, count, debt - minutes * MUTE_DEBT_CENTS_PER_MINUTE);
      this.achievements?.debtChanged(target, debt, debt - minutes * MUTE_DEBT_CENTS_PER_MINUTE);
      this.increment(caller, null, minutes * MUTE_COST_CENTS_PER_MINUTE);
      this.db.prepare(`INSERT INTO user_mutes(chat_id, sender_id, until_ts) VALUES (?, ?, ?)
        ON CONFLICT(chat_id, sender_id) DO UPDATE SET until_ts = excluded.until_ts`)
        .run(identities.canonical(chatId), target, until);
      return { ok: true as const, until };
    }).immediate();
  }
}
