-- StudyPal exam simulator — PostgreSQL.
--
-- The fifth migration of the PostgreSQL era (SP-V2-006). Adds the four tables an
-- exam needs: `exams` (one row per generated exam), `exam_questions` (the
-- questions, and the answer key), `exam_attempts` (one row per sitting, holding
-- the graded result) and `attempt_answers` (what was selected, and whether it
-- was right).
--
-- Applied by `npm run migrate` (scripts/migrate.mjs), inside a transaction, once.
-- Forward-only: there is no down migration. See docs/database-architecture.md.
--
-- All four have been named as "reserved for a later ticket" since 001, and
-- tests/schema.test.js asserted by name that they did not exist. This is that
-- later ticket, so those assertions move rather than being deleted — the exact
-- table list in that test grows by four, and the reserved list shrinks by four.
--
-- STILL NOT CREATED: learning_events. Same reason as in 001, 002 and 004 — a
-- table with no code reading it is a guess about a future requirement rather
-- than a schema. SP-V2-007 owns it.
--
-- WHAT THE MODEL MAY AND MAY NOT DECIDE
-- -------------------------------------
-- Nothing in this file is written by Gemini. The model proposes question text,
-- options, which option is correct, and an explanation. Everything that decides
-- an OUTCOME is computed by the backend:
--
--   * `attempt_answers.is_correct` is decided by comparing the submitted answer
--     to `exam_questions.correct_answer` in src/exams/grader.js, against a key
--     this database handed out under FOR SHARE inside the submission
--     transaction. exam.repository.js writes that decision down and computes
--     none of it. The client cannot send it.
--   * `exam_attempts.score`, `correct_answers`, `percentage` and `passed` are
--     computed from those comparisons, never submitted and never asked of the
--     model.
--   * `source_material_id` / `source_chunk_id` are resolved backend-side from a
--     retrieved chunk, not from anything the model names (it sees `[Source N]`
--     labels, never a database id).
--
-- §5's "the server is authoritative" is therefore a property of the schema: there
-- is no column here a client could set to change its own grade.

-- ── exams ────────────────────────────────────────────────────────────────────
--
-- One row per generated exam. Like study_plans, the row holds three distinct
-- kinds of thing, and keeping them distinct is what lets an exam be re-sat
-- without being regenerated:
--
--   1. WHAT THE LEARNER ASKED FOR — subject, difficulty, question_count,
--      source_type. Copied from the validated request, never from the model.
--   2. WHAT THE MODEL PRODUCED — title. The only column here whose text came
--      from Gemini, and it is bounded and non-blank.
--   3. WHAT THE BACKEND COMPUTED — status.
--
-- IMPORTANT: ownership here is as weak as it is everywhere else in StudyPal.
-- `user_id` is a real foreign key, but the identity behind it is an
-- unauthenticated username claim (S1 in docs/security-baseline.md). The
-- constraints below make cross-user rows unrepresentable; they cannot make the
-- username honest.
CREATE TABLE exams (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- CASCADE for the reason 001 gives: an exam is meaningless without the student
  -- it belongs to, and deleting a user must actually delete their data.
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Gemini's. Bounded and non-blank, like study_plans.title.
  title TEXT NOT NULL,

  -- The learner's, echoed back rather than derived from the model's output.
  subject TEXT NOT NULL,

  difficulty TEXT NOT NULL,

  -- The number of questions REQUESTED, which §8 requires the stored exam to
  -- match exactly. It is written once, from the validated request, and the
  -- question rows are counted against it inside the same transaction — so a
  -- persisted exam whose question_count disagrees with its rows cannot exist.
  question_count INTEGER NOT NULL,

  -- The exam lifecycle. A CHECK rather than an ENUM, matching 001, 002 and 004
  -- and for the reason 002 records: adding a state to a CHECK is one migration
  -- that rewrites no rows, whereas an ENUM needs ALTER TYPE and a lock.
  --
  -- §4 offers five states and says not to introduce unnecessary ones. Three are
  -- used, and the two that are not are deliberately absent:
  --
  --   'ready'      — generated, persisted, sittable. The state every exam is
  --                  born in, because generation is synchronous and an exam row
  --                  only exists after its questions validated.
  --   'completed'  — DERIVED, never stored: an exam is not "completed", an
  --                  ATTEMPT is. Kept out of the CHECK entirely.
  --   'cancelled'  — the learner retired the exam. Blocks new attempts (§9).
  --   'draft'      — omitted. It would describe an exam with no questions yet,
  --                  which §13's transaction makes unrepresentable: the exam and
  --                  its questions commit together or not at all.
  --   'in_progress'— omitted. It would duplicate attempt state, and wrongly: an
  --                  exam may be sat many times, concurrently, so "in progress"
  --                  is a fact about one attempt and not about the exam. Putting
  --                  it here would mean two attempts fighting over one column.
  status TEXT NOT NULL DEFAULT 'ready',

  -- How the questions were grounded, recorded because it changes how a result
  -- should be read — a 60% on material-grounded questions means something
  -- different from a 60% on topic-only ones. 'material' when at least one
  -- question carries a source_material_id, 'topics' otherwise; computed by the
  -- backend from what was actually retrieved, not from what was requested.
  source_type TEXT NOT NULL,

  -- What the learner asked for, recorded so a result can be read in context and
  -- so SP-V2-007 can group attempts by topic without re-deriving them from
  -- question text. A record of the REQUEST, not a live reference.
  topics TEXT[] NOT NULL DEFAULT '{}',

  -- The materials the request named, for the same reason study_plans.material_ids
  -- exists: a record of what was asked for. NOT a live reference — a deleted
  -- material leaves this array untouched, and the per-question
  -- source_material_id is the column that actually tracks the live row.
  material_ids BIGINT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The FK target for exam_questions and exam_attempts. Same rationale as
  -- study_plans_id_user_key in 004: `id` alone is already unique, so this adds
  -- no restriction — it exists so a child table can declare a COMPOSITE foreign
  -- key and have the database itself refuse a cross-user row.
  CONSTRAINT exams_id_user_key UNIQUE (id, user_id),

  CONSTRAINT exams_status_valid
    CHECK (status IN ('ready', 'cancelled')),

  CONSTRAINT exams_difficulty_valid
    CHECK (difficulty IN ('easy', 'medium', 'hard')),

  CONSTRAINT exams_source_type_valid
    CHECK (source_type IN ('topics', 'material')),

  CONSTRAINT exams_title_not_blank
    CHECK (btrim(title, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT exams_title_bounded
    CHECK (char_length(title) <= 200),

  CONSTRAINT exams_subject_not_blank
    CHECK (btrim(subject, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT exams_subject_bounded
    CHECK (char_length(subject) <= 200),

  -- A floor as well as a ceiling. The ceiling matches study_plans' cap style;
  -- the floor is what makes "an exam with no questions" unrepresentable at the
  -- schema level as well as in the service.
  CONSTRAINT exams_question_count_positive CHECK (question_count > 0),
  CONSTRAINT exams_question_count_bounded CHECK (question_count <= 100),

  CONSTRAINT exams_topics_bounded CHECK (cardinality(topics) <= 100),
  CONSTRAINT exams_material_ids_bounded CHECK (cardinality(material_ids) <= 100)
);

-- ── exam_questions ───────────────────────────────────────────────────────────
--
-- The questions, and the answer key. `correct_answer` lives here and is never
-- selected by any read path that serves an unsubmitted attempt — see the three
-- separate question read functions in src/exams/exam.repository.js, which is
-- where §4's "the client MUST NOT receive the correct answer while taking the
-- exam" is actually enforced. The column is not nullable and has no default: a
-- question without an answer key cannot be stored, so grading can never find
-- itself with nothing to compare against.
CREATE TABLE exam_questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  exam_id BIGINT NOT NULL,

  -- Denormalised so the foreign key below can be composite. Same pattern as
  -- study_plan_tasks.user_id in 004: it is what makes a question attached to
  -- another user's exam unrepresentable rather than merely rejected.
  user_id BIGINT NOT NULL,

  -- 1-based, contiguous, and unique within an exam (constraint below). The
  -- backend assigns it from the model's array order; the model has no field for
  -- it.
  question_order INTEGER NOT NULL,

  -- §2's two types, and only those two. essay/coding/audio are excluded by the
  -- CHECK rather than by validation alone, so a future code path cannot
  -- introduce one without a migration saying so.
  question_type TEXT NOT NULL,

  question_text TEXT NOT NULL,

  -- JSONB, matching questions.answer in 001. An array of {id, text} objects; the
  -- per-type shape rules (exactly 4 for multiple_choice, exactly true/false for
  -- true_false, unique ids, correct_answer among them) are enforced
  -- deterministically in src/exams/exam-output.validator.js before insert.
  --
  -- A CHECK could assert cardinality here but not the cross-column rule that
  -- matters — "correct_answer is one of these option ids" needs to compare two
  -- columns and index into JSON, which is validator territory. What the schema
  -- does enforce is that the column is a non-empty JSON ARRAY, so a malformed
  -- value cannot reach a reader that expects to iterate it.
  options JSONB NOT NULL,

  -- The answer key. An option id ('A'..'D' for multiple choice, 'true'/'false'
  -- for true/false), compared verbatim and case-sensitively by the grader.
  correct_answer TEXT NOT NULL,

  -- Required by §7 and §8. NOT NULL: an explanation is the only thing a wrong
  -- answer leaves the learner with, and a nullable column here would make
  -- "explain my mistake" conditional on the model having bothered.
  explanation TEXT NOT NULL,

  -- §14's source traceability. Both nullable: a topic-only exam has neither, and
  -- §4 requires that a question need not have a material.
  --
  -- ON DELETE SET NULL, not CASCADE: deleting a material must not delete the
  -- exam questions generated from it, or a learner loses their attempt history
  -- by tidying up their uploads. Names its column explicitly because PostgreSQL
  -- requires that for a composite key where only part is nulled.
  source_material_id BIGINT,

  -- The chunk the question was grounded in, kept for SP-V2-007 and for future
  -- "show me where this came from". A plain FK, not composite: material_chunks
  -- has no user_id of its own, and its ownership is already implied by the
  -- composite material FK above — a chunk belongs to exactly one material.
  source_chunk_id BIGINT REFERENCES material_chunks (id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite: a question can only belong to an exam of the SAME user. CASCADE
  -- because a question without its exam is orphaned data.
  CONSTRAINT exam_questions_exam_user_fkey
    FOREIGN KEY (exam_id, user_id)
    REFERENCES exams (id, user_id) ON DELETE CASCADE,

  -- Composite: a question's source material can only be one the SAME user owns.
  -- This is the database refusing to let user A's exam cite user B's document,
  -- rather than trusting the generator to have checked.
  CONSTRAINT exam_questions_material_user_fkey
    FOREIGN KEY (source_material_id, user_id)
    REFERENCES materials (id, user_id) ON DELETE SET NULL (source_material_id),

  -- One question per position per exam. Also the index that serves
  -- "the questions of exam N in order", which is why exam_questions needs no
  -- separate (exam_id, question_order) index below.
  CONSTRAINT exam_questions_exam_order_key
    UNIQUE (exam_id, question_order),

  CONSTRAINT exam_questions_type_valid
    CHECK (question_type IN ('multiple_choice', 'true_false')),

  CONSTRAINT exam_questions_order_positive CHECK (question_order > 0),

  CONSTRAINT exam_questions_text_not_blank
    CHECK (btrim(question_text, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT exam_questions_text_bounded
    CHECK (char_length(question_text) <= 2000),

  CONSTRAINT exam_questions_correct_answer_not_blank
    CHECK (btrim(correct_answer, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT exam_questions_correct_answer_bounded
    CHECK (char_length(correct_answer) <= 100),

  CONSTRAINT exam_questions_explanation_not_blank
    CHECK (btrim(explanation, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT exam_questions_explanation_bounded
    CHECK (char_length(explanation) <= 2000),

  -- Not the full shape rule — that is the validator's — but enough that a reader
  -- which iterates `options` cannot meet a scalar or an empty list.
  CONSTRAINT exam_questions_options_is_array
    CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0)
);

-- ── exam_attempts ────────────────────────────────────────────────────────────
--
-- One row per sitting. The graded result lives here, and every column of it is
-- computed by the backend inside the submission transaction.
--
-- The result columns are nullable, and that is the state machine: an in-progress
-- attempt has NULL score/percentage/passed/submitted_at, a completed one has all
-- of them. The CHECK at the bottom ties the two together so a half-graded row —
-- completed with no score, or scored while still in progress — cannot be stored.
CREATE TABLE exam_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  exam_id BIGINT NOT NULL,

  -- Denormalised for the composite FK, as above.
  user_id BIGINT NOT NULL,

  -- §11's lifecycle: in_progress → completed, and nothing else. There is no
  -- 'abandoned' or 'expired' because nothing in SP-V2-006 expires an attempt —
  -- adding a state nothing writes would be a guess about SP-V2-007.
  status TEXT NOT NULL DEFAULT 'in_progress',

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,

  -- The graded result. `score` and `correct_answers` are the same count stored
  -- twice under §9's two names; both are kept because the API contract names
  -- both and a consumer should not have to know they are equal. `percentage` is
  -- Math.round((correct / total) * 100) — an integer by construction, so INTEGER
  -- rather than NUMERIC, and the rounding rule lives in one place
  -- (src/exams/grader.js).
  score INTEGER,
  total_questions INTEGER,
  correct_answers INTEGER,
  percentage INTEGER,
  passed BOOLEAN,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The FK target for attempt_answers.
  CONSTRAINT exam_attempts_id_user_key UNIQUE (id, user_id),

  -- Composite: an attempt can only be against an exam of the SAME user. This is
  -- what makes §12's "user A must not start an attempt against user B's exam" a
  -- database rule.
  CONSTRAINT exam_attempts_exam_user_fkey
    FOREIGN KEY (exam_id, user_id)
    REFERENCES exams (id, user_id) ON DELETE CASCADE,

  CONSTRAINT exam_attempts_status_valid
    CHECK (status IN ('in_progress', 'completed')),

  -- The state machine, as a constraint. Either everything about the result is
  -- present and the attempt is completed, or none of it is and the attempt is in
  -- progress. No third shape is storable.
  CONSTRAINT exam_attempts_result_matches_status CHECK (
    (status = 'in_progress'
      AND submitted_at IS NULL
      AND score IS NULL
      AND total_questions IS NULL
      AND correct_answers IS NULL
      AND percentage IS NULL
      AND passed IS NULL)
    OR
    (status = 'completed'
      AND submitted_at IS NOT NULL
      AND score IS NOT NULL
      AND total_questions IS NOT NULL
      AND correct_answers IS NOT NULL
      AND percentage IS NOT NULL
      AND passed IS NOT NULL)
  ),

  -- Bounds on the result itself. `correct_answers <= total_questions` is the one
  -- that matters: it makes an impossible grade unrepresentable, so a grading bug
  -- fails loudly at the INSERT rather than quietly becoming a 120% result.
  CONSTRAINT exam_attempts_counts_non_negative CHECK (
    (score IS NULL OR score >= 0)
    AND (total_questions IS NULL OR total_questions > 0)
    AND (correct_answers IS NULL OR correct_answers >= 0)
  ),
  CONSTRAINT exam_attempts_correct_within_total CHECK (
    correct_answers IS NULL
    OR total_questions IS NULL
    OR correct_answers <= total_questions
  ),
  CONSTRAINT exam_attempts_percentage_bounded CHECK (
    percentage IS NULL OR (percentage >= 0 AND percentage <= 100)
  ),
  -- score and correct_answers are the same number under two names; if they ever
  -- disagree, one of the two writers is wrong.
  CONSTRAINT exam_attempts_score_matches_correct CHECK (
    score IS NULL OR correct_answers IS NULL OR score = correct_answers
  ),

  CONSTRAINT exam_attempts_submitted_after_started CHECK (
    submitted_at IS NULL OR submitted_at >= started_at
  )
);

-- ── attempt_answers ──────────────────────────────────────────────────────────
--
-- What was selected, and whether it was right. One row per answered question.
--
-- `is_correct` is NOT NULL and is written from a comparison against
-- exam_questions.correct_answer performed in src/exams/grader.js — the one place
-- §10's marking rule is stated. completeAttempt in src/exams/exam.repository.js
-- persists the grader's output inside the submission transaction; no SQL in this
-- schema's write path computes correctness, deliberately, so that the rule does
-- not exist twice (§23).
--
-- §5 forbids accepting this from a client, and the write path gives a client no
-- way to supply it: the grader's input is built solely from {questionId, answer},
-- and the validation middleware has no reader for `isCorrect` at all.
CREATE TABLE attempt_answers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  attempt_id BIGINT NOT NULL,

  -- Denormalised for the composite FK, as above.
  user_id BIGINT NOT NULL,

  exam_question_id BIGINT NOT NULL,

  -- What the learner picked. NOT NULL — an unanswered question is the ABSENCE of
  -- a row here, not a row with a NULL. That distinction is what lets
  -- "unanswered" be counted as wrong without being confused for "answered with
  -- nothing", and it is why §16's "unanswered questions" test can assert on row
  -- count as well as on score.
  selected_answer TEXT NOT NULL,

  -- Computed server-side, never submitted.
  is_correct BOOLEAN NOT NULL,

  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite: an answer can only belong to an attempt of the SAME user.
  CONSTRAINT attempt_answers_attempt_user_fkey
    FOREIGN KEY (attempt_id, user_id)
    REFERENCES exam_attempts (id, user_id) ON DELETE CASCADE,

  -- Plain FK to the question. Not composite: the question's ownership is already
  -- pinned by the attempt's, and the service verifies every submitted question
  -- id belongs to the attempt's exam before this row is written.
  --
  -- DEFERRABLE INITIALLY DEFERRED, which is unusual enough to justify. Two
  -- deletions have to behave differently, and only a deferred check gives both:
  --
  --   * DELETING A USER OR AN EXAM must succeed. The cascade reaches these rows
  --     by two separate paths — exam → questions, and exam → attempts → answers
  --     — and PostgreSQL runs each cascade as its OWN statement. So an immediate
  --     check (RESTRICT) and an end-of-statement check (NO ACTION) both fire
  --     while the sibling cascade has not run yet, see answer rows still
  --     pointing at a question being deleted, and abort the whole delete. Both
  --     were tried: with either, DELETE FROM users fails outright.
  --   * DELETING ONE QUESTION of an attempted exam must fail. It would leave an
  --     attempt whose total_questions no longer matches its questions — a
  --     silently corrupted grade, and corrupted input for SP-V2-007.
  --
  --   Deferring to COMMIT resolves the conflict: by then the cascade has
  --   finished and there is nothing left pointing at the deleted questions, so
  --   the first case passes; a lone question delete still has its answer rows,
  --   so the second still fails. The cost is that the error surfaces at COMMIT
  --   rather than at the statement, which withTransaction already handles — it
  --   rolls back on any throw, wherever it comes from.
  --
  -- CASCADE would be the conventional choice and would also permit the cascade,
  -- but it would silently delete graded history on a single-question delete, and
  -- graded history is exactly what SP-V2-007 is going to read.
  CONSTRAINT attempt_answers_question_fkey
    FOREIGN KEY (exam_question_id)
    REFERENCES exam_questions (id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,

  -- §4's "prevent duplicate answers for the same question within one attempt".
  -- A constraint rather than a service check: the service also rejects duplicate
  -- ids in one payload with a 400, but this is what makes a duplicate
  -- unrepresentable even under a concurrent double-submit.
  CONSTRAINT attempt_answers_attempt_question_key
    UNIQUE (attempt_id, exam_question_id),

  CONSTRAINT attempt_answers_selected_not_blank
    CHECK (btrim(selected_answer, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT attempt_answers_selected_bounded
    CHECK (char_length(selected_answer) <= 100)
);

-- ── indexes ──────────────────────────────────────────────────────────────────
--
-- What the constraints above already index, and therefore what is NOT repeated
-- here:
--
--   (exams.id, user_id)                              UNIQUE — the FK target
--   (exam_attempts.id, user_id)                      UNIQUE — the FK target
--   (exam_questions.exam_id, question_order)         UNIQUE — also serves
--                                                    "questions of exam N in
--                                                    order", the hot read
--   (attempt_answers.attempt_id, exam_question_id)   UNIQUE — also serves
--                                                    "answers of attempt N"
--
-- So the only indexes worth adding are the ones behind the three list reads the
-- API actually performs, plus the FK PostgreSQL does not index for us.

-- The referencing side of exams' own user FK. There is deliberately no
-- GET /api/exams listing endpoint in SP-V2-006 — §9 names six routes and that is
-- not one of them — so this index is not serving a read today. It earns its
-- place the way idx_exam_attempts_exam does: PostgreSQL does not index the
-- referencing side of a foreign key, so without it ON DELETE CASCADE from
-- `users` would seq scan every exam in the table. The created_at DESC tail costs
-- nothing extra and is what a later "my exams, newest first" would read.
CREATE INDEX idx_exams_user_created
  ON exams (user_id, created_at DESC);

-- GET /api/exam-attempts?username= — a user's attempt history, newest first.
-- (user_id, started_at DESC) rather than (user_id, created_at DESC) because the
-- history is ordered by when the sitting began, which is what the API returns.
CREATE INDEX idx_exam_attempts_user_started
  ON exam_attempts (user_id, started_at DESC);

-- Attempts of one exam. Serves the per-exam attempt list and, more importantly,
-- makes the ON DELETE CASCADE from exams cheap: PostgreSQL does not index the
-- referencing side of a foreign key, so without this a deleted exam would seq
-- scan every attempt.
CREATE INDEX idx_exam_attempts_exam
  ON exam_attempts (exam_id);

-- The referencing side of exam_questions' source material FK, for the same
-- reason: ON DELETE SET NULL has to find the rows to null out. Partial, because
-- a topic-only exam's questions have no source and there is no query that wants
-- the NULL rows.
CREATE INDEX idx_exam_questions_source_material
  ON exam_questions (source_material_id)
  WHERE source_material_id IS NOT NULL;

-- ── column comments ──────────────────────────────────────────────────────────
--
-- The invariants a CHECK cannot express, written where \d+ will show them.

COMMENT ON COLUMN exams.question_count IS
  'The number of questions REQUESTED. The persisted question rows always equal this — generation is rejected rather than trimmed when the model returns a different number (SP-V2-006 §8).';

COMMENT ON COLUMN exams.source_type IS
  'topics | material. Computed by the backend from what was actually retrieved, not from what the request asked for: an exam whose materials yielded no usable context is ''topics''.';

COMMENT ON COLUMN exam_questions.correct_answer IS
  'The answer key. Never selected by a read path serving an unsubmitted attempt — see the separate repository functions in src/exams/exam.repository.js.';

COMMENT ON COLUMN exam_questions.options IS
  'JSONB array of {id, text}. Per-type shape (exactly 4 for multiple_choice; exactly true/false for true_false; unique ids; correct_answer among them) is enforced by src/exams/exam-output.validator.js before insert.';

COMMENT ON COLUMN exam_attempts.score IS
  'The same count as correct_answers, under the second name §9''s contract uses. The CHECK keeps them equal.';

COMMENT ON COLUMN exam_attempts.percentage IS
  'Math.round((correct / total) * 100), computed in src/exams/grader.js. Integer by construction.';

COMMENT ON COLUMN attempt_answers.is_correct IS
  'Decided in src/exams/grader.js by comparing the selection to exam_questions.correct_answer, and persisted by exam.repository.js. Never computed in SQL (the rule lives in one place) and never accepted from a client (SP-V2-006 §5).';

COMMENT ON COLUMN attempt_answers.selected_answer IS
  'What the learner picked. An unanswered question has NO ROW here rather than a NULL selection.';
