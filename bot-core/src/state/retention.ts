import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { BotConfig } from "../config/schema.js";
import { AuditStore } from "./audit.js";

const DAY_MS = 86_400_000;
type RetentionConfig = Pick<BotConfig, "retentionEnabled" | "analyticsRetentionDays" | "deliveryRetentionDays">;

export class RetentionWorker {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database.Database,
    private readonly getConfig: () => RetentionConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  run(now = Date.now()): void {
    const config = this.getConfig();
    try {
      const result = this.db.transaction(() => {
        const audit = new AuditStore(this.db).prune(now);
        if (!config.retentionEnabled) return { audit };
        const removed = {
          sentiment: this.db.prepare("DELETE FROM sentiment_log WHERE ts < ?")
            .run(now - config.analyticsRetentionDays * DAY_MS).changes,
          complaints: this.db.prepare("DELETE FROM complaints WHERE ts < ?")
            .run(now - config.analyticsRetentionDays * DAY_MS).changes,
          deliveries: this.db.prepare("DELETE FROM outbox WHERE status IN ('sent', 'cancelled') AND created_at < ?")
            .run(now - config.deliveryRetentionDays * DAY_MS).changes,
        };
        return { audit, removed };
      })();
      if (result.audit) this.logger.info({ removed: result.audit }, "Administrative audit retention cleanup completed");
      if (result.removed) {
        this.logger.info({ removed: result.removed, analyticsRetentionDays: config.analyticsRetentionDays, deliveryRetentionDays: config.deliveryRetentionDays },
          "Retention cleanup completed");
      }
    } catch (err) {
      this.logger.error({ err }, "Retention cleanup failed; transaction rolled back, retrying next daily pass");
    }
  }
}
