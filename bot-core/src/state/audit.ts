import type Database from "better-sqlite3";
import type { AuditAction, AuditEntry, AuditResponse } from "../../../shared/api.js";

export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_MAX_ENTRIES = 10_000;

export class AuditStore {
  constructor(private readonly db: Database.Database) {}

  begin(action: AuditAction, targetId: string | null, actor: AuditEntry["actor"], now = Date.now()): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT INTO admin_audit (action, target_id, actor, started_at, outcome)
        VALUES (?, ?, ?, ?, 'unknown')`).run(action, targetId, actor, now);
      this.prune(now);
      return Number(result.lastInsertRowid);
    })();
  }

  complete(id: number, action: AuditAction, targetId: string | null, statusCode: number, now = Date.now()): void {
    const outcome = statusCode < 400 ? "succeeded" : statusCode < 500 ? "rejected" : "failed";
    const result = this.db.prepare(`UPDATE admin_audit SET action = ?, target_id = ?, completed_at = ?, outcome = ?, status_code = ?
      WHERE id = ? AND outcome = 'unknown'`).run(action, targetId, now, outcome, statusCode, id);
    if (result.changes !== 1) throw new Error("Administrative audit completion could not be recorded");
  }

  prune(now = Date.now()): number {
    return this.db.transaction(() => {
      const aged = this.db.prepare("DELETE FROM admin_audit WHERE started_at < ?")
        .run(now - AUDIT_RETENTION_DAYS * 86_400_000).changes;
      const excess = this.db.prepare(`DELETE FROM admin_audit WHERE id IN
        (SELECT id FROM admin_audit ORDER BY id DESC LIMIT -1 OFFSET ?)`).run(AUDIT_MAX_ENTRIES).changes;
      return aged + excess;
    })();
  }

  list(page: number, now = Date.now()): AuditResponse {
    return this.db.transaction(() => {
      const pageSize = 50;
      const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM admin_audit").get() as { total: number };
      const entries = this.db.prepare(`SELECT id, action, target_id AS targetId, actor, started_at AS startedAt,
        completed_at AS completedAt, outcome, status_code AS statusCode FROM admin_audit
        ORDER BY id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as AuditEntry[];
      return { entries, total, page, pageSize, sampledAt: now, retentionDays: AUDIT_RETENTION_DAYS, maxEntries: AUDIT_MAX_ENTRIES };
    })();
  }
}
