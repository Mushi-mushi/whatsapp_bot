import type Database from "better-sqlite3";
import { ContactsStore, disciplineKey, utcDay } from "./repos.js";

const COOLDOWN_MS = 60 * 60_000;

interface QuotaRow {
  chat_id: string;
  sender_id: string;
  day: string;
  used: number;
  reset_at: number | null;
}

export type AskQuotaResult =
  | { allowed: true }
  | { allowed: false; retryAt: number };

export class AskQuotaStore {
  constructor(private readonly db: Database.Database) {}

  resetForUser(senderId: string): void {
    this.db.transaction(() => {
      const identities = new ContactsStore(this.db).identities();
      const sender = identities.canonical(senderId);
      const rows = this.db.prepare("SELECT chat_id, sender_id FROM ask_quota").all() as Pick<QuotaRow, "chat_id" | "sender_id">[];
      const remove = this.db.prepare("DELETE FROM ask_quota WHERE chat_id = ? AND sender_id = ?");
      for (const row of rows) {
        if (identities.canonical(row.sender_id) === sender) remove.run(row.chat_id, row.sender_id);
      }
    }).immediate();
  }

  consume(chatId: string, senderId: string, phone?: string | null, now = Date.now(), limit = 10): AskQuotaResult {
    return this.db.transaction((): AskQuotaResult => {
      const identities = new ContactsStore(this.db).identities();
      const chat = identities.canonical(chatId);
      const sender = identities.canonical(disciplineKey(senderId, phone));
      const day = utcDay(now);
      const rows = this.db.prepare("SELECT * FROM ask_quota WHERE day = ?").all(day) as QuotaRow[];
      const matching = rows.filter((r) => identities.canonical(r.chat_id) === chat &&
        identities.canonical(r.sender_id) === sender);
      const active = matching.filter((r) => r.reset_at == null || r.reset_at > now);
      const used = active.reduce((total, r) => total + r.used, 0);
      const midnight = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
      const allowed = used < limit;
      const next = used + (allowed ? 1 : 0);
      const resets = active.flatMap((r) => r.reset_at == null ? [] : [r.reset_at]);
      const cooldownEnd = resets.length ? Math.max(...resets) : now + COOLDOWN_MS;
      const resetAt = next >= limit || resets.length > 0 ? cooldownEnd : null;

      // Reserve before any asynchronous inference so concurrent requests cannot
      // exceed the quota. Failed inference attempts still consume a request.
      this.db.prepare("DELETE FROM ask_quota WHERE day <> ? OR (reset_at IS NOT NULL AND reset_at <= ?)").run(day, now);
      const remove = this.db.prepare("DELETE FROM ask_quota WHERE chat_id = ? AND sender_id = ?");
      for (const row of matching) remove.run(row.chat_id, row.sender_id);
      this.db.prepare(
        "INSERT INTO ask_quota (chat_id, sender_id, day, used, reset_at) VALUES (?, ?, ?, ?, ?)",
      ).run(chat, sender, day, next, resetAt);
      return allowed ? { allowed: true } : { allowed: false, retryAt: Math.min(midnight, cooldownEnd) };
    }).immediate();
  }
}
