-- StudyPal initial schema
--
-- This is the schema the pre-refactor server created inline at startup
-- (server.js:21-37), recorded here unchanged as the baseline for real
-- migration tooling in SP-V2-002.
--
-- It is NOT executed by a migration runner yet: src/config/database.js still
-- applies the same idempotent DDL on boot, exactly as before. Introducing a
-- runner (and a schema_migrations table) is deliberately out of scope for
-- SP-V2-001, whose remit is to change structure without changing behaviour.

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

-- Deferred to SP-V2-002, not applied here:
--
--   CREATE INDEX IF NOT EXISTS idx_questions_username_created
--     ON questions (username, created_at DESC);
--
-- Every history and progress query filters on `questions.username` and none of
-- them can use an index today, so each one is a full table scan. The fix is a
-- one-line index, but SP-V2-001 is instructed to preserve the schema unless a
-- change is strictly necessary, and this one is a performance improvement
-- rather than a necessity. It belongs with the data-layer work in SP-V2-002.
