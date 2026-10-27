import type Database from "better-sqlite3";
import type { TriviaBan } from "../../../shared/api.js";
import { identitiesFor } from "./scoped.js";

export class TriviaBanStore {
  constructor(private readonly db: Database.Database) {}

  private key(chatId: string, categoryId: number): string {
    return `trivia-ban:${JSON.stringify([chatId, categoryId])}`;
  }

  list(now = Date.now()): TriviaBan[] {
    const rows = this.db.prepare("SELECT value FROM kv WHERE key LIKE 'trivia-ban:%'").all() as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as TriviaBan).filter((ban) => ban.until > now);
  }

  until(chatId: string, categoryId: number, now = Date.now()): number | null {
    let until = 0;
    for (const alias of identitiesFor(this.db).aliasesFor(chatId)) {
      const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(this.key(alias, categoryId)) as { value: string } | undefined;
      if (row) until = Math.max(until, (JSON.parse(row.value) as TriviaBan).until);
    }
    return until > now ? until : null;
  }

  set(chatId: string, categoryId: number, name: string, days: number, now = Date.now()): TriviaBan {
    const ban = { chatId, categoryId, until: now + days * 86_400_000 };
    this.db.transaction(() => {
      this.remove(chatId, categoryId);
      this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(this.key(chatId, categoryId), JSON.stringify(ban));
      this.db.prepare("INSERT INTO outbox (chat_id, body, available_at, created_at) VALUES (?, ?, ?, ?)")
        .run(chatId, `Trivia announcement: ${name} is unavailable for ${days} day${days === 1 ? "" : "s"} (until ${new Date(ban.until).toISOString()}).`, now, now);
    })();
    return ban;
  }

  remove(chatId: string, categoryId: number): void {
    for (const alias of identitiesFor(this.db).aliasesFor(chatId)) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(this.key(alias, categoryId));
    }
  }
}