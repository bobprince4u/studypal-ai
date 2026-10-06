/**
 * The public shape of every analytics response — the DTO layer (§14).
 *
 * Nothing below queries, calculates a rule or reads a request. These functions
 * take a repository row plus whatever analytics.metrics.js computed from it and
 * name the fields the API promises.
 *
 * FIELD BY FIELD, NEVER `...row` (§24)
 * ------------------------------------
 * Every mapper lists its fields explicitly, exactly as SP-V2-006's toExamShape
 * does and for the same reason recorded there: `user_id` is on almost every row
 * these queries return, and a spread would ship it the moment someone added a
 * column. §24 forbids returning raw database rows, and an explicit mapper is
 * that rule in a form the reviewer can check by reading — the response contains
 * what is written here and nothing else.
 *
 * It is also what keeps §24's other prohibitions structurally true. There is no
 * `password_hash` here because there is no `users` join anywhere in the
 * repository; there is no `correct_answer` because no query selects it; there is
 * no `storage_key` because the material breakdown selects `original_filename`
 * alone. Each absence is upstream of this file, and each mapper is the second
 * place it would have to be reintroduced deliberately.
 *
 * SNAKE_CASE IN, camelCase OUT
 * ----------------------------
 * PostgreSQL returns `completed_tasks`; the API says `completedTasks`, matching
 * the material, study-plan and exam endpoints. The boundary is here and only
 * here — no SQL below uses `AS "completedTasks"` to skip this layer, because a
 * quoted camelCase alias moves the API contract into a string inside a query,
 * where no serializer test can see it.
 *
 * NULL MEANS "NOT MEASURABLE", 0 MEANS "MEASURED AS ZERO"
 * -------------------------------------------------------
 * Every percentage below can be null, and the distinction is load-bearing: a
 * learner with no completed attempts has `averagePercentage: null`, and one who
 * scored 0 on every attempt has `averagePercentage: 0`. Counts never go null —
 * a count over nothing is 0. §18 forbids NaN, Infinity and undefined in any
 * response, and the mappers below emit only numbers, strings, booleans, nulls
 * and arrays.
 */

import {
  accuracyBreakdown,
  percentageOf,
  round2,
} from "./analytics.metrics.js";

/**
 * GET /api/analytics — the overall learning summary (§2).
 *
 * A bare object, not a collection, so it is not wrapped in an array and not
 * given a `{data: …}` envelope. §12: follow the existing StudyPal envelope.
 * GET /api/progress is the precedent — an aggregate returns a bare object,
 * a collection returns a bare array — and this endpoint is an aggregate.
 *
 * `trend` is always present, with all four fields null when there is too little
 * history (§6). Present-and-null rather than absent, so a client reads
 * `trend.direction` without an existence check, matching the five result fields
 * SP-V2-006 keeps on every attempt shape.
 *
 * @param {object} parts already-aggregated rows and computed values
 * @returns {object}
 */
export function toOverviewShape({
  plans,
  tasks,
  exams,
  attempts,
  trend,
  mostRecentPercentage,
}) {
  return {
    studyPlans: {
      total: plans.total,
      active: plans.active,
      completed: plans.completed,
      cancelled: plans.cancelled,
      archived: plans.archived,
    },
    tasks: toTaskTotalsShape(tasks),
    exams: {
      total: exams.total,
      attempts: attempts.attempts,
      completedAttempts: attempts.completed_attempts,
      inProgressAttempts: attempts.in_progress_attempts,
      passed: attempts.passed_attempts,
      failed: attempts.failed_attempts,
      // AVG arrives as a double; round2 applies the one rounding rule, and
      // passes null through untouched when nothing is completed. MAX and MIN are
      // INTEGER columns and already whole — rounding them would be a no-op that
      // implied they were not.
      averagePercentage: round2Nullable(attempts.average_percentage),
      highestPercentage: attempts.highest_percentage,
      lowestPercentage: attempts.lowest_percentage,
      // §4's "most recent percentage". Null when nothing has been completed,
      // rather than 0 — see the header.
      mostRecentPercentage: mostRecentPercentage ?? null,
    },
    trend,
  };
}

/**
 * Task counts plus their completion percentage (§2, §3).
 *
 * Shared by the overview and the per-plan endpoint so the two cannot drift:
 * "completion percentage" means `completed / total × 100` in both, computed by
 * the same function, rounded by the same rule. A zero-task plan gives null —
 * §3 requires the case to be handled and forbids NaN or Infinity; null is the
 * choice this API makes, because 0% would claim a measurement that was not taken.
 *
 * The denominator is EVERY task, including skipped ones. A skipped task was
 * scheduled and is not done, so excluding it would let a learner reach 100% by
 * skipping everything but one task. SP-V2-005 treats `skipped` as terminal-but-
 * not-completed in recomputePlanStatus, and this matches it rather than
 * inventing a second definition.
 */
function toTaskTotalsShape(tasks) {
  return {
    total: tasks.total,
    completed: tasks.completed,
    pending: tasks.pending,
    inProgress: tasks.in_progress,
    skipped: tasks.skipped,
    completionPercentage: percentageOf(tasks.completed, tasks.total),
  };
}

/**
 * One row of GET /api/analytics/exams (§5).
 *
 * Every value is one SP-V2-006 persisted. There is no `correctAnswer`, no
 * `explanation`, no `options` and no `selectedAnswer` — reading a single
 * attempt's answers is what GET /api/exams/:id/attempts/:attemptId is for, and
 * analytics has no business becoming a second route to the answer key.
 *
 * `startedAt` and `submittedAt` are passed through as the ISO-8601 strings
 * src/config/pg-types.js produced (§17). Nothing here reformats them, computes
 * a duration from them, or compares them to the current time.
 */
export function toHistoryShape(row) {
  return {
    attemptId: row.attempt_id,
    examId: row.exam_id,
    examTitle: row.exam_title,
    examSubject: row.exam_subject,
    examDifficulty: row.exam_difficulty,
    score: row.score,
    totalQuestions: row.total_questions,
    correctAnswers: row.correct_answers,
    percentage: row.percentage,
    passed: row.passed,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * One row of GET /api/analytics/topics (§7).
 *
 * `incorrect` is derived inside accuracyBreakdown rather than counted in SQL,
 * so `correct + incorrect === questionsAttempted` is true by construction. The
 * alternative — a second COUNT FILTER on `NOT is_correct` — would be one NULL
 * away from a response whose own numbers disagree.
 */
export function toTopicShape(row) {
  return {
    topic: row.topic,
    ...accuracyBreakdown({ attempted: row.attempted, correct: row.correct }),
  };
}

/**
 * One row of GET /api/analytics/weak-areas (§10).
 *
 * The topic shape plus `reason`. There is one reason string today —
 * "accuracy_below_threshold" — and it is emitted as a machine-readable token
 * rather than prose so a client can branch on it and a future second rule can
 * be added without breaking the first.
 *
 * WHAT THIS FIELD IS NOT. It is not advice, not a recommendation, and not a
 * sentence telling the learner what to study (§26). It names the measurement
 * that put the topic in the list: accuracy was below the configured threshold
 * with at least the configured evidence. Deciding what to do about that is a
 * later phase's job, and §1 puts it outside this one.
 */
export function toWeakAreaShape(row) {
  return {
    topic: row.topic,
    questionsAttempted: row.questionsAttempted,
    correct: row.correct,
    incorrect: row.incorrect,
    accuracyPercentage: row.accuracyPercentage,
    reason: "accuracy_below_threshold",
  };
}

/**
 * One row of GET /api/analytics/materials (§8).
 *
 * `materialId: null` is the deleted-or-unattributed group, and `filename` is
 * null with it. §8: "Do not pretend deleted-material attribution still exists"
 * and "Do not recreate deleted material metadata" — so there is no placeholder
 * name, no "(deleted)" string and no id remembered from elsewhere. The row says
 * how many answered questions have no material behind them, which is a true
 * statement, and says nothing about what that material was.
 *
 * `filename` rather than `originalFilename`: it is the display name the
 * learner uploaded, and the materials API already returns it under a name of
 * its own choosing. `storage_key` is never selected and never appears here —
 * it is an internal path component, and §24 lists internal fields as
 * non-exposable.
 */
export function toMaterialShape(row) {
  return {
    materialId: row.material_id ?? null,
    filename: row.original_filename ?? null,
    ...accuracyBreakdown({ attempted: row.attempted, correct: row.correct }),
  };
}

/**
 * GET /api/analytics/study-plans/:id (§3).
 *
 * `status` is the plan's STORED status, read from the row. It is reported
 * alongside `tasks.completionPercentage` and is not derived from it: SP-V2-005
 * owns when a plan becomes `completed`, §3 forbids duplicating that logic here,
 * and a plan at 100% whose status is still `active` is reported exactly that way
 * — accurately, and visibly enough that the discrepancy can be investigated
 * rather than smoothed over by analytics.
 *
 * The dates are the 'YYYY-MM-DD' strings PostgreSQL sent, passed through by the
 * DATE parser SP-V2-005 registered (§17). Nothing here converts them to a Date,
 * which is the bug that parser exists to prevent.
 */
export function toPlanProgressShape(row, topics) {
  return {
    planId: row.id,
    title: row.title,
    subject: row.subject,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    examDate: row.exam_date,
    dailyMinutes: row.daily_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tasks: toTaskTotalsShape({
      total: row.total_tasks,
      completed: row.completed_tasks,
      pending: row.pending_tasks,
      in_progress: row.in_progress_tasks,
      skipped: row.skipped_tasks,
    }),
    topics,
  };
}

/**
 * One topic's task progress within a plan (§3).
 *
 * `topic: null` groups the tasks SP-V2-005 left untopiced — the column is
 * nullable by design there, so this is a normal row rather than a data problem.
 *
 * This is PROGRESS, not accuracy. A task is done or not; a question is right or
 * wrong. The field is called `completionPercentage` and not
 * `accuracyPercentage` so the two can never be read as the same measurement.
 */
export function toPlanTopicShape(row) {
  return {
    topic: row.topic ?? null,
    totalTasks: row.total_tasks,
    completedTasks: row.completed_tasks,
    completionPercentage: percentageOf(row.completed_tasks, row.total_tasks),
  };
}

/**
 * Round a value that may legitimately be null.
 *
 * AVG over zero rows is SQL NULL, which means "no completed attempts" and must
 * survive to the response as null. `round2(null)` would return null too — null
 * is not finite — but going through this helper states the intent, so a later
 * reader does not have to work out whether the null case was considered.
 */
function round2Nullable(value) {
  return value === null || value === undefined ? null : round2(value);
}
