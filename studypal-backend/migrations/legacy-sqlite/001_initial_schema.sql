-- StudyPal initial schema — SQLITE, HISTORICAL. NOT EXECUTED.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ SUPERSEDED by SP-V2-002. The live schema is migrations/postgres/, which   │
-- │ the runner (`npm run migrate`) applies to PostgreSQL. Nothing in this     │
-- │ directory is ever run by anything; it is kept only as the record of what  │
-- │ the database looked like before the port.                                 │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Written during SP-V2-001, where it was at migrations/001_initial_schema.sql.
-- It was moved rather than edited in place or renumbered, because SP-V2-002 is
-- instructed not to overwrite the historical meaning of an existing migration:
-- `001` here means "the original SQLite tables", and `001` under
-- migrations/postgres/ means "the initial PostgreSQL schema". Two different
-- statements, so they live in two different directories rather than fighting
-- over one filename.
--
-- The DDL below is the schema the pre-refactor server created inline at startup
-- (server.js:21-37), recorded unchanged. It was never applied by a runner —
-- src/config/database.js executed the equivalent idempotent DDL on boot.
--
-- Differences from the PostgreSQL schema that replaced it are set out in
-- docs/database-architecture.md; in brief: `sessions` became `users` with a real
-- primary key, `questions.username` became a `user_id` foreign key,
-- `answer` moved from an escaped TEXT blob to JSONB, `created_at TEXT` became
-- TIMESTAMPTZ, `has_file INTEGER` became BOOLEAN, and the index that this file
-- deferred now exists.

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  topic TEXT DEFAULT 'Study Topic',
  has_file INTEGER DEFAULT 0,
  filename TEXT,
  created_at TEXT NOT NULL
);

-- Deferred by SP-V2-001, not applied here:
--
--   CREATE INDEX IF NOT EXISTS idx_questions_username_created
--     ON questions (username, created_at DESC);
--
-- Every history and progress query filtered on `questions.username` and none of
-- them could use an index, so each one was a full table scan. SP-V2-001 was
-- instructed to preserve the schema unless a change was strictly necessary, and
-- this was a performance improvement rather than a necessity.
--
-- RESOLVED in SP-V2-002: migrations/postgres/001_core_schema.sql creates the
-- equivalent index on (user_id, created_at DESC).
