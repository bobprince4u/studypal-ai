/**
 * Study plan orchestration: the layer that owns the order things happen in.
 *
 * Knows nothing about HTTP — no `req`, no `res`, no status codes except through
 * AppError — and nothing about SQL. It coordinates six collaborators and makes
 * the decisions that belong to none of them individually.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER (§25)
 * -----------------------------------------
 *   1. resolve the username to a user id            — ownership starts here
 *   2. resolve material ids against that user       — §10, never the client's word
 *   3. compute the available study dates            — §13, backend owns the calendar
 *   4. retrieve material context                    — §14, bounded, reused RAG
 *   5. call Gemini and validate what comes back     — §19
 *   6. normalize into a dated, budgeted schedule    — §21, §22
 *   7. BEGIN, write the plan and its tasks, COMMIT  — §25
 *
 * Steps 4 and 5 are the slow ones and they happen BEFORE step 7, which is the
 * rule §25 states outright: "Do not call Gemini while holding a database
 * transaction open." A provider round trip inside `BEGIN` holds a pooled
 * connection and its locks for as long as the provider takes, which on a slow
 * generation is tens of seconds — at ten pooled connections, a handful of
 * concurrent plans would starve every other endpoint in the service.
 *
 * Steps 3 and 6 are the §11 split. The model is called between them and is given
 * neither the dates nor the budget arithmetic: it receives how much room there
 * is and returns an ordered list, and the backend decides what that list means in
 * calendar terms. Nothing the model returns can put a task on an excluded day,
 * after the exam, or over the daily budget, because nothing it returns is a date.
 *
 * WHAT A FAILURE LEAVES BEHIND
 * ----------------------------
 * Nothing, at every step. Steps 1-6 have not written anything, so an error there
 * is simply an error. Step 7 is one transaction, so a failure inside it rolls
 * back the plan and every task together — §25's "do not leave half-created
 * plans" is the database's guarantee rather than a cleanup path.
 */

import { config } from "../config/env.js";
import { badRequest, internal, notFound } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";
import * as users from "../repositories/user.repository.js";
import * as planRepository from "./study-plan.repository.js";
import { buildMaterialBrief, resolveMaterials } from "./material-brief.js";
import { generateStudyPlan } from "./study-plan-generator.js";
import { normalizePlan } from "./plan-normalizer.js";
import { availableStudyDates, todayIso } from "./study-calendar.js";

/**
 * Create a plan from a learner's goals.
 *
 * @param {object} input already validated by study-plan-validation.middleware.js
 * @returns {Promise<object>} the API shape, tasks included
 */
export async function createStudyPlan({
  username,
  subject,
  topics,
  examDate,
  dailyMinutes,
  difficultyLevel,
  studyDays,
  materialIds,
}) {
  const userId = await requireUserId(username);

  return generateAndPersist({
    userId,
    goals: {
      subject,
      topics,
      examDate,
      dailyMinutes,
      difficultyLevel,
      studyDays,
      materialIds,
    },
    parentPlanId: null,
  });
}

/**
 * Generate a fresh plan from an existing plan's goals (§30).
 *
 * NEVER OVERWRITES. The original keeps its id, its tasks and the learner's
 * progress through them; the new plan is a new row pointing back at it through
 * `parent_plan_id`, and the repository archives the original in the same
 * transaction so there is no moment at which both are active or neither is.
 *
 * The goals come from the stored plan rather than from the request, which is why
 * this endpoint's body is only `{username}`. That is not merely convenient: a
 * regeneration that accepted new goals would be a create endpoint with a
 * confusing name, and the lineage `parent_plan_id` records would be a lie about
 * what the two plans have in common.
 *
 * `material_ids` is re-resolved against the database on the way through, so a
 * material deleted since the original plan was made simply drops out and one
 * that changed hands is no longer theirs to use.
 *
 * @param {object} input
 * @param {number} input.id the plan to regenerate from
 * @param {string} input.username
 * @returns {Promise<object>} the NEW plan, in the API shape
 */
export async function regenerateStudyPlan({ id, username }) {
  const userId = await requireUserId(username);

  const original = await planRepository.findOwnedById(id, userId);
  if (!original) throw notFoundPlan();

  return generateAndPersist({
    userId,
    goals: {
      subject: original.subject,
      topics: original.topics,
      examDate: original.exam_date,
      dailyMinutes: original.daily_minutes,
      difficultyLevel: original.difficulty_level,
      studyDays: original.study_days,
      materialIds: original.material_ids,
    },
    parentPlanId: original.id,
  });
}

/**
 * The shared body of creation and regeneration.
 *
 * One function rather than two similar ones, so there is no way for the two
 * endpoints to drift apart on ownership, scheduling or validation — a
 * regenerated plan is subject to exactly the checks a new one is.
 */
async function generateAndPersist({ userId, goals, parentPlanId }) {
  // §10. The client's material ids are a request, not a fact: what comes back is
  // what the database says this user owns, and the aliases are built from that.
  const { materials, missing } = await resolveMaterials(
    goals.materialIds,
    userId,
  );

  if (missing > 0) {
    // A 400, not a silent drop. A learner who scoped a plan to four documents
    // and received one grounded in three has been given something other than
    // what they asked for, with nothing in the response to say so. The message
    // does not say WHICH ids failed or whether they exist at all — that would
    // let an unauthenticated caller enumerate material ids by watching the
    // error change.
    throw badRequest(
      "One or more of the selected materials could not be found.",
    );
  }

  // §12 and §13, and the reason the client's clock is not consulted: a start
  // date from a device is a value whose timezone and correctness are both
  // unknown, and accepting one would let a request schedule into the past.
  const startDate = todayIso();
  const dates = availableStudyDates({
    from: startDate,
    to: goals.examDate,
    studyDays: goals.studyDays,
    maxDates: config.plan.maxHorizonDays,
  });

  if (dates.length === 0) {
    // The one genuinely impossible request, and the one case §22 answers with a
    // message instead of by compressing: there is no schedule to compress into.
    // Actionable, and safe to say — it repeats only what the learner sent.
    throw badRequest(
      "There are no study days between today and your exam date. Add more study days or choose a later exam date.",
    );
  }

  const totalMinutes = dates.length * goals.dailyMinutes;

  // §14. Retrieval happens here, outside any transaction, and throws on a
  // provider failure rather than quietly producing an ungrounded plan.
  const brief = await buildMaterialBrief({
    userId,
    materials,
    subject: goals.subject,
    topics: goals.topics,
  });

  const generated = await generateStudyPlan({
    learner: {
      subject: goals.subject,
      topics: goals.topics,
      difficultyLevel: goals.difficultyLevel,
      dailyMinutes: goals.dailyMinutes,
      // Counts, not dates. See src/ai/prompts/study-plan.prompt.js — the model
      // is told how much room there is, never which days it may use.
      sessionCount: dates.length,
      totalMinutes,
      materials,
    },
    materialContext: brief.context,
    aliases: brief.aliases,
  });

  const normalized = normalizePlan({
    tasks: generated.tasks,
    availableDates: dates,
    dailyMinutes: goals.dailyMinutes,
    aliasToMaterialId: brief.aliasToMaterialId,
  });

  if (normalized === null) {
    // Unreachable in practice: `dates` is non-empty by the check above, the
    // validator guarantees at least one task, and a clamped duration always fits
    // an empty day — so the first task is always placed. Kept as a backstop
    // because "unreachable" is a property of three separate modules agreeing,
    // and a 500 is a better outcome than persisting a plan with no tasks.
    logger.error("study plan: normalization produced no schedulable tasks");
    throw internal("AI study plan generation failed", {
      code: "AI_INVALID_OUTPUT",
    });
  }

  const { plan, tasks } = await planRepository.insertPlanWithTasks({
    plan: {
      userId,
      title: generated.title,
      subject: goals.subject,
      goal: generated.goal,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      examDate: goals.examDate,
      dailyMinutes: goals.dailyMinutes,
      difficultyLevel: goals.difficultyLevel,
      topics: goals.topics,
      studyDays: goals.studyDays,
      // What the learner asked for, recorded for regeneration — not what
      // resolution returned. The two are equal here (missing > 0 already threw),
      // and storing the request keeps the column's meaning stable.
      materialIds: goals.materialIds,
      parentPlanId,
    },
    tasks: normalized.tasks,
  });

  logger.info(
    `study plan ${plan.id} created for user ${userId}: ${tasks.length} tasks ` +
      `over ${dates.length} study days, ${materials.length} material(s), ` +
      `${brief.sourceCount} extract(s)`,
  );

  return toApiShape(plan, tasks);
}

/**
 * A user's plans, newest first (§26).
 *
 * Metadata only — no task lists. An unknown username gives an empty array rather
 * than a 404, matching listMaterials and GET /api/history: the frontend maps over
 * the result unguarded, and "this user has nothing" and "this user does not
 * exist" are the same answer to a client that cannot authenticate anyway.
 *
 * @param {string} username
 * @returns {Promise<Array<object>>} always an array
 */
export async function listStudyPlans(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) return [];

  const rows = await planRepository.findByUserId(userId, PLAN_LIST_LIMIT);
  return rows.map((row) => toSummaryShape(row));
}

/**
 * One plan with its tasks, if it belongs to this user (§27).
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.username
 * @returns {Promise<object>}
 * @throws {AppError} 404 if it does not exist OR is not theirs
 */
export async function getStudyPlan({ id, username }) {
  const userId = await requireUserId(username);

  const plan = await planRepository.findOwnedById(id, userId);
  if (!plan) throw notFoundPlan();

  const tasks = await planRepository.findTasksByPlanId(plan.id);
  return toApiShape(plan, tasks);
}

/**
 * Move one task to a new status (§28), and re-derive the plan's own (§29).
 *
 * Both checks — the plan belongs to this user, the task belongs to this plan —
 * are inside the repository's single UPDATE, so there is no window between
 * checking and writing and no way to satisfy one without the other.
 *
 * The plan status is recomputed afterwards rather than inferred here, because it
 * is a function of every task rather than of this one: completing the last
 * pending task completes the plan, and reopening any task reopens it.
 *
 * @param {object} input
 * @param {number} input.planId
 * @param {number} input.taskId
 * @param {string} input.username
 * @param {string} input.status already validated against the allowed set
 * @returns {Promise<object>} the updated task, plus the plan's derived status
 * @throws {AppError} 404 if the user, plan or task does not match
 */
export async function updateTaskStatus({ planId, taskId, username, status }) {
  const userId = await requireUserId(username);

  const task = await planRepository.updateTaskStatus({
    taskId,
    planId,
    userId,
    status,
  });

  // One 404 for four situations: no such plan, no such task, a task of a
  // different plan, a plan of a different user. Distinguishing them would tell
  // an unauthenticated caller which ids are real.
  if (!task) throw notFoundPlan();

  const plan = await planRepository.recomputePlanStatus(planId);

  return {
    task: toTaskShape(task),
    // `undefined` when the plan is cancelled or archived — recomputePlanStatus
    // deliberately does not touch those, so there is no new status to report and
    // the stored one has not changed.
    planStatus: plan?.status,
  };
}

/** Items returned by GET /api/study-plans. Shares the material list ceiling. */
const PLAN_LIST_LIMIT = config.limits.materialListItems;

/**
 * A plan row and its tasks in the API's vocabulary (§39).
 *
 * camelCase, matching the material endpoints and the shape §39 specifies, rather
 * than the snake_case of the older GET /api/history — an inconsistency that is
 * real, documented in docs/material-processing.md, and not worth breaking a live
 * contract to fix.
 *
 * Field by field rather than a spread of the row. `user_id` is on the row and
 * must not be in the response: it is an internal surrogate key that the client
 * has no use for and no business seeing, and a spread would ship it the moment
 * someone added a column.
 */
function toApiShape(plan, tasks) {
  return {
    ...toPlanFields(plan),
    tasks: tasks.map(toTaskShape),
  };
}

/** The same, plus counts and without tasks — the list shape (§26). */
function toSummaryShape(row) {
  return {
    ...toPlanFields(row),
    taskCount: row.total_tasks,
    completedTaskCount: row.completed_tasks,
    skippedTaskCount: row.skipped_tasks,
  };
}

function toPlanFields(plan) {
  return {
    id: plan.id,
    title: plan.title,
    subject: plan.subject,
    goal: plan.goal,
    // Plain `YYYY-MM-DD` strings, not timestamps — see src/config/pg-types.js.
    // A study day is a calendar day, and rendering one through a timezone is how
    // a plan's first task appears to fall on the day before it does.
    startDate: plan.start_date,
    endDate: plan.end_date,
    examDate: plan.exam_date,
    dailyMinutes: plan.daily_minutes,
    difficultyLevel: plan.difficulty_level,
    status: plan.status,
    topics: plan.topics,
    studyDays: plan.study_days,
    // The plan this one replaced, or null. The learner's own plan id, so it is
    // safe to return, and it is the only way a client can find the archived
    // original a regeneration superseded.
    parentPlanId: plan.parent_plan_id ?? null,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
  };
}

function toTaskShape(task) {
  return {
    id: task.id,
    scheduledDate: task.scheduled_date,
    position: task.position,
    title: task.title,
    description: task.description ?? null,
    topic: task.topic ?? null,
    taskType: task.task_type,
    durationMinutes: task.duration_minutes,
    status: task.status,
    // Null for most tasks, and that is the normal case rather than a gap — §7 is
    // explicit that not every task has a material. When it is set it is an id
    // the database confirmed belongs to this user.
    materialId: task.material_id ?? null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

/**
 * Resolve a username to a user id, or 404.
 *
 * Study-plan endpoints do not create users — §10 requires an existing one. That
 * differs from POST /api/ask and POST /api/materials, which upsert, and the
 * difference is deliberate: those endpoints are how a username comes into
 * existence, and a plan is built from a learner's materials and history rather
 * than being someone's first interaction with the service.
 */
async function requireUserId(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) throw notFoundPlan();
  return userId;
}

/**
 * The 404 every ownership failure produces.
 *
 * One message for five situations — no such user, no such plan, someone else's
 * plan, no such task, a task of another plan — because distinguishing them would
 * tell an unauthenticated caller which ids exist. 404 rather than 403 for the
 * reason src/utils/app-error.js records: a 403 confirms the resource is real.
 */
function notFoundPlan() {
  return notFound("Study plan not found.");
}
