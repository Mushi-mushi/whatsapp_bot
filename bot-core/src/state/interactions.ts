import type Database from "better-sqlite3";
import { disciplineKey } from "./repos.js";
import { identitiesFor } from "./scoped.js";

export class InteractionStore {
  constructor(private readonly db: Database.Database) {}

  increment(senderId: string, phone?: string | null): void {
    const sender = identitiesFor(this.db).canonical(disciplineKey(senderId, phone));
    this.db.prepare(`
      INSERT INTO user_interactions (sender_id, count) VALUES (?, 1)
      ON CONFLICT(sender_id) DO UPDATE SET count = count + 1
    `).run(sender);
  }

  total(senderId: string, phone?: string | null): number {
    const aliases = identitiesFor(this.db).aliasesFor(disciplineKey(senderId, phone));
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count FROM user_interactions
      WHERE sender_id IN (${aliases.map(() => "?").join(",")})
    `).get(...aliases) as { count: number };
    return row.count;
  }
}
