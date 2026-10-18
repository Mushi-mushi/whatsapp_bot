import type Database from "better-sqlite3";
import { canonicalScope, identitiesFor, inChat, type PersonScope } from "./scoped.js";

interface ScoreRow extends PersonScope { name: string; score: number }
interface TotalRow extends PersonScope { name: string; total: number }
interface TrophyRow extends ScoreRow { period: string }
export interface PlayerScore { senderId: string; name: string; score: number }

function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Legacy name-only tables are deliberately not read, reset or rolled over here.
export class PlayerScores {
  constructor(private readonly db: Database.Database, private readonly game: "trivia" | "duel") {}

  canonicalPerson(senderId: string): string {
    return identitiesFor(this.db).canonical(senderId);
  }

  private rollover(now: number): void {
    const key = `player_${this.game}_period`;
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    if (row?.value !== monthKey(now)) this.closeMonth(row?.value, now);
  }

  closeMonth(period: string | undefined, now = Date.now()): void {
    this.db.transaction(() => {
      if (period) {
        const identities = identitiesFor(this.db);
        const scores = this.db.prepare("SELECT * FROM player_scores WHERE game = ?").all(this.game) as ScoreRow[];
        const chats = new Set(scores.map((r) => identities.canonical(r.chat_id)));
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO player_trophies (game,chat_id,sender_id,period,name,score) VALUES (?,?,?,?,?,?)",
        );
        for (const chat of chats) {
          const players = this.ranking(chat, scores);
          const best = Math.max(0, ...players.map((p) => p.score));
          for (const player of players) if (best > 0 && player.score === best) {
            insert.run(this.game, chat, player.senderId, period, player.name, best);
          }
        }
        this.db.prepare("DELETE FROM player_scores WHERE game = ?").run(this.game);
      }
      this.db.prepare("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`player_${this.game}_period`, monthKey(now));
    })();
  }

  addPoints(chatId: string, senderId: string, name: string, delta: number, now = Date.now()): number {
    return this.db.transaction(() => {
      this.rollover(now);
      const scope = canonicalScope(identitiesFor(this.db), chatId, senderId);
      this.db.prepare(`INSERT INTO player_scores (game,chat_id,sender_id,name,score) VALUES (?,?,?,?,?)
        ON CONFLICT(game,chat_id,sender_id) DO UPDATE SET score=score+excluded.score,name=excluded.name`)
        .run(this.game, scope.chat_id, scope.sender_id, name, delta);
      this.db.prepare(`INSERT INTO player_totals (game,chat_id,sender_id,name,total) VALUES (?,?,?,?,?)
        ON CONFLICT(game,chat_id,sender_id) DO UPDATE SET total=total+excluded.total,name=excluded.name`)
        .run(this.game, scope.chat_id, scope.sender_id, name, delta);
      return this.current(chatId, Number.MAX_SAFE_INTEGER, now).find((p) => p.senderId === scope.sender_id)!.score;
    })();
  }

  private ranking(chatId: string, rows: ScoreRow[]): PlayerScore[] {
    const identities = identitiesFor(this.db);
    const players = new Map<string, PlayerScore>();
    for (const row of inChat(rows, chatId, identities)) {
      const senderId = identities.canonical(row.sender_id);
      const existing = players.get(senderId);
      players.set(senderId, { senderId, name: row.name, score: (existing?.score ?? 0) + row.score });
    }
    const people = this.db.prepare("SELECT * FROM chat_people ORDER BY last_ts,rowid").all() as
      (PersonScope & { name: string })[];
    for (const row of inChat(people, chatId, identities)) {
      const player = players.get(identities.canonical(row.sender_id));
      if (player) player.name = row.name;
    }
    return [...players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.senderId.localeCompare(b.senderId));
  }

  current(chatId: string, limit = Number.MAX_SAFE_INTEGER, now = Date.now()): PlayerScore[] {
    this.rollover(now);
    const rows = this.db.prepare("SELECT * FROM player_scores WHERE game = ?").all(this.game) as ScoreRow[];
    return this.ranking(chatId, rows).slice(0, limit);
  }

  allTime(chatId: string, limit = 5): { senderId: string; name: string; total: number }[] {
    const rows = this.db.prepare("SELECT * FROM player_totals WHERE game = ?").all(this.game) as TotalRow[];
    return this.ranking(chatId, rows.map((r) => ({ ...r, score: r.total })))
      .slice(0, limit).map(({ senderId, name, score }) => ({ senderId, name, total: score }));
  }

  trophies(chatId: string, limit = 5): { senderId: string; name: string; trophies: number }[] {
    const identities = identitiesFor(this.db);
    const rows = this.db.prepare("SELECT * FROM player_trophies WHERE game = ?").all(this.game) as TrophyRow[];
    const seen = new Set<string>();
    const unique = inChat(rows, chatId, identities).filter((r) => {
      const key = JSON.stringify([identities.canonical(r.sender_id), r.period]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.ranking(chatId, unique.map((r) => ({ ...r, score: 1 })))
      .slice(0, limit).map(({ senderId, name, score }) => ({ senderId, name, trophies: score }));
  }

  history(chatId: string, months = 6): { period: string; senderId: string; name: string; score: number }[] {
    const identities = identitiesFor(this.db);
    const rows = this.db.prepare("SELECT * FROM player_trophies WHERE game = ? ORDER BY period DESC,score DESC")
      .all(this.game) as TrophyRow[];
    const seen = new Set<string>();
    return inChat(rows, chatId, identities).flatMap((r) => {
      const senderId = identities.canonical(r.sender_id);
      const key = JSON.stringify([senderId, r.period]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ period: r.period, senderId, name: r.name, score: r.score }];
    }).slice(0, months);
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM player_scores WHERE game = ?").run(this.game);
  }
}
