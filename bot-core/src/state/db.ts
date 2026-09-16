import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Single SQLite database (WAL) for config, dedup, and analytics.
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_messages (
      sender_norm TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      seen_at     INTEGER NOT NULL,
      PRIMARY KEY (sender_norm, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_seen_seen_at ON seen_messages (seen_at);

    CREATE TABLE IF NOT EXISTS known_chats (
      chat_name  TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sentiment_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      sender    TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      polarity  REAL NOT NULL,
      message   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sentiment_polarity ON sentiment_log (polarity);

    CREATE TABLE IF NOT EXISTS complaints (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      sender  TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      jid        TEXT PRIMARY KEY,
      phone      TEXT,
      name       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone);
  `);
}
