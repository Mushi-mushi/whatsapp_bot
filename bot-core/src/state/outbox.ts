import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Reminder } from "./repos.js";
import type { DeliveryAttempt, DeliveryAttemptOutcome, DeliveryFailure, DeliveryFailureKind, DeliveryHistoryResponse, FailedDeliveriesResponse, FailedDelivery, OutboxSnapshot } from "../../../shared/api.js";

export interface Delivery {
  id: number;
  chat_id: string;
  body: string;
  claim_token: string;
  attempts: number;
  pet_event_id?: string | null;
}

function failureKind(error: string | null): DeliveryFailureKind {
  if (error === null) return "unknown";
  if (error === "Error: Delivery timed out") return "timeout";
  if (error === "Delivery lease expired") return "lease-expired";
  return "send-error";
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
        if (reminder.recurrence === "daily" || reminder.recurrence === "weekly") {
          const step = reminder.recurrence === "daily" ? 86_400_000 : 7 * 86_400_000;
          let nextDue = reminder.due_ts + step;
          if (nextDue <= now) {
            nextDue += Math.ceil((now - nextDue + 1) / step) * step;
          }
          this.db.prepare("UPDATE reminders SET due_ts = ? WHERE id = ?").run(nextDue, reminder.id);
        } else {
          this.db.prepare("DELETE FROM reminders WHERE id = ?").run(reminder.id);
        }
      }
    })();
  }

  claim(now: number): Delivery | undefined {
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE delivery_attempts SET outcome = 'lease-expired', failure_kind = 'lease-expired', finished_at = ?
        WHERE outcome = 'sending' AND claim_token IN (SELECT claim_token FROM outbox WHERE status = 'sending' AND lease_until <= ?)`)
        .run(now, now);
      this.db.prepare("UPDATE outbox SET status = 'failed', last_error = 'Delivery lease expired', last_failure_at = ? WHERE status = 'sending' AND lease_until <= ? AND attempts >= 5").run(now, now);
      const row = this.db.prepare(`SELECT * FROM outbox WHERE attempts < 5 AND
        ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND lease_until <= ?))
        ORDER BY id LIMIT 1`).get(now, now) as Delivery | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, claim_token = ? WHERE id = ?")
        .run(now + 300_000, token, row.id);
      this.db.prepare(`INSERT INTO delivery_attempts (outbox_id, claim_token, retry_count, started_at, outcome)
        SELECT id, ?, manual_retry_count, ?, 'sending' FROM outbox WHERE id = ?`).run(token, now, row.id);
      this.db.prepare(`DELETE FROM delivery_attempts WHERE outbox_id = ? AND id NOT IN
        (SELECT id FROM delivery_attempts WHERE outbox_id = ? ORDER BY id DESC LIMIT 50)`).run(row.id, row.id);
      return { ...row, claim_token: token, attempts: row.attempts + 1 };
    })();
  }

  sent(delivery: Delivery, onSent?: () => void): void {
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET status = 'sent', lease_until = NULL, last_error = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'")
        .run(delivery.id, delivery.claim_token);
      if (result.changes) {
        this.finishAttempt(delivery, "sent", Date.now());
        onSent?.();
      }
    })();
  }

  cancel(delivery: Delivery): void {
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET status = 'cancelled', lease_until = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'")
        .run(delivery.id, delivery.claim_token);
      if (result.changes) this.finishAttempt(delivery, "cancelled", Date.now());
    })();
  }

  defer(delivery: Delivery, now: number): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE outbox SET status = 'pending', attempts = attempts - 1,
        available_at = ?, lease_until = NULL WHERE id = ? AND claim_token = ? AND status = 'sending'`)
        .run(now + 15_000, delivery.id, delivery.claim_token);
      if (result.changes) this.finishAttempt(delivery, "deferred", now);
    })();
  }

  failed(delivery: Delivery, error: unknown, now: number): void {
    const status = delivery.attempts >= 5 ? "failed" : "pending";
    const delay = Math.min(900_000, 5000 * 2 ** (delivery.attempts - 1));
    this.db.transaction(() => {
      const message = String(error).slice(0, 300);
      const result = this.db.prepare("UPDATE outbox SET status = ?, available_at = ?, lease_until = NULL, last_error = ?, last_failure_at = ? WHERE id = ? AND claim_token = ? AND status = 'sending'")
        .run(status, now + delay, message, now, delivery.id, delivery.claim_token);
      if (result.changes) this.finishAttempt(delivery, "failed", now, failureKind(message));
    })();
  }

  private finishAttempt(delivery: Delivery, outcome: DeliveryAttemptOutcome, now: number, kind: DeliveryFailureKind | null = null): void {
    this.db.prepare(`UPDATE delivery_attempts SET outcome = ?, finished_at = ?, failure_kind = ?
      WHERE claim_token = ? AND outcome = 'sending'`).run(outcome, now, kind, delivery.claim_token);
  }

  listFailed(page: number, now = Date.now()): FailedDeliveriesResponse {
    return this.db.transaction(() => {
      const pageSize = 50;
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE status = 'failed'").get() as { total: number };
      const rows = this.db.prepare(`SELECT id, attempts, manual_retry_count AS retryCount,
        last_failure_at AS failedAt, last_error AS error FROM outbox WHERE status = 'failed'
        ORDER BY last_failure_at DESC, id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as
        (Omit<FailedDelivery, "failureKind"> & { error: string | null })[];
      return { deliveries: rows.map(({ error, ...row }) => ({ ...row, failureKind: failureKind(error) })),
        total, page, pageSize, sampledAt: now };
    })();
  }

  history(id: number): DeliveryHistoryResponse | undefined {
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT id FROM outbox WHERE id = ?").get(id)) return undefined;
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM delivery_attempts WHERE outbox_id = ?").get(id) as { total: number };
      const attempts = this.db.prepare(`SELECT id, retry_count AS retryCount, started_at AS startedAt,
        finished_at AS finishedAt, outcome, failure_kind AS failureKind FROM delivery_attempts
        WHERE outbox_id = ? ORDER BY id DESC LIMIT 50`).all(id) as DeliveryAttempt[];
      return { id, attempts, total };
    })();
  }

  retryFailed(id: number, expectedRetryCount: number, now = Date.now()): boolean {
    // Leave one attempt in the existing five-attempt budget; no automatic retry cycle.
    return this.db.prepare(`UPDATE outbox SET status = 'pending', attempts = 4, available_at = ?,
      lease_until = NULL, claim_token = NULL, manual_retry_count = manual_retry_count + 1
      WHERE id = ? AND status = 'failed' AND manual_retry_count = ?`)
      .run(now, id, expectedRetryCount).changes === 1;
  }

  snapshot(now: number): OutboxSnapshot {
    return this.db.transaction(() => {
      const counts: OutboxSnapshot["counts"] = { pending: 0, sending: 0, failed: 0, sent: 0, cancelled: 0 };
      const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as {
        status: keyof typeof counts; count: number;
      }[];
      for (const row of rows) counts[row.status] = row.count;
      const state = this.db.prepare(`SELECT
        COUNT(CASE WHEN status = 'pending' AND attempts < 5 AND available_at <= @now THEN 1 END) AS ready,
        COUNT(CASE WHEN status = 'pending' AND attempts > 0 AND attempts < 5 THEN 1 END) AS retrying,
        COUNT(CASE WHEN status = 'sending' AND lease_until <= @now THEN 1 END) AS expiredLeases,
        MIN(CASE WHEN status = 'pending' AND attempts < 5 THEN available_at
                 WHEN status = 'sending' THEN lease_until END) AS nextAttemptAt
        FROM outbox`).get({ now }) as Pick<OutboxSnapshot, "ready" | "retrying" | "expiredLeases" | "nextAttemptAt">;
      const recentFailures = this.db.prepare(`SELECT id, status, attempts, last_failure_at AS failedAt,
        CASE WHEN status = 'pending' AND attempts < 5 THEN available_at
             WHEN status = 'sending' THEN lease_until END AS retryAt
        FROM outbox WHERE last_error IS NOT NULL AND status IN ('pending', 'sending', 'failed')
        ORDER BY last_failure_at DESC, id DESC LIMIT 20`).all() as DeliveryFailure[];
      return { counts, ...state, recentFailures };
    })();
  }
}