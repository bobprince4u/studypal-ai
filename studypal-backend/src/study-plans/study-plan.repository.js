/**
 * Study plan and task persistence — the only module with SQL for these tables.
 *
 * Same rules as src/materials/material.repository.js, and for the same reasons:
 * every value is a bind parameter, no layer above this one writes SQL, and there
 * is no `findById(id)`. A plan is reachable only through a function that also
 * takes the owner, so §27's "do not allow access merely because the caller knows
 * the plan ID" is a property of this module's INTERFACE rather than a rule each
 * caller has to remember.
 *
 * A plan that does not exist and a plan belonging to someone else are
 * indistinguishable in the return value — both `undefined`. The service answers
 * 404 for both without knowing which happened, so the API never confirms that a
 * plan id is real.
 *
 * WHY TASKS NEVER RETURN user_id
 * ------------------------------
 * study_plan_tasks.user_id exists so the plan and material foreign keys can be
 * composite (see migrations/postgres/004_study_plans.sql). It is written once, on
 * insert, and no SELECT in this file reads it: every query reaches a task through
 * its plan. Treating it as a queryable owner column would make it a second source
 * of truth for ownership, and the value of having the database pin it is exactly
 * that there is only one.
 *
 * WHY GENERATION IS NOT IN HERE
 * -----------------------------
 * No function below calls Gemini, and none may. §25 requires that the model is
 * called BEFORE a transaction opens — a provider round trip inside `BEGIN` holds
 * a connection and its locks for however long the provider takes, which on a slow
 * generation is tens of seconds. `insertPlanWithTasks` therefore receives a
 * finished, validated, normalized plan and does nothing but write it.
 */

import { query, withTransaction } from "../config/database.js";

/**
 * Plan columns the API layer may see — which is all of them.
 *
 * Unlike materials, this table holds no equivalent of `storage_key`: every
 * column here is either the learner's own input or something computed from it,
 * and `material_ids` contains ids the caller supplied in the first place. The
 * list is still written out rather than `SELECT *`, so that a future ALTER TABLE
 * cannot quietly start feeding a new column into an API payload.
 */
const PLAN_COLUMNS = `
  id, user_id, title, subject, goal,
  start_date, end_date, exam_date,
  daily_minutes, difficulty_level, status,
  topics, study_days, material_ids, parent_plan_id,
  created_at, updated_at
`;

/** The same columns qualified for the aliased `study_plans p` in findByUserId. */
const PLAN_COLUMNS_QUALIFIED = `
  p.id, p.user_id, p.title, p.subject, p.goal,
  p.start_date, p.end_date, p.exam_date,
  p.daily_minutes, p.difficulty_level, p.status,
  p.topics, p.study_days, p.material_ids, p.parent_plan_id,
  p.created_at, p.updated_at
`;

/** Task columns, deliberately without user_id. See the header. */
const TASK_COLUMNS = `
  id, study_plan_id, scheduled_date, position,
  title, description, topic, task_type,
  duration_minutes, status, material_id,
  created_at, updated_at
`;

/** The same, qualified for an aliased `study_plan_tasks t`. */
const TASK_COLUMNS_QUALIFIED = `
  t.id, t.study_plan_id, t.scheduled_date, t.position,
  t.title, t.description, t.topic, t.task_type,
  t.duration_minutes, t.status, t.material_id,
  t.created_at, t.updated_at
`;

/**
 * Write a plan and all of its tasks, atomically (§25).
 *
 * ONE transaction, and it is the whole point. A plan row without its tasks is
 * not a degraded plan, it is a lie: the API would return a schedule with nothing
 * in it and no indication that anything went wrong. Either both happen or
 * neither, and the caller sees an error rather than a half-plan.
 *
 * WHAT ELSE HAPPENS IN HERE, AND WHY IT IS NOT THE CALLER'S JOB
 * ------------------------------------------------------------
 * When `plan.parentPlanId` is set this is a regeneration, and the plan being
 * replaced is archived inside the same transaction. Putting that here rather
 * than in the service is what makes the invariant hold: `parent_plan_id` is set
 * if and only if the parent was superseded, with no window in which the original
 * has been archived but the replacement failed to insert — which would leave the
 * learner with no active plan and no error explaining where it went.
 *
 * The archive is a compare-and-set on `status = 'active'`, so regenerating from
 * a plan the learner already completed or cancelled records the lineage without
 * rewriting the parent's outcome. A plan that finished is a fact; a newer plan
 * existing does not unmake it.
 *
 * Empty `tasks` is rejected rather than committed. §19 requires that an empty
 * task list is not persisted, the validator refuses one earlier with a proper
 * message, and this is the backstop that makes the invariant unviolatable
 * through this function — the same arrangement as saveChunksAndMarkReady.
 *
 * @param {object} input
 * @param {object} input.plan validated and normalized; see the destructuring
 * @param {Array<object>} input.tasks non-empty, already ordered and dated
 * @returns {Promise<{plan: object, tasks: Array<object>}>}
 */
export async function insertPlanWithTasks({ plan, tasks }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Refusing to persist a study plan with no tasks");
  }

  return withTransaction(async (client) => {
    const { rows: planRows } = await client.query(
      `INSERT INTO study_plans
              (user_id, title, subject, goal,
               start_date, end_date, exam_date,
               daily_minutes, difficulty_level,
               topics, study_days, material_ids, parent_plan_id)
       VALUES ($1, $2, $3, $4,
               $5, $6, $7,
               $8, $9,
               $10::text[], $11::text[], $12::bigint[], $13)
       RETURNING ${PLAN_COLUMNS}`,
      [
        plan.userId,
        plan.title,
        plan.subject,
        plan.goal,
        plan.startDate,
        plan.endDate,
        plan.examDate,
        plan.dailyMinutes,
        plan.difficultyLevel,
        plan.topics,
        plan.studyDays,
        plan.materialIds,
        plan.parentPlanId ?? null,
      ],
    );

    const created = planRows[0];

    // Eight parallel arrays expanded by unnest, so the statement has a FIXED ten
    // placeholders regardless of task count — the same reasoning as the chunk
    // insert in material.repository.js. The casts are required: pg sends a JS
    // array as an untyped array literal, and unnest must be told the element
    // type. `::date[]` in particular is what keeps the strings this layer
    // receives as 'YYYY-MM-DD' from being interpreted as anything else.
    const { rows: taskRows } = await client.query(
      `INSERT INTO study_plan_tasks
              (study_plan_id, user_id, scheduled_date, position,
               title, description, topic, task_type,
               duration_minutes, material_id)
       SELECT $1, $2,
              task.scheduled_date, task.position,
              task.title, task.description, task.topic, task.task_type,
              task.duration_minutes, task.material_id
         FROM unnest(
                $3::date[], $4::int[],
                $5::text[], $6::text[], $7::text[], $8::text[],
                $9::int[], $10::bigint[]
              ) AS task(scheduled_date, position,
                        title, description, topic, task_type,
                        duration_minutes, material_id)
       RETURNING ${TASK_COLUMNS}`,
      [
        created.id,
        plan.userId,
        tasks.map((task) => task.scheduledDate),
        tasks.map((task) => task.position),
        tasks.map((task) => task.title),
        // `?? null` rather than leaving undefined: pg encodes both as NULL, but
        // saying so keeps "this task has no description" a deliberate value
        // rather than an omission a reader has to infer.
        tasks.map((task) => task.description ?? null),
        tasks.map((task) => task.topic ?? null),
        tasks.map((task) => task.taskType),
        tasks.map((task) => task.durationMinutes),
        tasks.map((task) => task.materialId ?? null),
      ],
    );

    if (plan.parentPlanId) {
      await client.query(
        `UPDATE study_plans
            SET status = 'archived', updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [plan.parentPlanId, plan.userId],
      );
    }

    // RETURNING follows the INSERT's own order, which is the order of the
    // arrays, which is the order the normalizer produced. Sorted anyway so that
    // this function's contract is the sort order rather than a PostgreSQL
    // implementation detail that happens to agree with it today.
    taskRows.sort(compareTasks);

    return { plan: created, tasks: taskRows };
  });
}

/**
 * A user's plans, newest first, with per-plan task counts.
 *
 * §26: metadata, not full task lists. The counts are what make the list useful
 * without them — a caller can render "12 of 30 done" without fetching 30 rows
 * per plan, which is the N+1 §51 forbids.
 *
 * LEFT JOIN LATERAL for the same reason findByUserId does it in
 * material.repository.js: one aggregate per plan, using the leading column of
 * study_plan_tasks_slot_key, returning exactly one row per plan. A plain
 * LEFT JOIN with GROUP BY would have to group by all seventeen selected columns.
 *
 * `completed` and `skipped` are counted separately rather than summed into one
 * "done" figure. They are both terminal and both count towards plan completion,
 * but a learner who skipped half their plan and a learner who finished it are
 * not in the same position, and collapsing that here would make the difference
 * unrecoverable without a second query.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
export async function findByUserId(userId, limit) {
  const { rows } = await query(
    `SELECT ${PLAN_COLUMNS_QUALIFIED},
            counts.total_tasks,
            counts.completed_tasks,
            counts.skipped_tasks
       FROM study_plans p
       LEFT JOIN LATERAL (
              SELECT COUNT(*) AS total_tasks,
                     COUNT(*) FILTER (WHERE t.status = 'completed')
                       AS completed_tasks,
                     COUNT(*) FILTER (WHERE t.status = 'skipped')
                       AS skipped_tasks
                FROM study_plan_tasks t
               WHERE t.study_plan_id = p.id
            ) counts ON TRUE
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * One plan, only if it belongs to this user.
 *
 * The function every ownership check goes through, including the one behind
 * PATCH and the one behind regeneration. There is no id-only variant.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<object | undefined>} undefined if absent OR not theirs
 */
export async function findOwnedById(id, userId) {
  const { rows } = await query(
    `SELECT ${PLAN_COLUMNS}
       FROM study_plans
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0];
}

/**
 * A plan's tasks, in schedule order.
 *
 * Takes no userId, and that is safe rather than sloppy: there is no way to reach
 * this function without a plan id, and the only way to obtain one is
 * findOwnedById, which already applied the owner. Adding a redundant userId here
 * would suggest the check had not happened yet, which is the more dangerous
 * shape — a caller might then believe passing it was sufficient.
 *
 * ORDER BY matches study_plan_tasks_slot_key exactly, so this reads straight off
 * the index with no sort step.
 *
 * @param {number} planId
 * @returns {Promise<Array<object>>}
 */
export async function findTasksByPlanId(planId) {
  const { rows } = await query(
    `SELECT ${TASK_COLUMNS}
       FROM study_plan_tasks
      WHERE study_plan_id = $1
      ORDER BY scheduled_date ASC, position ASC`,
    [planId],
  );
  return rows;
}

/**
 * Move one task to a new status — but only a task of that plan, and only a plan
 * of that user (§28).
 *
 * ALL THREE CONDITIONS ARE IN THE ONE STATEMENT, which is what makes this safe
 * under concurrency and impossible to half-apply. A read-then-write would leave
 * a window in which the plan changed hands, and more practically it would leave
 * three separate failure branches for a caller to get right; here a task that is
 * not the caller's, or belongs to a different plan than the URL claims, simply
 * updates no rows and returns `undefined`. The caller answers 404 for all of
 * them, revealing nothing about which id was real.
 *
 * The EXISTS subquery correlates on `t.study_plan_id` rather than repeating $2,
 * so the plan whose owner is checked is provably the task's own plan and not
 * merely a plan with a matching id.
 *
 * @param {object} input
 * @param {number} input.taskId
 * @param {number} input.planId
 * @param {number} input.userId
 * @param {string} input.status already validated against the allowed set
 * @returns {Promise<object | undefined>} the updated task, or undefined
 */
export async function updateTaskStatus({ taskId, planId, userId, status }) {
  const { rows } = await query(
    `UPDATE study_plan_tasks t
        SET status = $4, updated_at = now()
      WHERE t.id = $1
        AND t.study_plan_id = $2
        AND EXISTS (
              SELECT 1 FROM study_plans p
               WHERE p.id = t.study_plan_id AND p.user_id = $3
            )
      RETURNING ${TASK_COLUMNS_QUALIFIED}`,
    [taskId, planId, userId, status],
  );
  return rows[0];
}

/**
 * Recompute a plan's status from its tasks (§29).
 *
 * DERIVED, NEVER SET BY A CLIENT. A plan is `completed` when no task is still
 * pending or in progress, and `active` otherwise — so completing the last task
 * completes the plan, and reopening a task reopens it. Both directions matter:
 * a one-way transition would leave a plan marked complete with work in it the
 * moment a learner corrected a mis-tap.
 *
 * `cancelled` and `archived` are LEFT ALONE by the WHERE clause. They are
 * decisions about the plan rather than summaries of its tasks, and a status
 * derived from task state must not be able to resurrect a plan the learner
 * abandoned or a plan that a regeneration superseded.
 *
 * One statement, so the read of the tasks and the write of the status cannot
 * interleave with another task update.
 *
 * @param {number} planId
 * @returns {Promise<object | undefined>} the plan, or undefined if it was
 *   cancelled/archived and therefore not eligible
 */
export async function recomputePlanStatus(planId) {
  const { rows } = await query(
    `UPDATE study_plans p
        SET status = CASE
              WHEN NOT EXISTS (
                     SELECT 1 FROM study_plan_tasks t
                      WHERE t.study_plan_id = p.id
                        AND t.status IN ('pending', 'in_progress')
                   )
              THEN 'completed'
              ELSE 'active'
            END,
            updated_at = now()
      WHERE p.id = $1
        AND p.status IN ('active', 'completed')
      RETURNING ${PLAN_COLUMNS}`,
    [planId],
  );
  return rows[0];
}

/** Schedule order: by date, then by position within the day. */
function compareTasks(a, b) {
  if (a.scheduled_date !== b.scheduled_date) {
    return a.scheduled_date < b.scheduled_date ? -1 : 1;
  }
  return a.position - b.position;
}
