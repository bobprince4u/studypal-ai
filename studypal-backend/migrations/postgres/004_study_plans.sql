-- StudyPal study plans — PostgreSQL.
--
-- The fourth migration of the PostgreSQL era (SP-V2-005). Adds the two tables an
-- AI-generated study plan needs: `study_plans` (one row per generated plan, plus
-- the learner goals it was generated from) and `study_plan_tasks` (the scheduled
-- work, one row per session).
--
-- Applied by `npm run migrate` (scripts/migrate.mjs), inside a transaction, once.
-- Forward-only: there is no down migration. See docs/database-architecture.md.
--
-- These two tables have been named as "reserved for a later ticket" since 001,
-- and tests/schema.test.js asserted by name that they did not exist. This is that
-- later ticket, so both assertions move rather than being deleted — the exact
-- table list in that test grows by two, and the reserved list shrinks by two.
--
-- STILL NOT CREATED: exams, exam_questions, exam_attempts, attempt_answers,
-- learning_events. Same reason as in 001 and 002 — a table with no code reading
-- it is a guess about a future requirement rather than a schema.
--
-- WHAT THE MODEL MAY AND MAY NOT DECIDE
-- -------------------------------------
-- Nothing in this file is written by Gemini. The model proposes an ORDERED LIST
-- of study activities and nothing else: its response schema has no field for a
-- date, an id, a user, a status or a material id (see
-- src/ai/prompts/study-plan.prompt.js). Every scheduled_date below was computed
-- by src/study-plans/plan-normalizer.js from the learner's own study days, every
-- material_id was resolved by the backend from an alias, and every status starts
-- at its default. §17's split between "what to study" and "when, and whether it
-- is allowed" is a property of the schema, not a rule someone has to remember.

-- ── a key for materials that carries its owner ───────────────────────────────
--
-- Not a performance index. This is the UNIQUE constraint that lets
-- study_plan_tasks declare a COMPOSITE foreign key into `materials`, which is
-- what makes §8's "an optional material must belong to the same user" a database
-- rule instead of an application convention.
--
-- `id` alone is already unique, so this constraint adds no new restriction on
-- `materials` — it exists solely to give a foreign key something to point at.
-- PostgreSQL requires the referenced columns of an FK to be covered by a unique
-- constraint, and (id, user_id) is the pair a task needs to check.
--
-- It does cost an index on a table that had two. That is a real write cost on
-- every upload, and tests/materials/schema.test.js asserts the exact index list
-- specifically so a new one has to be justified here rather than appearing
-- quietly. The justification: the alternative is a cross-table invariant enforced
-- only by application code, and the one thing this schema is consistently strict
-- about is not relying on a caller to remember a check. Materials are written
-- once per upload and read constantly; a second unique index on the write side is
-- the cheap half of that trade.
ALTER TABLE materials
  ADD CONSTRAINT materials_id_user_key UNIQUE (id, user_id);

-- ── study_plans ──────────────────────────────────────────────────────────────
--
-- One row per generated plan. The row holds three different kinds of thing, and
-- keeping them distinct is what makes regeneration possible:
--
--   1. WHAT THE LEARNER ASKED FOR — subject, topics, exam_date, daily_minutes,
--      difficulty_level, study_days, material_ids. Copied from the validated
--      request, never from the model.
--   2. WHAT THE MODEL PRODUCED — title, goal. The only two columns here whose
--      text came from Gemini, and both are bounded and non-blank.
--   3. WHAT THE BACKEND COMPUTED — start_date, end_date, status.
--
-- Storing (1) is the reason POST /api/study-plans/:id/regenerate takes nothing
-- but a username: the goals are already here, so "regenerate" means the same
-- goals again rather than a create call wearing a different name.
--
-- IMPORTANT: ownership here is as weak as it is everywhere else in StudyPal.
-- `user_id` is a real foreign key, but the identity behind it is an
-- unauthenticated username claim (S1 in docs/security-baseline.md).
CREATE TABLE study_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- CASCADE, matching questions.user_id and materials.user_id: a plan is
  -- meaningless without the student it belongs to.
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Model-generated: a short name for the plan. Bounded because it is model
  -- output, and model output is not a trusted length.
  title TEXT NOT NULL,

  -- The learner's subject, exactly as they typed it. Untrusted display text.
  subject TEXT NOT NULL,

  -- Model-generated: one paragraph on what the plan is trying to achieve. NOT
  -- NULL because a plan with no stated goal is a list of chores, and the
  -- generator always produces one — a response missing it is rejected before it
  -- reaches here (src/study-plans/plan-output.validator.js).
  goal TEXT NOT NULL,

  -- The first and last dates that actually carry a task. Both are computed by
  -- the normalizer from the available study dates, NOT taken from the model and
  -- NOT taken from the client. start_date is the first study date on or after
  -- the day the plan was generated; end_date is wherever the content ran out.
  --
  -- DATE, not TIMESTAMPTZ: a study day is a calendar day, and the hour a plan
  -- happened to be generated at has no business shifting which day a task falls
  -- on. src/config/pg-types.js parses DATE as the raw 'YYYY-MM-DD' string for the
  -- same reason — pg's default would hand back a JS Date at local midnight,
  -- which is a day earlier west of Greenwich.
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- The learner's exam date. Distinct from end_date: a plan whose content runs
  -- out early ends early, and the gap between the two is meaningful.
  exam_date DATE NOT NULL,

  -- Minutes per study day the learner said they have. The hard ceiling on what
  -- may be scheduled on any one date (§21).
  daily_minutes INTEGER NOT NULL,

  difficulty_level TEXT NOT NULL,

  -- The plan lifecycle. A CHECK rather than an ENUM, matching 001 and 002 and
  -- for the reason 002 records: adding a state to a CHECK is one migration that
  -- rewrites no rows, whereas ALTER TYPE ... ADD VALUE cannot run inside a
  -- transaction block on older servers and cannot remove a value at all.
  --
  --   active     the plan has work left in it
  --   completed  every task is completed or skipped — DERIVED, see §29 and
  --              src/study-plans/study-plan.service.js; never set by a client
  --   archived   superseded by a regeneration; the tasks are kept
  --   cancelled  abandoned by the learner
  --
  -- `cancelled` has no writer in this iteration. It is in the set because §5
  -- names it and because the endpoint that writes it (a cancel or delete route)
  -- is a small addition on top of this schema rather than a change to it; that
  -- deferral is recorded in docs/study-plan-architecture.md rather than left for
  -- a reader to discover from the absence of a route.
  status TEXT NOT NULL DEFAULT 'active',

  -- ── the learner's goals, kept so the plan can be regenerated ──
  --
  -- Topics the learner named. May be empty: §7 supports a plan built from
  -- materials alone, and a plan built from neither is rejected in validation
  -- rather than here, because "you gave me nothing to work with" is a 400 with a
  -- sentence, not a constraint violation.
  topics TEXT[] NOT NULL DEFAULT '{}',

  -- Weekdays the learner is willing to study on, lowercase English names. The
  -- CHECK below makes an invalid weekday unrepresentable, which is what lets
  -- plan-normalizer.js treat this column as trustworthy input.
  --
  -- Duplicate-freeness is an APPLICATION invariant, not a database one: a CHECK
  -- cannot contain a subquery, so `cardinality = count(distinct)` is not
  -- expressible here, and the alternatives (an IMMUTABLE helper function, or a
  -- 7-bit mask column) each trade a readable schema for a check whose only
  -- consequence would be cosmetic — the scheduler builds its date set from a Set,
  -- so a repeated weekday changes nothing. Validation rejects duplicates with a
  -- message; this column bounds the damage if it ever did not.
  study_days TEXT[] NOT NULL,

  -- Materials the learner scoped the plan to, recorded so a regeneration uses
  -- the same ones. A RECORD OF THE REQUEST, NOT A REFERENCE: deliberately no
  -- foreign key, because these ids are re-resolved against `materials` with the
  -- owner in the WHERE clause on every use, so one that has since been deleted
  -- or is no longer theirs simply drops out. An FK would instead make deleting a
  -- material fail, or silently rewrite a historical record of what was asked for.
  material_ids BIGINT[] NOT NULL DEFAULT '{}',

  -- The plan this one was generated to replace, for a regeneration. NULL for a
  -- first-generation plan.
  --
  -- §30 offers a version number or a parent pointer; this is the smaller of the
  -- two, because a pointer is the actual relationship and a version number is a
  -- fact derivable from it. SET NULL rather than CASCADE: losing the original
  -- must not take the replacement with it.
  --
  -- Deliberately NOT indexed. Nothing deletes a plan in this iteration — there is
  -- no delete endpoint and no user-deletion endpoint — so the only query that
  -- would use it does not exist yet, and the rule 001 set is that an index must
  -- serve a query in the code today. A plan-deletion endpoint must add it, or the
  -- cascade will scan this table once per deleted row.
  parent_plan_id BIGINT REFERENCES study_plans (id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The FK target for study_plan_tasks' composite key. Same reasoning as
  -- materials_id_user_key above: `id` is already unique, so this restricts
  -- nothing and exists only so a task can name (plan, owner) as one reference.
  CONSTRAINT study_plans_id_user_key UNIQUE (id, user_id),

  CONSTRAINT study_plans_status_valid
    CHECK (status IN ('active', 'completed', 'cancelled', 'archived')),

  CONSTRAINT study_plans_difficulty_valid
    CHECK (difficulty_level IN ('beginner', 'intermediate', 'advanced')),

  -- Same explicit trim set as users_username_not_blank and
  -- materials_original_filename_not_blank, for the same two reasons: bare btrim()
  -- strips SPACES ONLY, so a tab-only title would satisfy a constraint called
  -- "not blank"; and \x0B is how E'' spells vertical tab.
  CONSTRAINT study_plans_title_not_blank
    CHECK (btrim(title, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT study_plans_title_bounded
    CHECK (char_length(title) <= 200),

  CONSTRAINT study_plans_subject_not_blank
    CHECK (btrim(subject, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT study_plans_subject_bounded
    CHECK (char_length(subject) <= 200),

  CONSTRAINT study_plans_goal_not_blank
    CHECK (btrim(goal, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT study_plans_goal_bounded
    CHECK (char_length(goal) <= 2000),

  -- §8's "daily minutes must be positive". The upper bound is physical rather
  -- than editorial: there are 1440 minutes in a day, so a larger value is not an
  -- ambitious learner, it is a corrupt row. The POLICY ceiling is
  -- STUDYPAL_PLAN_MAX_DAILY_MINUTES in src/config/env.js and is enforced in
  -- validation, where it can be changed by a deployment without a migration.
  CONSTRAINT study_plans_daily_minutes_positive CHECK (daily_minutes > 0),
  CONSTRAINT study_plans_daily_minutes_bounded CHECK (daily_minutes <= 1440),

  CONSTRAINT study_plans_dates_ordered CHECK (end_date >= start_date),

  -- §12: nothing is scheduled after the exam. end_date is the last task's date,
  -- so this is that rule stated where it cannot be skipped.
  CONSTRAINT study_plans_ends_by_exam CHECK (end_date <= exam_date),

  -- Exactly the seven weekday names the API accepts, and at least one of them.
  -- `<@` is "contained by", so every element must be in the allowed set.
  CONSTRAINT study_plans_study_days_valid CHECK (
    cardinality(study_days) BETWEEN 1 AND 7
    AND study_days <@ ARRAY[
      'monday', 'tuesday', 'wednesday', 'thursday',
      'friday', 'saturday', 'sunday'
    ]::text[]
  ),

  -- Backstops for the configured limits, set far enough above any sane value
  -- that only a code path skipping validation could hit them.
  CONSTRAINT study_plans_topics_bounded CHECK (cardinality(topics) <= 100),
  CONSTRAINT study_plans_material_ids_bounded
    CHECK (cardinality(material_ids) <= 100),

  CONSTRAINT study_plans_parent_not_self
    CHECK (parent_plan_id IS NULL OR parent_plan_id <> id)
);

-- ── study_plan_tasks ─────────────────────────────────────────────────────────
--
-- One row per scheduled study session. Ordered by (scheduled_date, position),
-- which the UNIQUE constraint below both enforces and indexes.
CREATE TABLE study_plan_tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  study_plan_id BIGINT NOT NULL,

  -- DENORMALISED, AND NOT FOR CONVENIENCE. This column exists so the two foreign
  -- keys below can both be composite, which is the whole mechanism by which "a
  -- task's material belongs to the task's plan's owner" becomes a database rule.
  --
  -- It cannot drift: the plan FK pins (study_plan_id, user_id) to a real
  -- (id, user_id) pair in study_plans, so writing a wrong owner here fails
  -- immediately rather than creating an inconsistency to be discovered later.
  --
  -- Application code does not read it. Every query in
  -- src/study-plans/study-plan.repository.js reaches a task through its plan, so
  -- this is a constraint mechanism, not a second source of truth.
  user_id BIGINT NOT NULL,

  -- Computed by the backend from the learner's study days. See the header: the
  -- model's response schema has no date field, so there is no path by which a
  -- model-chosen date could arrive here — §13's "Gemini must not invent a
  -- Saturday task when Saturdays are excluded" is enforced by the absence of the
  -- field rather than by a check on its value.
  scheduled_date DATE NOT NULL,

  -- Order within the day, 0-based and contiguous. 0-based for the same reason
  -- material_chunks.chunk_index is: it is an offset into a sequence the
  -- normalizer produced, not a human-facing ordinal.
  position INTEGER NOT NULL,

  -- Model-generated, all four. Bounded and (for title) non-blank, because model
  -- output is not a trusted length and a task with no name is not a task.
  title TEXT NOT NULL,
  description TEXT,
  topic TEXT,

  --   study     first exposure to new material
  --   review    revisiting something already studied
  --   practice  applying it — problems, past papers, worked examples
  --   recap     a short consolidation pass, typically near the exam
  --
  -- Four values, kept small on purpose (§6). No exam task type: simulated exams
  -- are explicitly out of scope for this ticket, and a type nothing produces is
  -- the same kind of guess as a table nothing reads.
  task_type TEXT NOT NULL,

  -- Minutes. The normalizer guarantees that the sum of these over any one
  -- (study_plan_id, scheduled_date) is at most the plan's daily_minutes; that is
  -- an invariant of the packing algorithm rather than a constraint here, because
  -- a CHECK cannot see the other rows of the day. tests assert it directly.
  duration_minutes INTEGER NOT NULL,

  --   pending → in_progress → completed, or → skipped
  --
  -- Always starts at the default. A client may move it through
  -- PATCH /api/study-plans/:planId/tasks/:taskId; the model never sets it.
  status TEXT NOT NULL DEFAULT 'pending',

  -- The material this task is about, when the plan was grounded in one. NULL is
  -- the common case and an entirely valid one — §7 is explicit that not every
  -- task has a material, and §37 that a plan needs no materials at all.
  --
  -- The value is resolved backend-side from a MATERIAL_n alias (§20). The model
  -- never sees, and therefore cannot invent, a database id.
  material_id BIGINT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- CASCADE: deleting a plan takes its tasks, with no application code that
  -- could forget. The composite form is what pins user_id, above.
  CONSTRAINT study_plan_tasks_plan_fkey
    FOREIGN KEY (study_plan_id, user_id)
    REFERENCES study_plans (id, user_id) ON DELETE CASCADE,

  -- THE CROSS-USER GUARD. A task may only point at a material owned by the same
  -- user as its plan, and the database is what says so.
  --
  -- `ON DELETE SET NULL (material_id)` names its column explicitly (PostgreSQL
  -- 15+). A bare SET NULL would try to null EVERY referencing column, including
  -- user_id, which is NOT NULL — so deleting a material would fail instead of
  -- detaching it, and DELETE /api/materials/:id would start returning 500s for
  -- any material a plan had referenced.
  --
  -- Because material_id is nullable and the FK is MATCH SIMPLE, a task with no
  -- material satisfies this trivially — which is exactly the intended reading.
  CONSTRAINT study_plan_tasks_material_fkey
    FOREIGN KEY (material_id, user_id)
    REFERENCES materials (id, user_id) ON DELETE SET NULL (material_id),

  -- Ordering is part of the data, so two tasks in the same slot is a corrupt
  -- plan rather than a tolerable duplicate. This also gives the ordered read
  -- (`WHERE study_plan_id = $1 ORDER BY scheduled_date, position`) its index for
  -- free — see the index section below, which is why §51's suggested
  -- (study_plan_id, scheduled_date, position) index is not created separately.
  CONSTRAINT study_plan_tasks_slot_key
    UNIQUE (study_plan_id, scheduled_date, position),

  CONSTRAINT study_plan_tasks_type_valid
    CHECK (task_type IN ('study', 'review', 'practice', 'recap')),

  CONSTRAINT study_plan_tasks_status_valid
    CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),

  CONSTRAINT study_plan_tasks_position_non_negative CHECK (position >= 0),

  -- §8 and §21: a zero-minute task is not a task, and 1440 is the same physical
  -- bound daily_minutes gets. The real ceiling is the plan's own daily_minutes,
  -- applied by the normalizer.
  CONSTRAINT study_plan_tasks_duration_positive CHECK (duration_minutes > 0),
  CONSTRAINT study_plan_tasks_duration_bounded CHECK (duration_minutes <= 1440),

  CONSTRAINT study_plan_tasks_title_not_blank
    CHECK (btrim(title, E' \t\n\r\f\x0B') <> ''),
  CONSTRAINT study_plan_tasks_title_bounded
    CHECK (char_length(title) <= 200),

  CONSTRAINT study_plan_tasks_description_bounded
    CHECK (description IS NULL OR char_length(description) <= 2000),

  CONSTRAINT study_plan_tasks_topic_bounded
    CHECK (topic IS NULL OR char_length(topic) <= 200)
);

-- ── indexes ──────────────────────────────────────────────────────────────────
--
-- TWO created here, and the same rule 001 and 002 set applies: an index must
-- serve a query that exists in the code today. tests/study-plans/schema.test.js
-- asserts the exact list on both tables.
--
-- What the constraints above already index, and therefore what is deliberately
-- NOT repeated below:
--
--   study_plans.id                                        PK
--   (study_plans.id, user_id)                             UNIQUE — the FK target
--   study_plan_tasks.id                                   PK
--   (study_plan_tasks.study_plan_id, scheduled_date, position)  UNIQUE
--
-- That last one is the important freebie: it serves the ordered read of a plan's
-- tasks and the per-day grouping, so §51's requested
-- (study_plan_id, scheduled_date, position) index needs no CREATE INDEX of its
-- own. The per-plan ownership check (`WHERE id = $1 AND user_id = $2`) is served
-- by study_plans_id_user_key.

-- Serves GET /api/study-plans?username=… :
--   WHERE user_id = $1 ORDER BY created_at DESC, id DESC
-- Equality column first, then the sort column, so PostgreSQL finds the user's
-- rows and walks them already ordered without a sort step. The same shape as
-- idx_questions_user_created and idx_materials_user_created, for the same query
-- shape. This is §51's "index user_id".
CREATE INDEX idx_study_plans_user_created
  ON study_plans (user_id, created_at DESC);

-- Serves the referential check behind DELETE /api/materials/:id, which exists
-- today: removing a material makes PostgreSQL look for tasks pointing at it, and
-- without an index that is a sequential scan of every task in the database on
-- every material deletion.
--
-- PARTIAL, because the overwhelming majority of tasks have no material at all
-- (§7: "do not require every task to have a material") and a NULL row has
-- nothing to find. The predicate keeps the index proportional to the number of
-- grounded tasks rather than to the number of tasks.
--
-- Column order matches the foreign key's own (material_id, user_id).
CREATE INDEX idx_study_plan_tasks_material
  ON study_plan_tasks (material_id, user_id)
  WHERE material_id IS NOT NULL;

-- ── comments ─────────────────────────────────────────────────────────────────
--
-- Kept in the database so `\d+ study_plans` in psql explains the non-obvious
-- columns without anyone having to find this file.
COMMENT ON TABLE study_plans IS
  'One AI-generated study plan, plus the learner goals it was generated from. Ownership is via an unauthenticated username claim — see docs/security-baseline.md S1.';
COMMENT ON COLUMN study_plans.title IS
  'Model-generated. Bounded and non-blank because model output is not a trusted length.';
COMMENT ON COLUMN study_plans.goal IS
  'Model-generated summary of what the plan is for. A response missing it is rejected before it reaches this column.';
COMMENT ON COLUMN study_plans.start_date IS
  'First date carrying a task — computed by the backend from the learner''s study days, never supplied by the client or the model.';
COMMENT ON COLUMN study_plans.end_date IS
  'Last date carrying a task. May be well before exam_date when the content ran out; the gap is meaningful.';
COMMENT ON COLUMN study_plans.study_days IS
  'Lowercase English weekday names. Membership is enforced by CHECK; duplicate-freeness is an application invariant (a CHECK cannot hold a subquery).';
COMMENT ON COLUMN study_plans.material_ids IS
  'A record of which materials the request named, for regeneration. Deliberately not a foreign key: the ids are re-resolved against materials with the owner in the WHERE clause on every use.';
COMMENT ON COLUMN study_plans.parent_plan_id IS
  'The plan this one was generated to replace. NULL for a first-generation plan. Regeneration never overwrites — it archives the original and inserts a new row.';
COMMENT ON COLUMN study_plans.status IS
  'active | completed | cancelled | archived. `completed` is derived from task state, never set by a client. `cancelled` has no writer in this iteration.';

COMMENT ON TABLE study_plan_tasks IS
  'One scheduled study session. Dates are computed by src/study-plans/plan-normalizer.js; the model''s response schema has no date field.';
COMMENT ON COLUMN study_plan_tasks.user_id IS
  'Denormalised owner, present solely so the plan and material foreign keys can be composite. Pinned by the plan FK, never read by application code.';
COMMENT ON COLUMN study_plan_tasks.scheduled_date IS
  'Backend-computed. Always a date the learner listed as a study day, always on or before the plan''s exam_date.';
COMMENT ON COLUMN study_plan_tasks.material_id IS
  'Resolved backend-side from a MATERIAL_n prompt alias. The model never sees a database id, and the composite FK makes another user''s material unreferenceable.';
COMMENT ON COLUMN study_plan_tasks.duration_minutes IS
  'Minutes. The sum over one plan-day is at most the plan''s daily_minutes — an invariant of the packing algorithm, which a CHECK cannot see across rows.';
