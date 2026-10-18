import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import { z } from "zod";
import type { BackupSnapshot } from "../../../shared/api.js";
import { checkDatabaseIntegrity } from "./database-checks.js";

const DAY_MS = 86_400_000;
const STATUS_KEY = "database_backup_status";
const BACKUP_NAME = /^bot-auto-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;
const timestamp = z.number().int().nonnegative().nullable();
const StatusSchema = z.object({
  lastAttemptAt: timestamp,
  lastSuccessAt: timestamp,
  lastFailureAt: timestamp,
  lastError: z.enum(["backup", "prune"]).nullable(),
  lastSizeBytes: z.number().int().nonnegative().nullable(),
});

export interface BackupOptions {
  directory?: string;
  retentionDays: number;
}

export function backupOptions(env: Record<string, string | undefined>): BackupOptions {
  return {
    directory: env.BACKUP_DIR?.trim() || undefined,
    retentionDays: z.coerce.number().int().min(1).max(3650).default(14).parse(env.BACKUP_RETENTION_DAYS),
  };
}

export class BackupWorker {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private nextRunAt: number | null = null;
  private status: z.infer<typeof StatusSchema>;

  constructor(
    private readonly db: Database.Database,
    private readonly options: BackupOptions,
    private readonly logger: Logger,
  ) {
    z.number().int().min(1).max(3650).parse(options.retentionDays);
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(STATUS_KEY) as { value: string } | undefined;
    this.status = row ? StatusSchema.parse(JSON.parse(row.value)) : {
      lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null, lastSizeBytes: null,
    };
  }

  start(): void {
    if (this.timer || !this.options.directory) return;
    this.stopping = false;
    this.nextRunAt = Date.now() + DAY_MS;
    this.timer = setInterval(() => {
      this.nextRunAt = Date.now() + DAY_MS;
      void this.run();
    }, DAY_MS);
    this.timer.unref();
    void this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
    await this.active;
  }

  snapshot(): BackupSnapshot {
    return {
      ...this.status, enabled: !!this.options.directory, running: !!this.active,
      retentionDays: this.options.retentionDays, intervalHours: 24, nextRunAt: this.nextRunAt,
    };
  }

  run(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopping || !this.options.directory) return Promise.resolve();
    this.active = this.backup(this.options.directory).finally(() => { this.active = undefined; });
    return this.active;
  }

  private persist(): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(STATUS_KEY, JSON.stringify(this.status));
  }

  private async backup(directory: string): Promise<void> {
    const startedAt = Date.now();
    this.status.lastAttemptAt = startedAt;
    const filename = `bot-auto-${startedAt}-${randomUUID()}.db`;
    const destination = join(resolve(directory), filename);
    const partial = `${destination}.partial`;
    let created = false;
    let stage: "backup" | "prune" = "backup";
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = await open(partial, "wx", 0o600);
      created = true;
      await file.close();
      await this.db.backup(partial);
      // Open the standalone copy directly, never the application opener:
      // verification must not run migrations or connect a second bot.
      const copy = new Database(partial, { fileMustExist: true });
      try {
        copy.pragma("journal_mode = DELETE");
        checkDatabaseIntegrity(copy);
      } finally {
        copy.close();
      }
      const size = (await stat(partial)).size;
      await rename(partial, destination);
      this.status.lastSuccessAt = Date.now();
      this.status.lastSizeBytes = size;
      this.status.lastError = null;
      this.persist();
      this.logger.info({ bytes: size }, "Database backup verified");
      stage = "prune";
      const cutoff = Date.now() - this.options.retentionDays * DAY_MS;
      let removed = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = BACKUP_NAME.exec(entry.name);
        if (entry.isFile() && match && Number(match[1]) < cutoff && entry.name !== filename) {
          await rm(join(directory, entry.name));
          removed += 1;
        }
      }
      this.logger.info({ removed, retentionDays: this.options.retentionDays }, "Automated backup retention completed");
    } catch (err) {
      this.status.lastFailureAt = Date.now();
      this.status.lastError = stage;
      this.logger.error({ err, stage }, "Database backup maintenance failed; retrying next daily pass");
      try {
        this.persist();
      } catch (persistError) {
        this.logger.error({ err: persistError }, "Could not persist database backup failure status");
      }
    } finally {
      for (const suffix of created ? ["", "-wal", "-shm", "-journal"] : []) {
        try {
          await rm(`${partial}${suffix}`, { force: true });
        } catch (err) {
          this.logger.error({ err }, "Could not remove incomplete database backup file");
        }
      }
    }
  }
}
