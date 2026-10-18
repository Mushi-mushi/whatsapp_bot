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
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 5) throw new Error("Database schema is newer than this application");
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

    CREATE TABLE IF NOT EXISTS chat_directory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS seen_activity (
      name_norm TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      last_ts   INTEGER NOT NULL,
      chat_name TEXT
    );

    CREATE TABLE IF NOT EXISTS user_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_key TEXT NOT NULL,
      name_norm  TEXT NOT NULL,
      name       TEXT NOT NULL,
      chat_name  TEXT,
      message    TEXT NOT NULL,
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_messages_key ON user_messages (sender_key, id);
    CREATE INDEX IF NOT EXISTS idx_user_messages_name ON user_messages (name_norm, id);

    CREATE TABLE IF NOT EXISTS user_profiles (
      sender_key       TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      deep             TEXT NOT NULL,
      short            TEXT NOT NULL,
      last_profiled_id INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tells (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_norm TEXT NOT NULL,
      target_name TEXT NOT NULL,
      from_name   TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_ts  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tells_target ON tells (target_norm);

    CREATE TABLE IF NOT EXISTS karma (
      name_norm TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      points    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      target_name TEXT,
      text        TEXT NOT NULL,
      due_ts      INTEGER NOT NULL,
      created_ts  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_ts);

    CREATE TABLE IF NOT EXISTS trivia_scores (
      chat_id   TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      correct   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS trivia_totals (
      chat_id   TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      total     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS trivia_trophies (
      chat_id   TEXT NOT NULL,
      period    TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      score     INTEGER NOT NULL,
      PRIMARY KEY (chat_id, period, name_norm)
    );

    CREATE TABLE IF NOT EXISTS duel_wins (
      chat_id   TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      wins      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS duel_totals (
      chat_id   TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      total     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS duel_trophies (
      chat_id   TEXT NOT NULL,
      period    TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      name      TEXT NOT NULL,
      score     INTEGER NOT NULL,
      PRIMARY KEY (chat_id, period, name_norm)
    );
  `);
  // One-time seed for totals introduced after scores already existed.
  db.exec(`
    INSERT INTO trivia_totals (chat_id, name_norm, name, total)
    SELECT chat_id, name_norm, MAX(name), SUM(score) FROM (
      SELECT chat_id, name_norm, name, correct AS score FROM trivia_scores
      UNION ALL
      SELECT chat_id, name_norm, name, score FROM trivia_trophies
    )
    WHERE NOT EXISTS (SELECT 1 FROM trivia_totals)
    GROUP BY chat_id, name_norm;
  `);
  if (version < 1) {
    db.transaction(() => {
      db.exec(`CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        claim_token TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_outbox_ready ON outbox(status, available_at);
      PRAGMA user_version = 1;`);
    })();
  }
  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE pets (
          chat_id TEXT PRIMARY KEY,
          state TEXT NOT NULL
        );
        CREATE TABLE pet_events (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL REFERENCES pets(chat_id),
          stage INTEGER NOT NULL,
          sleeping INTEGER NOT NULL,
          request_kind TEXT,
          sent_at INTEGER
        );
        ALTER TABLE outbox ADD COLUMN pet_event_id TEXT REFERENCES pet_events(id);
        PRAGMA user_version = 2;
      `);
    })();
  }
  if (version < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE siesta_discipline (
          chat_id         TEXT NOT NULL,
          sender_id       TEXT NOT NULL,
          last_siesta_day TEXT,
          sleep_until     INTEGER,
          armed           INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, sender_id)
        );
        PRAGMA user_version = 3;
      `);
    })();
  }
  if (version < 4) {
    db.transaction(() => {
      // Legacy chat names cannot safely identify a conversation. Never seed
      // isolated profiles with dossiers assembled from multiple chats.
      db.exec(`
        DROP TABLE user_messages;
        DROP TABLE user_profiles;
        CREATE TABLE user_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_key TEXT NOT NULL,
          chat_id TEXT NOT NULL CHECK(length(chat_id) > 0),
          name_norm TEXT NOT NULL,
          name TEXT NOT NULL,
          chat_name TEXT,
          message TEXT NOT NULL,
          ts INTEGER NOT NULL
        );
        CREATE INDEX idx_user_messages_key ON user_messages(sender_key, id);
        CREATE INDEX idx_user_messages_chat ON user_messages(chat_id, id);
        CREATE TABLE user_profiles (
          sender_key TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL CHECK(length(chat_id) > 0),
          name TEXT NOT NULL,
          deep TEXT NOT NULL,
          short TEXT NOT NULL,
          last_profiled_id INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 4;
      `);
    })();
  }
  if (version < 5) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE outbox ADD COLUMN last_failure_at INTEGER;
        CREATE INDEX idx_outbox_failures ON outbox(last_failure_at DESC) WHERE last_error IS NOT NULL;
        PRAGMA user_version = 5;
      `);
    })();
  }
}
