-- StudyPal core schema — PostgreSQL.
--
-- The first migration of the PostgreSQL era (SP-V2-002). The SQLite schema it
-- replaces is kept, unexecuted, at migrations/legacy-sqlite/001_initial_schema.sql.
--
-- Applied by `npm run migrate` (scripts/migrate.mjs), inside a transaction, once.
-- Forward-only: there is no down migration. See docs/database-architecture.md.
--
-- Deliberately NOT created here: materials, material_chunks, study_plans,
-- study_plan_tasks, exams, exam_questions, exam_attempts, attempt_answers,
-- learning_events. Those belong to later V2 tickets, and a table with no code
-- reading it is a guess about a future requirement rather than a schema.

-- ── users ────────────────────────────────────────────────────────────────────
--
-- Replaces `sessions`, which despite its name held no session state: one row per
-- username, created on first login, never updated, never expired. It was a user
-- registry, so it is now called one, and it gains the identity column that lets
-- other tables reference it.
--
-- IMPORTANT: `username` is an unauthenticated identity CLAIM, not a verified
-- identity. Anyone may POST /api/session with any name and read that name's
-- history. This table is where authentication will attach (S1 in
-- docs/security-baseline.md); until it does, every row here is public data.
CREATE TABLE users (
  -- IDENTITY rather than SERIAL: it is the SQL-standard spelling, and ALWAYS
  -- stops an INSERT from supplying its own id, which keeps the sequence and the
  -- table from drifting apart. BIGINT because widening a PK later means
  -- rewriting every referencing row.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Stored exactly as the client sent it. /api/session trims before writing,
  -- but /api/ask deliberately does not (see src/middleware/validation.js), so
  -- "ann" and "ann " are two users. That asymmetry is pre-existing behaviour
  -- the API contract depends on; it is recorded as debt, not fixed here.
  username TEXT NOT NULL,

  -- Nullable, for the profile fields the V2 UI will collect. Nothing writes them
  -- yet. They are here because adding a nullable column to a table with rows is
  -- free, whereas backfilling a NOT NULL one is not — and because a real
  -- account needs somewhere to put an email before auth can exist.
  email TEXT,
  display_name TEXT,
  education_level TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The schema-level guarantee that made re-login idempotent under SQLite, kept
  -- verbatim: POST /api/session relies on it via ON CONFLICT (username).
  CONSTRAINT users_username_key UNIQUE (username),

  -- Nullable-unique: many rows may have NULL email, at most one may have any
  -- given address. Enforced now so a future login-by-email cannot find
  -- duplicates already in the table.
  CONSTRAINT users_email_key UNIQUE (email),

  -- The old schema accepted "" and "   " as usernames at the database level and
  -- relied entirely on the request validator to reject them. Now the database
  -- refuses too, so a bug in a future code path cannot create an unusable row.
  --
  -- The character set is given explicitly because bare btrim() removes SPACES
  -- ONLY: btrim(E'\t') is still E'\t', so a tab-only username would satisfy a
  -- constraint called "not blank". This list matches what JavaScript's
  -- String.trim() removes for the characters a form can actually submit, so the
  -- database and src/middleware/validation.js agree on what "blank" means.
  --
  -- Vertical tab is written \x0B, not \v: PostgreSQL's E'' strings have no \v
  -- escape and would put a literal letter "v" in the trim set, which would
  -- reject the perfectly good username "v" while still accepting a real
  -- vertical tab. Every escape here is one E'' actually defines.
  CONSTRAINT users_username_not_blank
    CHECK (btrim(username, E' \t\n\r\f\x0B') <> '')
);

-- ── questions ────────────────────────────────────────────────────────────────
--
-- One row per answered question. Written only after the model has responded, so
-- a failed generation leaves nothing behind — an invariant the tests assert.
CREATE TABLE questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Was `username TEXT` with no constraint, which allowed history for a user
  -- that did not exist. CASCADE because a question is meaningless without the
  -- student it belongs to, and because deleting a user must actually delete
  -- their data — otherwise the first data-deletion request needs a migration.
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  question TEXT NOT NULL,

  -- JSONB, not TEXT. The model returns an object
  -- ({explanation, topic, practice_questions[], encouragement}) whose shape
  -- varies, and SQLite stored it as a JSON string that the service had to
  -- JSON.parse on every read — a parse that could throw on a poisoned row.
  -- JSONB validates on write, is queryable, and comes back as an object.
  --
  -- It holds a JSON OBJECT, never a JSON string containing JSON: passing
  -- JSON.stringify(answer) as a jsonb parameter stores the object itself.
  -- The CHECK below makes double-encoding a write error rather than a subtly
  -- wrong response weeks later.
  answer JSONB NOT NULL,

  -- Denormalised out of `answer` on purpose. GET /api/progress groups by topic,
  -- and a plain column with a plain index beats a JSONB expression for the one
  -- field that is queried rather than merely displayed.
  topic TEXT NOT NULL DEFAULT 'Study Topic',

  -- Was INTEGER 0/1, which is why the service wrapped every read in Boolean().
  -- BOOLEAN removes the conversion and the chance of forgetting it.
  has_file BOOLEAN NOT NULL DEFAULT false,

  -- The client's own filename, kept unmodified because GET /api/history echoes
  -- it and changing it would change existing responses (S15). NULL when no file
  -- was attached.
  filename TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT questions_answer_is_object CHECK (jsonb_typeof(answer) = 'object'),
  -- Same explicit character set as users_username_not_blank, for the same two
  -- reasons: bare btrim() would let a tab-only question through, and \x0B is
  -- how E'' spells vertical tab.
  CONSTRAINT questions_question_not_blank
    CHECK (btrim(question, E' \t\n\r\f\x0B') <> ''),
  -- has_file and filename must agree. The old schema could store has_file=1 with
  -- a NULL filename, a state no code path intends and every consumer would
  -- misrender.
  CONSTRAINT questions_filename_matches_has_file CHECK (
    (has_file AND filename IS NOT NULL) OR (NOT has_file AND filename IS NULL)
  )
);

-- ── indexes ──────────────────────────────────────────────────────────────────
--
-- Two, both for a query that exists in the code today. No speculative indexes:
-- each one costs write throughput and disk, and an unused index is pure loss.
-- The PK and UNIQUE constraints above already create indexes on users.id,
-- users.username, users.email and questions.id, so none are repeated here.

-- Serves GET /api/history/:username, the hottest read in the app:
--   WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30
-- Column order matters: the equality column first, then the sort column, lets
-- PostgreSQL find the user's rows and walk them already in order, so the LIMIT
-- stops after 30 rows with no sort step. This is A9/the index SP-V2-001
-- deferred. DESC is written explicitly to match the query, though PostgreSQL can
-- also scan an ASC index backwards.
CREATE INDEX idx_questions_user_created ON questions (user_id, created_at DESC);

-- Serves the topic breakdown in GET /api/progress/:username:
--   WHERE user_id = $1 GROUP BY topic ORDER BY count DESC LIMIT 6
-- Including `topic` lets the grouping read the index alone rather than fetching
-- every matching row from the heap. It is a second index on the same leading
-- column, which is only worth it because progress is called on every page load
-- alongside history.
CREATE INDEX idx_questions_user_topic ON questions (user_id, topic);

-- ── comments ─────────────────────────────────────────────────────────────────
--
-- Kept in the database itself so `\d+ questions` in psql explains the two
-- non-obvious columns without anyone having to find this file.
COMMENT ON TABLE users IS
  'One row per student. `username` is an unauthenticated claim: no password, no verification. See docs/security-baseline.md S1.';
COMMENT ON COLUMN questions.answer IS
  'The model response as a JSON object. Never a JSON-encoded string.';
COMMENT ON COLUMN questions.topic IS
  'Copied from answer->>''topic'' at write time so GET /api/progress can group and index on it.';
