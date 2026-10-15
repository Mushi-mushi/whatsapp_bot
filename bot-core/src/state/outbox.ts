import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Reminder } from "./repos.js";

export interface Delivery {
  id: number;
  chat_id: string;
  body: string;
  claim_token: string;
  attempts: number;
  pet_event_id?: string | null;
}

export class OutboxStore {
  constructor(private readonly db: Database.Database) {}

  enqueueReminders(now: number): void {
    this.db.transaction(() => {
      const reminders = this.db.prepare("SELECT * FROM reminders WHERE due_ts <= ? ORDER BY due_ts LIMIT 100").all(now) as Reminder[];
      for (const reminder of reminders) {
        const who = reminder.target_name ? ` ${reminder.target_name},` : "";
        this.db.prepare("INSERT INTO outbox (chat_id, body, available_at, created_at) VALUES (?, ?, ?, ?)")
          .run(reminder.chat_id, `Reminder:${who} ${reminder.text}`, now, now);
        this.db.prepare("DELETE FROM reminders WHERE id = ?").run(reminder.id);
      }
    })();
  }

  claim(now: number): Delivery | undefined {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE outbox SET status = 'failed', last_error = 'Delivery lease expired' WHERE status = 'sending' AND lease_until <= ? AND attempts >= 5").run(now);
      const row = this.db.prepare(`SELECT * FROM outbox WHERE attempts < 5 AND
        ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND lease_until <= ?))
        ORDER BY id LIMIT 1`).get(now, now) as Delivery | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, claim_token = ? WHERE id = ?")
        .run(now + 300_000, token, row.id);
      return { ...row, claim_token: token, attempts: row.attempts + 1 };
    })();
  }

  sent(delivery: Delivery, onSent?: () => void): void {
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET status = 'sent', lease_until = NULL, last_error = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'")
        .run(delivery.id, delivery.claim_token);
      if (result.changes) onSent?.();
    })();
  }

  cancel(delivery: Delivery): void {
    this.db.prepare("UPDATE outbox SET status = 'cancelled', lease_until = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'")
      .run(delivery.id, delivery.claim_token);
  }

  defer(delivery: Delivery, now: number): void {
    this.db.prepare(`UPDATE outbox SET status = 'pending', attempts = attempts - 1,
      available_at = ?, lease_until = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'`)
      .run(now + 15_000, delivery.id, delivery.claim_token);
  }

  failed(delivery: Delivery, error: unknown, now: number): void {
    const status = delivery.attempts >= 5 ? "failed" : "pending";
    const delay = Math.min(900_000, 5000 * 2 ** (delivery.attempts - 1));
    this.db.prepare("UPDATE outbox SET status = ?, available_at = ?, lease_until = NULL, last_error = ? WHERE id = ? AND claim_token = ? AND status = 'sending'")
      .run(status, now + delay, String(error).slice(0, 300), delivery.id, delivery.claim_token);
  }
}