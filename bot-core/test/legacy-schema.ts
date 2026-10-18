import type Database from "better-sqlite3";

// Remove additive identity schema when a fixture simulates a pre-v9 database.
export function removeScopedSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE chat_people; DROP TABLE player_karma;
    DROP TABLE player_scores; DROP TABLE player_totals; DROP TABLE player_trophies;
    DROP TABLE suggestions;
    DROP INDEX idx_sentiment_person; DROP INDEX idx_sentiment_chat_polarity; DROP INDEX idx_tells_scope;
    ALTER TABLE tells DROP COLUMN chat_id; ALTER TABLE tells DROP COLUMN target_id;
    ALTER TABLE sentiment_log DROP COLUMN chat_id; ALTER TABLE sentiment_log DROP COLUMN sender_id;
    ALTER TABLE reminders DROP COLUMN recurrence;
  `);
}
