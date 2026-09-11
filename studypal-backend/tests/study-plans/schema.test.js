/**
 * Study-plan schema tests — SP-V2-005 §40's "Database" group.
 *
 * The same approach as tests/materials/schema.test.js, one migration later: go
 * through SQL directly, and assert that the DATABASE refuses a bad row rather
 * than that the application avoids writing one. Every CHECK and foreign key in
 * migrations/postgres/004_study_plans.sql is a rule that has to hold even if a
 * future code path forgets it, and the only way to demonstrate that is to try
 * the write.
 *
 * Constraint NAMES are matched rather than message text, so renaming a
 * constraint fails here and a reworded PostgreSQL error does not.
 *
 * THE TWO CONSTRAINTS WORTH READING FIRST
 * ---------------------------------------
 * Most of what follows is ordinary bounds checking. Two are the reason this file
 * exists:
 *
 *   study_plan_tasks_material_fkey — a COMPOSITE key against
 *   `materials (id, user_id)`. It is what makes §8's "an optional material must
 *   belong to the same user" a property of the database rather than a check the
 *   application performs. The test below writes a task pointing at another
 *   user's material through raw SQL, bypassing every service, and the write
 *   still fails.
 *
 *   study_plan_tasks_plan_fkey — composite for the same reason, so a task's
 *   `user_id` cannot disagree with its plan's.
 *
 *   node --test tests/study-plans/schema.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createIsolatedDatabase } from "../helpers/test-database.mjs";

const { Pool } = pg;

let database;
let pool;

before(async () => {
  database = await createIsolatedDatabase({ label: "planschema" });
  pool = new Pool({ connectionString: database.url, max: 4 });
});

after(async () => {
  await pool?.end();
  await database?.drop();
});

let userSequence = 0;

/** A fresh user, since almost every row below needs an owner. */
async function createUser() {
  const { rows } = await pool.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [`planschema_${(userSequence += 1)}`],
  );
  return rows[0].id;
}

/** A material owned by `userId`, for the composite-FK tests. */
let keySequence = 0;
async function createMaterial(userId) {
  // Flat, no slashes: materials_storage_key_safe requires a single safe path
  // segment, which is what stops a key escaping the storage root.
  const key = `plan-${userId}-${(keySequence += 1)}.pdf`;
  const { rows } = await pool.query(
    `INSERT INTO materials
       (user_id, original_filename, storage_key, mime_type, file_size)
     VALUES ($1, 'notes.pdf', $2, 'application/pdf', 1024)
     RETURNING id`,
    [userId, key],
  );
  return rows[0].id;
}

/**
 * Insert a plan, with every column defaulted to something valid.
 *
 * Overrides are merged in, so each test states only the field it is about —
 * which keeps the assertion and the reason for it on the same screen.
 */
async function insertPlan(userId, overrides = {}) {
  const plan = {
    title: "Biology revision",
    subject: "Biology",
    goal: "Understand photosynthesis and respiration before the exam.",
    start_date: "2026-10-01",
    end_date: "2026-10-20",
    exam_date: "2026-10-21",
    daily_minutes: 60,
    difficulty_level: "beginner",
    topics: ["Photosynthesis"],
    study_days: ["monday", "wednesday"],
    material_ids: [],
    parent_plan_id: null,
    ...overrides,
  };

  const { rows } = await pool.query(
    `INSERT INTO study_plans
       (user_id, title, subject, goal, start_date, end_date, exam_date,
        daily_minutes, difficulty_level, topics, study_days, material_ids,
        parent_plan_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[],
             $12::bigint[], $13)
     RETURNING *`,
    [
      userId,
      plan.title,
      plan.subject,
      plan.goal,
      plan.start_date,
      plan.end_date,
      plan.exam_date,
      plan.daily_minutes,
      plan.difficulty_level,
      plan.topics,
      plan.study_days,
      plan.material_ids,
      plan.parent_plan_id,
    ],
  );
  return rows[0];
}

async function insertTask(planId, userId, overrides = {}) {
  const task = {
    scheduled_date: "2026-10-05",
    position: 0,
    title: "Read chapter 4",
    description: null,
    topic: null,
    task_type: "study",
    duration_minutes: 30,
    material_id: null,
    ...overrides,
  };

  const { rows } = await pool.query(
    `INSERT INTO study_plan_tasks
       (study_plan_id, user_id, scheduled_date, position, title, description,
        topic, task_type, duration_minutes, material_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      planId,
      userId,
      task.scheduled_date,
      task.position,
      task.title,
      task.description,
      task.topic,
      task.task_type,
      task.duration_minutes,
      task.material_id,
    ],
  );
  return rows[0];
}

/** Assert a write fails, and fails for the named constraint. */
async function assertViolates(constraint, fn) {
  await assert.rejects(
    fn,
    (err) => {
      assert.equal(
        err.constraint,
        constraint,
        `expected ${constraint}, got ${err.constraint ?? err.code}`,
      );
      return true;
    },
    `expected a violation of ${constraint}`,
  );
}

describe("the migration creates the study-plan tables", () => {
  it("creates study_plans with every documented column and type", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'study_plans'
        ORDER BY ordinal_position`,
    );

    assert.deepEqual(
      rows.map((r) => [r.column_name, r.data_type, r.is_nullable]),
      [
        ["id", "bigint", "NO"],
        ["user_id", "bigint", "NO"],
        ["title", "text", "NO"],
        ["subject", "text", "NO"],
        ["goal", "text", "NO"],
        ["start_date", "date", "NO"],
        ["end_date", "date", "NO"],
        ["exam_date", "date", "NO"],
        ["daily_minutes", "integer", "NO"],
        ["difficulty_level", "text", "NO"],
        ["status", "text", "NO"],
        ["topics", "ARRAY", "NO"],
        ["study_days", "ARRAY", "NO"],
        ["material_ids", "ARRAY", "NO"],
        ["parent_plan_id", "bigint", "YES"],
        ["created_at", "timestamp with time zone", "NO"],
        ["updated_at", "timestamp with time zone", "NO"],
      ],
    );
  });

  it("creates study_plan_tasks with every documented column and type", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'study_plan_tasks'
        ORDER BY ordinal_position`,
    );

    assert.deepEqual(
      rows.map((r) => [r.column_name, r.data_type, r.is_nullable]),
      [
        ["id", "bigint", "NO"],
        ["study_plan_id", "bigint", "NO"],
        // Denormalised, and NOT NULL, because it is half of both composite
        // foreign keys. See the migration's comment: application code does not
        // read it.
        ["user_id", "bigint", "NO"],
        ["scheduled_date", "date", "NO"],
        ["position", "integer", "NO"],
        ["title", "text", "NO"],
        ["description", "text", "YES"],
        ["topic", "text", "YES"],
        ["task_type", "text", "NO"],
        ["duration_minutes", "integer", "NO"],
        ["status", "text", "NO"],
        ["material_id", "bigint", "YES"],
        ["created_at", "timestamp with time zone", "NO"],
        ["updated_at", "timestamp with time zone", "NO"],
      ],
    );
  });

  it("refuses client-supplied ids on both tables (GENERATED ALWAYS)", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);

    await assert.rejects(
      pool.query(
        `INSERT INTO study_plans
           (id, user_id, title, subject, goal, start_date, end_date, exam_date,
            daily_minutes, difficulty_level, study_days)
         VALUES (999, $1, 't', 's', 'g', '2026-10-01', '2026-10-02',
                 '2026-10-03', 60, 'beginner', ARRAY['monday'])`,
        [userId],
      ),
      /non-DEFAULT value into column "id"/,
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO study_plan_tasks
           (id, study_plan_id, user_id, scheduled_date, position, title,
            task_type, duration_minutes)
         VALUES (999, $1, $2, '2026-10-05', 0, 't', 'study', 30)`,
        [plan.id, userId],
      ),
      /non-DEFAULT value into column "id"/,
    );
  });

  it("defaults status and the timestamps", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    const task = await insertTask(plan.id, userId);

    assert.equal(plan.status, "active");
    assert.equal(task.status, "pending");
    // ISO strings, not Date objects — src/config/pg-types.js parses TIMESTAMPTZ
    // to a string so a timestamp survives JSON serialisation unchanged.
    assert.match(plan.created_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.match(task.updated_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("returns DATE columns as plain YYYY-MM-DD strings", async () => {
    // The type parser registered in src/config/pg-types.js, asserted here
    // because it is invisible until a timezone west of UTC turns 2026-10-01 into
    // 2026-09-30T23:00:00Z. A string cannot be shifted by a timezone.
    const userId = await createUser();
    const plan = await insertPlan(userId, { start_date: "2026-10-01" });

    assert.equal(plan.start_date, "2026-10-01");
    assert.equal(typeof plan.start_date, "string");
  });
});

describe("study_plans CHECK constraints", () => {
  it("rejects a status outside the lifecycle", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await assertViolates("study_plans_status_valid", () =>
      pool.query("UPDATE study_plans SET status = 'paused' WHERE id = $1", [
        plan.id,
      ]),
    );
  });

  it("accepts each of the four lifecycle states", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);

    for (const status of ["active", "completed", "cancelled", "archived"]) {
      await pool.query("UPDATE study_plans SET status = $1 WHERE id = $2", [
        status,
        plan.id,
      ]);
    }
  });

  it("rejects a difficulty level outside the three offered", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_difficulty_valid", () =>
      insertPlan(userId, { difficulty_level: "expert" }),
    );
  });

  it("rejects a blank or whitespace-only title, subject and goal", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_title_not_blank", () =>
      insertPlan(userId, { title: "   \t\n " }),
    );
    await assertViolates("study_plans_subject_not_blank", () =>
      insertPlan(userId, { subject: "" }),
    );
    await assertViolates("study_plans_goal_not_blank", () =>
      insertPlan(userId, { goal: " " }),
    );
  });

  it("bounds the title, subject and goal", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_title_bounded", () =>
      insertPlan(userId, { title: "T".repeat(201) }),
    );
    await assertViolates("study_plans_subject_bounded", () =>
      insertPlan(userId, { subject: "S".repeat(201) }),
    );
    await assertViolates("study_plans_goal_bounded", () =>
      insertPlan(userId, { goal: "G".repeat(2001) }),
    );
  });

  it("rejects a zero, negative or absurd daily budget", async () => {
    // §10's three named inputs, at the database boundary rather than the HTTP
    // one: -100 and 0 fail positivity, 999999 fails the ceiling.
    const userId = await createUser();
    await assertViolates("study_plans_daily_minutes_positive", () =>
      insertPlan(userId, { daily_minutes: 0 }),
    );
    await assertViolates("study_plans_daily_minutes_positive", () =>
      insertPlan(userId, { daily_minutes: -100 }),
    );
    await assertViolates("study_plans_daily_minutes_bounded", () =>
      insertPlan(userId, { daily_minutes: 999999 }),
    );
  });

  it("rejects a plan that ends before it starts", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_dates_ordered", () =>
      insertPlan(userId, { start_date: "2026-10-20", end_date: "2026-10-01" }),
    );
  });

  it("rejects a plan that runs past its exam date", async () => {
    // §12. A task after the exam is worthless, so the window is closed in the
    // schema rather than only in the scheduler.
    const userId = await createUser();
    await assertViolates("study_plans_ends_by_exam", () =>
      insertPlan(userId, { end_date: "2026-10-22", exam_date: "2026-10-21" }),
    );
  });

  it("accepts a single-day plan, because cramming is a real request", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId, {
      start_date: "2026-10-21",
      end_date: "2026-10-21",
      exam_date: "2026-10-21",
    });
    assert.equal(plan.start_date, plan.end_date);
  });

  it("rejects an empty study_days array and a non-weekday", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_study_days_valid", () =>
      insertPlan(userId, { study_days: [] }),
    );
    await assertViolates("study_plans_study_days_valid", () =>
      insertPlan(userId, { study_days: ["someday"] }),
    );
  });

  it("accepts all seven weekdays", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId, {
      study_days: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
    });
    assert.equal(plan.study_days.length, 7);
  });

  it("bounds topics and material_ids", async () => {
    const userId = await createUser();
    await assertViolates("study_plans_topics_bounded", () =>
      insertPlan(userId, {
        topics: Array.from({ length: 101 }, (_, i) => `topic ${i}`),
      }),
    );
    await assertViolates("study_plans_material_ids_bounded", () =>
      insertPlan(userId, {
        material_ids: Array.from({ length: 101 }, (_, i) => i + 1),
      }),
    );
  });

  it("rejects a plan that is its own parent", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await assertViolates("study_plans_parent_not_self", () =>
      pool.query("UPDATE study_plans SET parent_plan_id = id WHERE id = $1", [
        plan.id,
      ]),
    );
  });
});

describe("study_plan_tasks CHECK constraints", () => {
  it("rejects a task type outside the four allowed", async () => {
    // §7: "keep small; no exam tasks". `exam` is the value most likely to be
    // added by accident, so it is the one tried here.
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await assertViolates("study_plan_tasks_type_valid", () =>
      insertTask(plan.id, userId, { task_type: "exam" }),
    );
  });

  it("accepts each of the four task types", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    let position = 0;
    for (const taskType of ["study", "review", "practice", "recap"]) {
      await insertTask(plan.id, userId, { task_type: taskType, position: position++ });
    }
  });

  it("accepts each of the four task statuses and rejects others", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    const task = await insertTask(plan.id, userId);

    for (const status of ["pending", "in_progress", "completed", "skipped"]) {
      await pool.query("UPDATE study_plan_tasks SET status = $1 WHERE id = $2", [
        status,
        task.id,
      ]);
    }

    await assertViolates("study_plan_tasks_status_valid", () =>
      pool.query("UPDATE study_plan_tasks SET status = 'done' WHERE id = $1", [
        task.id,
      ]),
    );
  });

  it("rejects a zero or negative duration and bounds it at a day", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await assertViolates("study_plan_tasks_duration_positive", () =>
      insertTask(plan.id, userId, { duration_minutes: 0 }),
    );
    await assertViolates("study_plan_tasks_duration_positive", () =>
      insertTask(plan.id, userId, { duration_minutes: -30 }),
    );
    await assertViolates("study_plan_tasks_duration_bounded", () =>
      insertTask(plan.id, userId, { duration_minutes: 1441 }),
    );
  });

  it("accepts position 0 but not a negative one", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    const task = await insertTask(plan.id, userId, { position: 0 });
    assert.equal(task.position, 0);

    await assertViolates("study_plan_tasks_position_non_negative", () =>
      insertTask(plan.id, userId, { position: -1, scheduled_date: "2026-10-06" }),
    );
  });

  it("rejects a blank title and bounds the text columns", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await assertViolates("study_plan_tasks_title_not_blank", () =>
      insertTask(plan.id, userId, { title: "  " }),
    );
    await assertViolates("study_plan_tasks_title_bounded", () =>
      insertTask(plan.id, userId, { title: "T".repeat(201) }),
    );
    await assertViolates("study_plan_tasks_description_bounded", () =>
      insertTask(plan.id, userId, { description: "D".repeat(2001) }),
    );
    await assertViolates("study_plan_tasks_topic_bounded", () =>
      insertTask(plan.id, userId, { topic: "P".repeat(201) }),
    );
  });

  it("rejects two tasks in the same slot on the same day", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await insertTask(plan.id, userId, { scheduled_date: "2026-10-05", position: 0 });

    await assertViolates("study_plan_tasks_slot_key", () =>
      insertTask(plan.id, userId, { scheduled_date: "2026-10-05", position: 0 }),
    );

    // The same position on a different date is fine — position is within a day.
    await insertTask(plan.id, userId, { scheduled_date: "2026-10-07", position: 0 });
  });

  it("allows a task with no material, because most tasks have none", async () => {
    // §7: "Do not require every task to have a material."
    const userId = await createUser();
    const plan = await insertPlan(userId);
    const task = await insertTask(plan.id, userId, { material_id: null });
    assert.equal(task.material_id, null);
  });
});

describe("ownership is enforced by the database, not by application code", () => {
  it("refuses a task pointing at another user's material", async () => {
    // §8, and the reason materials carries `UNIQUE (id, user_id)`. This write
    // goes through raw SQL with no service in the way: if the composite foreign
    // key were a plain `REFERENCES materials (id)`, it would succeed.
    const alice = await createUser();
    const bob = await createUser();
    const bobsMaterial = await createMaterial(bob);
    const alicesPlan = await insertPlan(alice);

    await assertViolates("study_plan_tasks_material_fkey", () =>
      insertTask(alicesPlan.id, alice, { material_id: bobsMaterial }),
    );
  });

  it("accepts a task pointing at the owner's own material", async () => {
    const alice = await createUser();
    const alicesMaterial = await createMaterial(alice);
    const alicesPlan = await insertPlan(alice);

    const task = await insertTask(alicesPlan.id, alice, {
      material_id: alicesMaterial,
    });
    assert.equal(task.material_id, alicesMaterial);
  });

  it("refuses a task whose user_id disagrees with its plan's", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const alicesPlan = await insertPlan(alice);

    await assertViolates("study_plan_tasks_plan_fkey", () =>
      insertTask(alicesPlan.id, bob),
    );
  });

  it("nulls a task's material when the material is deleted, keeping the task", async () => {
    // ON DELETE SET NULL (material_id) — the PG15+ column list. Deleting a
    // material must not delete the study task that referenced it: the learner
    // still has to study the topic, they just no longer have that document.
    const userId = await createUser();
    const materialId = await createMaterial(userId);
    const plan = await insertPlan(userId);
    const task = await insertTask(plan.id, userId, { material_id: materialId });

    await pool.query("DELETE FROM materials WHERE id = $1", [materialId]);

    const { rows } = await pool.query(
      "SELECT user_id, material_id FROM study_plan_tasks WHERE id = $1",
      [task.id],
    );
    assert.equal(rows.length, 1, "the task survives its material");
    assert.equal(rows[0].material_id, null);
    // The other half of the composite key must be untouched, or the task would
    // have been orphaned from its plan too.
    assert.equal(rows[0].user_id, userId);
  });

  it("deletes a plan's tasks with the plan, and a user's plans with the user", async () => {
    const userId = await createUser();
    const plan = await insertPlan(userId);
    await insertTask(plan.id, userId);

    await pool.query("DELETE FROM study_plans WHERE id = $1", [plan.id]);
    const afterPlan = await pool.query(
      "SELECT 1 FROM study_plan_tasks WHERE study_plan_id = $1",
      [plan.id],
    );
    assert.equal(afterPlan.rows.length, 0);

    const second = await insertPlan(userId);
    await insertTask(second.id, userId);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    const afterUser = await pool.query(
      "SELECT 1 FROM study_plans WHERE user_id = $1",
      [userId],
    );
    assert.equal(afterUser.rows.length, 0);
  });

  it("keeps a regenerated plan when its parent is deleted", async () => {
    // ON DELETE SET NULL on parent_plan_id. A plan is not a child of its
    // predecessor in any meaningful sense — it is a successor — so losing the
    // original must not take the plan the learner is actually using.
    const userId = await createUser();
    const original = await insertPlan(userId);
    const successor = await insertPlan(userId, { parent_plan_id: original.id });

    await pool.query("DELETE FROM study_plans WHERE id = $1", [original.id]);

    const { rows } = await pool.query(
      "SELECT parent_plan_id FROM study_plans WHERE id = $1",
      [successor.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].parent_plan_id, null);
  });
});

describe("indexes", () => {
  it("has exactly the documented indexes on study_plans", async () => {
    // Exact, matching the rule the earlier migrations set: every index must
    // serve a query that exists today, so adding one breaks this test and
    // prompts the justification comment in the migration.
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'study_plans'
        ORDER BY indexname`,
    );
    assert.deepEqual(rows.map((r) => r.indexname), [
      "idx_study_plans_user_created",
      "study_plans_id_user_key",
      "study_plans_pkey",
    ]);
  });

  it("has exactly the documented indexes on study_plan_tasks", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'study_plan_tasks'
        ORDER BY indexname`,
    );
    // No index on study_plan_id alone: the UNIQUE slot key leads with it, and
    // PostgreSQL uses a composite index's leading column.
    assert.deepEqual(rows.map((r) => r.indexname), [
      "idx_study_plan_tasks_material",
      "study_plan_tasks_pkey",
      "study_plan_tasks_slot_key",
    ]);
  });

  it("uses the composite index for the list query at realistic scale", async () => {
    // Asserting the PLAN rather than the index's existence: an index PostgreSQL
    // declines to use is the same as no index. Scale matters — on 50 rows a
    // sequential scan IS cheaper and the planner is right to pick it.
    const userId = await createUser();
    await pool.query(
      `INSERT INTO study_plans
         (user_id, title, subject, goal, start_date, end_date, exam_date,
          daily_minutes, difficulty_level, study_days)
       SELECT $1, 'plan ' || g, 'Biology', 'goal', '2026-10-01', '2026-10-20',
              '2026-10-21', 60, 'beginner', ARRAY['monday']
         FROM generate_series(1, 400) AS g`,
      [userId],
    );
    await pool.query("ANALYZE study_plans");

    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM study_plans WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 20`,
      [userId],
    );
    const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
    assert.match(plan, /idx_study_plans_user_created/);
  });

  it("uses the slot index to read a plan's tasks in schedule order", async () => {
    // The distribution matters as much as the volume. An earlier version of this
    // test put all 400 tasks under ONE plan, and the planner correctly chose a
    // sequential scan — when every row matches the filter, an index is pure
    // overhead. Spreading the tasks over 40 plans makes one plan's tasks 2.5% of
    // the table, which is what the query actually faces in production.
    const userId = await createUser();
    const plans = [];
    for (let i = 0; i < 40; i += 1) plans.push(await insertPlan(userId));

    for (const plan of plans) {
      await pool.query(
        `INSERT INTO study_plan_tasks
           (study_plan_id, user_id, scheduled_date, position, title, task_type,
            duration_minutes)
         SELECT $1, $2, DATE '2026-10-01' + g, 0, 'task ' || g, 'study', 30
           FROM generate_series(1, 20) AS g`,
        [plan.id, userId],
      );
    }
    await pool.query("ANALYZE study_plan_tasks");

    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM study_plan_tasks WHERE study_plan_id = $1
        ORDER BY scheduled_date ASC, position ASC`,
      [plans[0].id],
    );
    const queryPlan = JSON.stringify(rows[0]["QUERY PLAN"]);
    assert.match(queryPlan, /study_plan_tasks_slot_key/);
    // The index is used; the ACCESS METHOD is the planner's business. At this
    // size it picks a bitmap scan, which does not preserve index order, so it
    // adds a Sort on top — and for 20 rows that is genuinely cheaper than the
    // random I/O of an ordered index scan. An earlier version of this test also
    // asserted the absence of a Sort node, which was an over-claim: it would
    // have failed on a correct plan, and it tested the planner's cost model
    // rather than this migration's index.
  });
});
