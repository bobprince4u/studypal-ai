/**
 * Every SQL statement in SP-V2-007, and the only module in `src/analytics/`
 * that imports the database.
 *
 * READ-ONLY, STRUCTURALLY
 * -----------------------
 * There is no INSERT, UPDATE, DELETE, UPSERT or `withTransaction` below, and
 * §1 forbids adding one. Analytics is a consumer of what SP-V2-001 through
 * SP-V2-006 persisted: the study plan owns plan state, the grader owns
 * correctness, the exam service owns attempts, and this module counts rows they
 * wrote. tests/analytics/architecture.test.js asserts the absence of write verbs
 * in this file rather than trusting the reviewer to notice one appearing.
 *
 * The same absence covers §1's other prohibitions by construction: the module
 * imports `query` and nothing else, so there is no client to call Gemini with,
 * no embedding provider, and no vector operator anywhere in the SQL.
 *
 * OWNERSHIP IS A WHERE CLAUSE, NOT AN `if` (§11)
 * ---------------------------------------------
 * Every function takes `userId` and every statement below filters on it. There
 * is no id-only read — `findPlanProgress` takes `(planId, userId)` and its
 * WHERE carries both, exactly like the study-plan repository's
 * `findOwnedById`. §11's bad example (`WHERE id = $1`) cannot be written here
 * without adding a parameter no caller passes.
 *
 * The join predicates carry `user_id` too, and that is deliberate rather than
 * decorative. `JOIN exams e ON e.id = q.exam_id AND e.user_id = att.user_id`
 * is redundant today, because exam_questions_exam_user_fkey already guarantees a
 * question's exam belongs to the question's user. Writing it anyway means the
 * isolation survives a future schema change that relaxes the composite key: the
 * query would return fewer rows, never another learner's.
 *
 * WHICH TABLE DRIVES EACH QUERY, AND WHY (§19)
 * --------------------------------------------
 * No index is added by this phase, and the reason is that every aggregate is
 * entered through a table that already indexes `user_id` as its leading column:
 *
 *   study plans, tasks   idx_study_plans_user_created (user_id, created_at DESC)
 *   exams                idx_exams_user_created (user_id, created_at DESC)
 *   attempts, answers    idx_exam_attempts_user_started (user_id, started_at DESC)
 *
 * That is why the task aggregate joins DOWN from `study_plans` rather than
 * reading `study_plan_tasks WHERE user_id = $1` directly, and why the topic and
 * material aggregates start at `exam_attempts` rather than at `attempt_answers`.
 * Both of those tables carry `user_id` and both would give the same answer read
 * directly — and both would sequentially scan, because neither has an index
 * leading with it.
 *
 * Every hop after the entry point lands on an index that already exists:
 * study_plan_tasks via study_plan_tasks_plan_date_position_key, attempt_answers
 * via attempt_answers_attempt_question_key, exam_questions and exams via their
 * primary keys, materials via its own. §19 asks for a justification for every
 * NEW index; the justification for none is that rewriting a join order is
 * cheaper than a migration, and tests/study-plans/schema.test.js and
 * tests/exams/schema.test.js both assert the exact index list on those tables —
 * an index added here would be a change to SP-V2-005 and SP-V2-006, not an
 * addition to SP-V2-007.
 *
 * WHY EVERY COUNT IS CAST `::int`
 * -------------------------------
 * COUNT() returns BIGINT, and src/config/pg-types.js parses scalar INT8 to a JS
 * number — so the cast changes nothing today. It is there because that parser is
 * a process-global registration, and a pool opened without it (the migration
 * tool, a future worker, a test that builds its own client) would receive the
 * string "12". Casting in the statement makes the column INT4, which pg parses
 * to a number with no registration at all, so these queries return numbers
 * wherever they are run. AVG is cast for the same reason: NUMERIC has no
 * default numeric parser either, and an average arriving as "74.5714285714"
 * would reach §18's "never return NaN" check as a string that fails it silently.
 *
 * TIMESTAMPS AND DATES ARE PASSED THROUGH, NOT RECONSTRUCTED (§17)
 * ---------------------------------------------------------------
 * `submitted_at` arrives as an ISO-8601 string and `start_date` as
 * 'YYYY-MM-DD', both from the parsers src/config/pg-types.js registered for
 * SP-V2-005. Nothing below calls `new Date()`, `now()` or `CURRENT_DATE`:
 * §17 forbids using server time to reconstruct a historical event, and the
 * events analytics reports all already have a stored timestamp. There is no
 * date grouping in this phase, so there is no timezone convention to declare
 * beyond the session TimeZone=UTC the pool already pins.
 */

import { query } from "../config/database.js";

/**
 * Study-plan counts by status (§2).
 *
 * All four states the schema's status CHECK allows, and only those four. §2
 * says "Do not manufacture values for states that do not exist", so `archived`
 * appears because migrations/postgres/004_study_plans.sql permits it — not
 * because a dashboard wanted a fourth number.
 *
 * FILTER rather than four queries or a GROUP BY the service would have to
 * pivot: one pass, a fixed set of keys, and a status with no rows comes back as
 * 0 rather than as a missing key. A GROUP BY would omit it, and the caller
 * would have to know the full status list to fill the gap — which would put a
 * copy of the schema's CHECK constraint in the service.
 *
 * @param {number} userId
 * @returns {Promise<{total: number, active: number, completed: number,
 *   cancelled: number, archived: number}>}
 */
export async function findStudyPlanTotals(userId) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE status = 'archived')::int AS archived
     FROM study_plans
     WHERE user_id = $1`,
    [userId],
  );

  // An aggregate with no GROUP BY always returns exactly one row, even over
  // zero rows — that is the whole reason the zero-data case needs no branch
  // here. COUNT of nothing is 0, not NULL.
  return rows[0];
}

/**
 * Study-plan task counts by status, across all of a learner's plans (§2).
 *
 * Entered through `study_plans` rather than `study_plan_tasks`, which is the
 * §19 decision recorded in this file's header: study_plan_tasks carries
 * `user_id` and filtering on it directly would be correct and would seq scan,
 * because the only indexes on that table lead with `study_plan_id` and
 * `material_id`.
 *
 * `in_progress` is included for the same reason `archived` is above: the
 * schema's CHECK allows it. §2 lists total/completed/pending/skipped; reporting
 * three of the four real states would make the numbers fail to add up, which is
 * worse than a field the example DTO did not mention.
 *
 * @param {number} userId
 * @returns {Promise<{total: number, completed: number, pending: number,
 *   inProgress: number, skipped: number}>}
 */
export async function findTaskTotals(userId) {
  const { rows } = await query(
    `SELECT
       COUNT(t.id)::int AS total,
       COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed,
       COUNT(t.id) FILTER (WHERE t.status = 'pending')::int AS pending,
       COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
       COUNT(t.id) FILTER (WHERE t.status = 'skipped')::int AS skipped
     FROM study_plans p
     JOIN study_plan_tasks t
       ON t.study_plan_id = p.id
      AND t.user_id = p.user_id
     WHERE p.user_id = $1`,
    [userId],
  );

  return rows[0];
}

/**
 * How many exams the learner has generated (§2's `exams.total`).
 *
 * Every exam, `cancelled` ones included. The field answers "how many exams have
 * I made", which is a fact about the learner's activity; filtering by status
 * would answer "how many can I still sit", which is a different question and
 * not one §2 asks.
 *
 * @param {number} userId
 * @returns {Promise<{total: number}>}
 */
export async function findExamTotals(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM exams
     WHERE user_id = $1`,
    [userId],
  );

  return rows[0];
}

/**
 * Attempt counts and score extremes (§4).
 *
 * EVERY NUMBER HERE IS ONE SP-V2-006 ALREADY WROTE. `percentage` and `passed`
 * are columns on exam_attempts, computed by src/exams/grader.js at submission
 * against `exam.passingPercentage` as it stood then. Nothing below recomputes a
 * pass mark or compares a percentage to a threshold — §4's "Analytics MUST NOT
 * independently redefine grading" is satisfied by reading the stored verdict,
 * and the practical consequence is that lowering the pass mark in config does
 * not retroactively pass old attempts. It should not: they were graded.
 *
 * `status = 'completed'` guards every score aggregate. An in-progress attempt
 * has NULL in all five result columns (the exam_attempts_result_consistency
 * CHECK enforces that), so AVG and MAX would skip it anyway — but `attempts`
 * counts it and `completedAttempts` must not, which is §4's "Do not count
 * unfinished attempts as completed exam results".
 *
 * `failed` is `NOT passed`, not `total - passed`. The difference matters when an
 * attempt is in progress: subtracting would count an unfinished sitting as a
 * failure, which is §4's "Do not silently treat an abandoned attempt as a failed
 * exam". SP-V2-006 defines no such rule, so neither does this.
 *
 * @param {number} userId
 * @returns {Promise<object>} averagePercentage is null when nothing is completed
 */
export async function findAttemptTotals(userId) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS attempts,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_attempts,
       COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_attempts,
       COUNT(*) FILTER (WHERE status = 'completed' AND passed)::int AS passed_attempts,
       COUNT(*) FILTER (WHERE status = 'completed' AND NOT passed)::int AS failed_attempts,
       AVG(percentage) FILTER (WHERE status = 'completed')::double precision
         AS average_percentage,
       MAX(percentage) FILTER (WHERE status = 'completed') AS highest_percentage,
       MIN(percentage) FILTER (WHERE status = 'completed') AS lowest_percentage
     FROM exam_attempts
     WHERE user_id = $1`,
    [userId],
  );

  return rows[0];
}

/**
 * The most recent completed attempts, newest first (§5).
 *
 * `LIMIT $2`, bound rather than interpolated. §15 names limits explicitly among
 * the things never to interpolate, and the clamping that decides what reaches
 * this parameter happens in the validation middleware, where a caller cannot
 * skip it by calling the repository directly — this function will happily bind
 * whatever number it is given, which is why the ceiling belongs upstream and not
 * as a defensive `Math.min` here that would hide a validation gap.
 *
 * ORDER BY carries `id DESC` as a tie-break. Two attempts submitted in the same
 * millisecond are possible (TIMESTAMPTZ has microsecond resolution, but a
 * batch-seeded test fixture can share a value), and without the second key
 * PostgreSQL may return them in either order — so the "10 most recent" of an
 * 11-attempt history could differ between two identical requests. §5 asks for a
 * bounded list; a bounded list whose contents are not determined is not one.
 *
 * WHAT IS NOT SELECTED: `correct_answer`, `explanation`, `options`,
 * `selected_answer`. §5's "Do not expose correct answers" is met by this
 * statement not naming the columns, in the same way SP-V2-006's
 * findQuestionsForTaking meets §4 — there is no key in the result set to leak.
 * The exam's title, subject and difficulty ARE joined, because a history row
 * showing only `examId: 20` is not readable by the learner who sat it.
 *
 * @param {number} userId
 * @param {number} limit already validated and clamped
 * @returns {Promise<Array<object>>}
 */
export async function findRecentCompletedAttempts(userId, limit) {
  const { rows } = await query(
    `SELECT
       att.id AS attempt_id,
       att.exam_id,
       att.score,
       att.total_questions,
       att.correct_answers,
       att.percentage,
       att.passed,
       att.started_at,
       att.submitted_at,
       e.title AS exam_title,
       e.subject AS exam_subject,
       e.difficulty AS exam_difficulty
     FROM exam_attempts att
     JOIN exams e
       ON e.id = att.exam_id
      AND e.user_id = att.user_id
     WHERE att.user_id = $1
       AND att.status = 'completed'
     ORDER BY att.submitted_at DESC, att.id DESC
     LIMIT $2`,
    [userId, limit],
  );

  return rows;
}

/**
 * Just the percentages of the most recent completed attempts, newest first (§6).
 *
 * Feeds compareRecentPerformance and nothing else. A separate query from the
 * history read above, rather than reusing it, because the two want different
 * row counts: the history returns what the learner asked for (default 10,
 * client-adjustable within the cap), and the trend needs exactly
 * `2 × trendWindow` regardless of what the history request said. Sharing one
 * read would tie the trend's window to a query parameter, and a `?limit=2`
 * would then silently erase the trend.
 *
 * Same ORDER BY as the history, for the same determinism reason — and it must
 * be the same, or the "most recent attempt" reported by the overview could
 * disagree with the first row of the history.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<number>>} percentages, most recent first
 */
export async function findRecentCompletedPercentages(userId, limit) {
  const { rows } = await query(
    `SELECT att.percentage
     FROM exam_attempts att
     WHERE att.user_id = $1
       AND att.status = 'completed'
     ORDER BY att.submitted_at DESC, att.id DESC
     LIMIT $2`,
    [userId, limit],
  );

  return rows.map((row) => row.percentage);
}

/**
 * Answered-question counts per topic (§7).
 *
 * HOW A QUESTION GETS A TOPIC, WHICH §7 SAYS TO INSPECT RATHER THAN GUESS
 * ----------------------------------------------------------------------
 * It does not have one. `exam_questions` has no topic column — SP-V2-006 stores
 * topics as `exams.topics TEXT[]`, the list the learner ASKED FOR when
 * generating the exam, and the model is never asked which topic each question
 * belongs to. So the only attribution the persisted data supports is
 * exam-level: every answered question of an exam counts toward every topic that
 * exam was generated for. That is what the CROSS JOIN LATERAL does.
 *
 * The consequence is real and must not be hidden: an exam generated for
 * ["Algebra", "Geometry"] contributes each of its answered questions to BOTH
 * topics, so the topic counts sum to more than the questions answered. A learner
 * who answered 10 questions on a two-topic exam sees 10 under Algebra and 10
 * under Geometry, not 5 and 5. The ACCURACY is unaffected — the same rows are in
 * both numerator and denominator — which is why the weak-area rule built on it
 * still means something. docs/learning-analytics-architecture.md states this
 * where a reader meets it, and it is the reason §9's evidence floor is counted in
 * QUESTIONS rather than in exams.
 *
 * Splitting the attribution would mean guessing which question is "really"
 * Algebra, which §7 forbids and which no stored column supports. Per-question
 * topics would be a change to SP-V2-006's generation prompt and schema, which is
 * outside this phase.
 *
 * `is_correct` is read, never derived. §7: "Do not calculate correctness using a
 * second grading implementation." `correct_answer` is not selected, not joined
 * and not compared anywhere in this file.
 *
 * An exam with an empty `topics` array contributes nothing: `unnest('{}')`
 * produces zero rows and the LATERAL join drops the question. That is correct —
 * it has no topic to attribute to — and those questions are still counted by
 * the material breakdown and by every exam-level aggregate.
 *
 * @param {number} userId
 * @returns {Promise<Array<{topic: string, attempted: number, correct: number}>>}
 */
export async function findTopicBreakdown(userId) {
  const { rows } = await query(
    `SELECT
       t.topic,
       COUNT(*)::int AS attempted,
       COUNT(*) FILTER (WHERE aa.is_correct)::int AS correct
     FROM exam_attempts att
     JOIN attempt_answers aa
       ON aa.attempt_id = att.id
      AND aa.user_id = att.user_id
     JOIN exam_questions q
       ON q.id = aa.exam_question_id
      AND q.user_id = att.user_id
      AND q.exam_id = att.exam_id
     JOIN exams e
       ON e.id = q.exam_id
      AND e.user_id = att.user_id
     CROSS JOIN LATERAL (SELECT DISTINCT topic FROM unnest(e.topics) AS topic) AS t
     WHERE att.user_id = $1
       AND att.status = 'completed'
     GROUP BY t.topic
     ORDER BY t.topic ASC`,
    [userId],
  );

  return rows;
}

/**
 * Answered-question counts per source material (§8).
 *
 * §8 says to inspect the type and semantics of the material provenance before
 * using it, and the inspection changes the answer: `exams.material_ids` is
 * BIGINT[] and says which documents an exam was GENERATED FROM, which is not
 * attribution — a question can only be traced to the document it actually came
 * from. `exam_questions.source_material_id` is that, a scalar nullable BIGINT
 * written per question by SP-V2-006's exam service from the model's cited
 * source number.
 *
 * Using it sidesteps §16 entirely. BIGINT[] arrives as `["1","2"]` because no
 * INT8-array parser is registered, and src/exams/exam.repository.js carries a
 * `withNumericMaterialIds` workaround for exactly that. A scalar BIGINT is
 * parsed to a number by the parser that IS registered, so this query needs no
 * conversion, no second parser, and no copy of that workaround — §16's "prefer
 * the smallest safe solution", which here is a smaller query rather than a
 * smaller function.
 *
 * DELETED MATERIALS, WHICH §8 SINGLES OUT
 * ---------------------------------------
 * exam_questions_source_material_fkey is ON DELETE SET NULL, so deleting a
 * material NULLs `source_material_id` on its questions while `exams.source_type`
 * stays 'material'. Those questions are not dropped and not given a fabricated
 * name: they group into a single row with a NULL material_id, which the
 * serializer surfaces as `materialId: null`. §8's "Represent unavailable
 * attribution safely" and "Do not recreate deleted material metadata" are the
 * same instruction read twice, and one honest bucket satisfies both — silently
 * filtering the NULLs would make the material accuracies fail to account for
 * questions the learner demonstrably answered.
 *
 * The LEFT JOIN is therefore doing two jobs: it keeps the NULL group, and it
 * tolerates a non-NULL id whose material row is somehow absent. The composite FK
 * makes that second case unreachable today; an inner join would turn it into
 * silently missing rows if it ever became reachable, and a LEFT JOIN turns it
 * into a visible null filename.
 *
 * @param {number} userId
 * @returns {Promise<Array<object>>} the unattributed group sorts last
 */
export async function findMaterialBreakdown(userId) {
  const { rows } = await query(
    `SELECT
       q.source_material_id AS material_id,
       m.original_filename,
       COUNT(*)::int AS attempted,
       COUNT(*) FILTER (WHERE aa.is_correct)::int AS correct
     FROM exam_attempts att
     JOIN attempt_answers aa
       ON aa.attempt_id = att.id
      AND aa.user_id = att.user_id
     JOIN exam_questions q
       ON q.id = aa.exam_question_id
      AND q.user_id = att.user_id
      AND q.exam_id = att.exam_id
     LEFT JOIN materials m
       ON m.id = q.source_material_id
      AND m.user_id = att.user_id
     WHERE att.user_id = $1
       AND att.status = 'completed'
     GROUP BY q.source_material_id, m.original_filename
     ORDER BY q.source_material_id ASC NULLS LAST`,
    [userId],
  );

  return rows;
}

/**
 * One study plan and its task counts, or undefined (§3, §11).
 *
 * `WHERE p.id = $1 AND p.user_id = $2` — §11's "Good" example, and the reason
 * this function has no id-only sibling. Absent and not-yours both return
 * undefined, so the service answers 404 for both without being able to tell
 * them apart; §11's "Do not leak whether another user's resource exists" is
 * then a property of the return type rather than of the caller's discipline.
 * This mirrors the study-plan repository's findOwnedById exactly, which is the
 * established StudyPal not-found semantic §11 says to preserve.
 *
 * LEFT JOIN, so a plan with no tasks returns a row with zeros rather than no
 * row. §3 requires the zero-task plan to be handled; handling it HERE means the
 * service never has to distinguish "plan absent" from "plan empty", and the
 * completion percentage over zero tasks is decided once, in analytics.metrics.js,
 * where `percentageOf(0, 0)` is null.
 *
 * `p.status` is SELECTED, never computed. §3: "Do not duplicate study-plan
 * state-management logic." SP-V2-005 owns when a plan becomes `completed` —
 * study_plan.repository.js's recomputePlanStatus does it inside the task-update
 * transaction — and a plan whose tasks are all done but whose status has not
 * been recomputed is reported by this endpoint as `active` with 100% completion.
 * Reporting the stored status and the computed percentage side by side is
 * accurate; overriding one with the other would be this module writing plan
 * state in everything but the verb.
 *
 * @param {number|string} planId
 * @param {number} userId
 * @returns {Promise<object | undefined>}
 */
export async function findPlanProgress(planId, userId) {
  const { rows } = await query(
    `SELECT
       p.id,
       p.title,
       p.subject,
       p.status,
       p.start_date,
       p.end_date,
       p.exam_date,
       p.daily_minutes,
       p.created_at,
       p.updated_at,
       COUNT(t.id)::int AS total_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'pending')::int AS pending_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'skipped')::int AS skipped_tasks
     FROM study_plans p
     LEFT JOIN study_plan_tasks t
       ON t.study_plan_id = p.id
      AND t.user_id = p.user_id
     WHERE p.id = $1
       AND p.user_id = $2
     GROUP BY p.id`,
    [planId, userId],
  );

  return rows[0];
}

/**
 * Per-topic task counts for one plan (§3).
 *
 * `study_plan_tasks.topic` is nullable — SP-V2-005 does not require every task
 * to carry one — so tasks without a topic group into a single NULL row that the
 * serializer surfaces as `topic: null`. The same honesty as the material
 * breakdown above: the counts account for every task in the plan, and the
 * per-topic numbers add up to the plan totals.
 *
 * This is plan PROGRESS by topic, not performance by topic. The two are
 * different measurements from different tables — a task is completed or not,
 * an exam question is correct or not — and the DTOs keep them apart so that
 * `completionPercentage` is never read as an accuracy.
 *
 * @param {number|string} planId
 * @param {number} userId
 * @returns {Promise<Array<object>>}
 */
export async function findPlanTopicProgress(planId, userId) {
  const { rows } = await query(
    `SELECT
       t.topic,
       COUNT(*)::int AS total_tasks,
       COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed_tasks
     FROM study_plans p
     JOIN study_plan_tasks t
       ON t.study_plan_id = p.id
      AND t.user_id = p.user_id
     WHERE p.id = $1
       AND p.user_id = $2
     GROUP BY t.topic
     ORDER BY t.topic ASC NULLS LAST`,
    [planId, userId],
  );

  return rows;
}
