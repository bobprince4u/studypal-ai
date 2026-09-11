/**
 * The study-plan HTTP API — SP-V2-005 §26-§31, §39, and §40's "Input
 * validation", "Ownership", "Task status" and "Plan status" groups.
 *
 * Black box. A real server in a child process, a real PostgreSQL database, a
 * fake provider at the network boundary — nothing in this file imports from
 * src/. What it asserts is what a client would observe, which is the only level
 * at which §39's response contract and §27's ownership rule mean anything.
 *
 * THE TWO CLAIMS THIS FILE IS REALLY ABOUT
 * ----------------------------------------
 * KNOWING A PLAN ID IS NOT AUTHORISATION (§27). Every read and write below is
 * tried twice: once by the learner who owns the plan and once by a second,
 * equally real learner who does not. The second must get 404 — not 403, which
 * would confirm the id exists — and must get the identical body, so the two
 * cases stay indistinguishable from outside.
 *
 * PLAN STATUS IS DERIVED, NEVER ASSERTED BY A CLIENT (§29). No endpoint accepts
 * a plan status. It is recomputed from the tasks on every task update, in both
 * directions: finishing the last task completes the plan, and reopening one
 * reopens it. A one-way transition would leave a plan marked complete with work
 * still in it the moment a learner corrected a mis-tap.
 *
 * The AI-output matrix (FAKE_PLAN_MODE) lives in
 * tests/study-plans/generation.test.js, because each mode needs its own server
 * process; this suite runs entirely on the default "valid" mode.
 *
 *   node --test tests/study-plans/api.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";
import { CANNED_PLAN_TITLE } from "../helpers/fake-gemini.mjs";

/** The exact key set of a plan in a response body (§39, plus what we add). */
const PLAN_KEYS = [
  "createdAt",
  "dailyMinutes",
  "difficultyLevel",
  "endDate",
  "examDate",
  "goal",
  "id",
  "parentPlanId",
  "startDate",
  "status",
  "studyDays",
  "subject",
  "tasks",
  "title",
  "topics",
  "updatedAt",
];

/** The list shape: the same, without tasks, plus the three counts (§26). */
const SUMMARY_KEYS = [
  ...PLAN_KEYS.filter((key) => key !== "tasks"),
  "completedTaskCount",
  "skippedTaskCount",
  "taskCount",
].sort();

const TASK_KEYS = [
  "createdAt",
  "description",
  "durationMinutes",
  "id",
  "materialId",
  "position",
  "scheduledDate",
  "status",
  "taskType",
  "title",
  "topic",
  "updatedAt",
];

const ALL_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

let server;
let pool;

before(async () => {
  server = await startServer({ label: "plan-api" });
  pool = new pg.Pool({ connectionString: server.databaseUrl, max: 4 });
});

after(async () => {
  await pool?.end();
  await server?.stop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Create a user row directly.
 *
 * Study-plan endpoints deliberately do NOT upsert users — see requireUserId in
 * src/study-plans/study-plan.service.js. Going through the database rather than
 * through POST /api/ask also keeps this suite's fixtures independent of another
 * feature's behaviour.
 */
async function makeUser(prefix = "plan") {
  const username = testUser(prefix);
  await pool.query("INSERT INTO users (username) VALUES ($1)", [username]);
  return username;
}

/** A ready material owned by `username`. Storage keys carry no slash (§ CHECK). */
let materialSequence = 0;
async function makeMaterial(username, filename = "notes.pdf") {
  const { rows } = await pool.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size,
             status, indexing_status)
     VALUES ((SELECT id FROM users WHERE username = $1),
             $2, $3, 'application/pdf', 2048, 'ready', 'indexed')
     RETURNING id`,
    [username, filename, `api-plan-${(materialSequence += 1)}-${Date.now()}.pdf`],
  );
  return rows[0].id;
}

/**
 * A date `days` from today as `YYYY-MM-DD`, in UTC.
 *
 * Computed rather than written down: an exam date is validated against the
 * SERVER's today, so a hard-coded fixture would start failing on a date nobody
 * chose. UTC matches todayIso() in src/study-plans/study-calendar.js.
 */
function daysFromToday(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A valid creation body. Override any field, including to an invalid value. */
function planBody(username, overrides = {}) {
  return {
    username,
    subject: "Biology",
    topics: ["Photosynthesis", "Respiration"],
    examDate: daysFromToday(21),
    dailyMinutes: 60,
    difficultyLevel: "intermediate",
    studyDays: ALL_DAYS,
    ...overrides,
  };
}

const createPlan = (body) =>
  server.request("POST", "/api/study-plans", { json: body });

async function createPlanOk(username, overrides) {
  const res = await createPlan(planBody(username, overrides));
  assert.equal(res.status, 201, `create failed: ${res.text}`);
  return res.body;
}

const getPlan = (id, username) =>
  server.request("GET", `/api/study-plans/${id}?username=${encodeURIComponent(username)}`);

const listPlans = (username) =>
  server.request("GET", `/api/study-plans?username=${encodeURIComponent(username)}`);

const patchTask = (planId, taskId, body) =>
  server.request("PATCH", `/api/study-plans/${planId}/tasks/${taskId}`, {
    json: body,
  });

const regenerate = (id, body) =>
  server.request("POST", `/api/study-plans/${id}/regenerate`, { json: body });

/** An error response: right status, JSON, an `error` string, nothing internal. */
function assertJsonError(res, status, message) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(
    res.headers.get("content-type") ?? "",
    /application\/json/,
    "every error response must remain JSON (§32)",
  );
  assert.equal(typeof res.body?.error, "string", `no error string in ${res.text}`);
  if (message !== undefined) assert.equal(res.body.error, message);
  assertNoInternals(res.body);
}

/** §32: nothing internal in any body, success or failure. */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /\buser_?id\b/i, "no user id");
  assert.doesNotMatch(json, /storage_?[Kk]ey/, "no storage key");
  assert.doesNotMatch(json, /\/tmp\/|\/home\/|studypal-test-uploads/, "no path");
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, "no stack frame");
  assert.doesNotMatch(
    json,
    /generativelanguage|googleapis|GEMINI_API_KEY/i,
    "no provider detail",
  );
  assert.doesNotMatch(json, /SELECT |INSERT |study_plan_tasks/i, "no SQL");
}

// ── §39: the creation contract ──────────────────────────────────────────────

describe("POST /api/study-plans returns the documented shape (§39)", () => {
  it("creates a plan with 201 and every documented field", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);

    // The exact key set, so a field cannot be added to the public contract or
    // dropped from it without this test saying so.
    assert.deepEqual(Object.keys(plan).sort(), [...PLAN_KEYS].sort());

    assert.equal(typeof plan.id, "number");
    assert.equal(plan.title, CANNED_PLAN_TITLE);
    assert.equal(plan.subject, "Biology");
    assert.equal(typeof plan.goal, "string");
    assert.ok(plan.goal.length > 0);
    assert.equal(plan.dailyMinutes, 60);
    assert.equal(plan.difficultyLevel, "intermediate");
    assert.equal(plan.status, "active", "a new plan is active (§29)");
    assert.equal(plan.parentPlanId, null, "a first plan has no parent");
    assert.deepEqual(plan.topics, ["Photosynthesis", "Respiration"]);
    assert.deepEqual(plan.studyDays, ALL_DAYS);
    assertNoInternals(plan);
  });

  it("returns bare calendar dates, not timestamps", async () => {
    // The pg-types decision, visible at the API boundary: a study day is a
    // calendar day, and rendering one through a timezone is how a plan's first
    // task appears to fall on the day before it does.
    const username = await makeUser();
    const plan = await createPlanOk(username);

    for (const field of ["startDate", "endDate", "examDate"]) {
      assert.match(plan[field], /^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD`);
    }
    for (const task of plan.tasks) {
      assert.match(task.scheduledDate, /^\d{4}-\d{2}-\d{2}$/);
    }
    // Timestamps, by contrast, are full ISO instants.
    assert.match(plan.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("returns tasks in schedule order, each with the documented shape", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);

    assert.ok(plan.tasks.length > 0, "a plan with no tasks is never persisted (§19)");
    assert.deepEqual(Object.keys(plan.tasks[0]).sort(), [...TASK_KEYS].sort());

    let previous = null;
    for (const task of plan.tasks) {
      assert.equal(typeof task.id, "number");
      assert.ok(task.title.length > 0);
      assert.ok(["study", "review", "practice", "recap"].includes(task.taskType));
      assert.equal(task.status, "pending", "every task starts pending");
      assert.ok(task.durationMinutes >= 1 && task.durationMinutes <= 60);
      assert.equal(task.materialId, null, "no materials were requested");

      if (previous) {
        const ordered =
          task.scheduledDate > previous.scheduledDate ||
          (task.scheduledDate === previous.scheduledDate &&
            task.position > previous.position);
        assert.ok(ordered, "tasks must come back in schedule order");
      }
      previous = task;
    }
  });

  it("starts the plan today and ends it on or before the exam date (§12, §13)", async () => {
    const username = await makeUser();
    const examDate = daysFromToday(14);
    const plan = await createPlanOk(username, { examDate });

    assert.equal(plan.startDate, daysFromToday(0), "the backend owns the start date");
    assert.ok(plan.endDate <= examDate, "nothing may be scheduled past the exam");
    assert.ok(plan.startDate <= plan.endDate);

    for (const task of plan.tasks) {
      assert.ok(task.scheduledDate >= plan.startDate);
      assert.ok(task.scheduledDate <= examDate);
    }
  });

  it("ignores a client-supplied start date, status or id (§11, §29)", async () => {
    // Fields a client might send hopefully. None is in the accepted input set,
    // and none may influence the stored plan.
    const username = await makeUser();
    const plan = await createPlanOk(username, {
      id: 999_999,
      status: "completed",
      startDate: "2020-01-01",
      endDate: "2020-01-02",
      title: "Client-chosen title",
    });

    assert.notEqual(plan.id, 999_999);
    assert.equal(plan.status, "active");
    assert.equal(plan.startDate, daysFromToday(0));
    assert.equal(plan.title, CANNED_PLAN_TITLE, "the title comes from the model");
  });

  it("works for a learner with no uploaded materials at all (§37)", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, { materialIds: [] });

    assert.equal(plan.status, "active");
    assert.ok(plan.tasks.length > 0);
    for (const task of plan.tasks) assert.equal(task.materialId, null);
  });

  it("accepts a plan with no topics (§9)", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, { topics: undefined });
    assert.deepEqual(plan.topics, []);
    assert.ok(plan.tasks.length > 0);
  });

  it("accepts an exam today and schedules the one day available", async () => {
    // The cramming case. One study date, not an error.
    const username = await makeUser();
    const plan = await createPlanOk(username, { examDate: daysFromToday(0) });

    assert.equal(plan.startDate, daysFromToday(0));
    assert.equal(plan.endDate, daysFromToday(0));
    for (const task of plan.tasks) {
      assert.equal(task.scheduledDate, daysFromToday(0));
    }
  });

  it("never schedules a task on an excluded weekday (§13)", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, {
      studyDays: ["monday", "wednesday"],
      examDate: daysFromToday(28),
    });

    const names = ALL_DAYS.slice();
    for (const task of plan.tasks) {
      // getUTCDay(): 0 is Sunday, and ALL_DAYS starts at monday — so index
      // (day + 6) % 7 names it. Computed here rather than imported, because a
      // black-box test must not borrow the module it is checking.
      const day = new Date(`${task.scheduledDate}T00:00:00Z`).getUTCDay();
      const weekday = names[(day + 6) % 7];
      assert.ok(
        ["monday", "wednesday"].includes(weekday),
        `${task.scheduledDate} is a ${weekday}, which the learner excluded`,
      );
    }
  });

  it("keeps every day inside the learner's daily budget (§21, §22)", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, { dailyMinutes: 45 });

    const perDate = new Map();
    for (const task of plan.tasks) {
      assert.ok(task.durationMinutes <= 45, "no single task may exceed the budget");
      perDate.set(
        task.scheduledDate,
        (perDate.get(task.scheduledDate) ?? 0) + task.durationMinutes,
      );
    }
    for (const [date, total] of perDate) {
      assert.ok(total <= 45, `${date} totals ${total} minutes against a 45 budget`);
    }
  });
});

// ── §10: input validation ───────────────────────────────────────────────────

describe("POST /api/study-plans rejects bad input (§10)", () => {
  it("rejects the three dailyMinutes values §10 names, for three reasons", async () => {
    const username = await makeUser();

    // -100 and 0 are not extremes, they are nonsense: neither is a positive
    // integer. 999999 IS a positive integer and is refused by the ceiling. The
    // messages differ because the problems differ.
    assertJsonError(
      await createPlan(planBody(username, { dailyMinutes: -100 })),
      400,
      "Daily minutes must be a positive integer.",
    );
    assertJsonError(
      await createPlan(planBody(username, { dailyMinutes: 0 })),
      400,
      "Daily minutes must be a positive integer.",
    );
    assertJsonError(
      await createPlan(planBody(username, { dailyMinutes: 999_999 })),
      400,
      "Daily minutes must be 720 or fewer.",
    );
  });

  it("rejects a dailyMinutes below the useful floor", async () => {
    const username = await makeUser();
    assertJsonError(
      await createPlan(planBody(username, { dailyMinutes: 5 })),
      400,
      "Daily minutes must be at least 10.",
    );
  });

  it("rejects a dailyMinutes that is not a whole number", async () => {
    const username = await makeUser();
    for (const value of [30.5, "60", null, [], {}, Number.NaN]) {
      assertJsonError(
        await createPlan(planBody(username, { dailyMinutes: value })),
        400,
        "Daily minutes must be a positive integer.",
      );
    }
  });

  it("requires a username, and does not echo what was sent", async () => {
    for (const value of [undefined, "", "   ", 42, null, ["a", "b"], { $ne: null }]) {
      const res = await createPlan(planBody("ignored", { username: value }));
      assertJsonError(res, 400, "Username is required.");
    }
    // The rejection must not reflect the input back into the response body.
    const res = await createPlan(
      planBody("x", { username: "<script>alert(1)</script>".repeat(50) }),
    );
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, /<script>/, "no input may be echoed (§32)");
  });

  it("requires a subject and bounds its length", async () => {
    const username = await makeUser();
    for (const value of [undefined, "", "   ", 42, null]) {
      assertJsonError(
        await createPlan(planBody(username, { subject: value })),
        400,
        "Subject is required.",
      );
    }
    assertJsonError(
      await createPlan(planBody(username, { subject: "S".repeat(201) })),
      400,
      "Subject must be 200 characters or fewer.",
    );
    // The boundary itself is accepted, so the bound is not off by one.
    const ok = await createPlan(planBody(username, { subject: "S".repeat(200) }));
    assert.equal(ok.status, 201, ok.text);
  });

  it("validates the topics array", async () => {
    const username = await makeUser();

    assertJsonError(
      await createPlan(planBody(username, { topics: "Photosynthesis" })),
      400,
      "Topics must be an array.",
    );
    assertJsonError(
      await createPlan(planBody(username, { topics: ["ok", 42] })),
      400,
      "Each topic must be a string.",
    );
    assertJsonError(
      await createPlan(planBody(username, { topics: ["T".repeat(201)] })),
      400,
      "Each topic must be 200 characters or fewer.",
    );
    assertJsonError(
      await createPlan(
        planBody(username, {
          topics: Array.from({ length: 21 }, (_, i) => `Topic ${i}`),
        }),
      ),
      400,
      "A plan may have at most 20 topics.",
    );
  });

  it("drops blank topics rather than rejecting the request", async () => {
    // A trailing empty input is a form artefact, not a malformed request.
    const username = await makeUser();
    const plan = await createPlanOk(username, {
      topics: ["Kinetics", "", "   ", "Equilibria"],
    });
    assert.deepEqual(plan.topics, ["Kinetics", "Equilibria"]);
  });

  it("validates the exam date (§12)", async () => {
    const username = await makeUser();

    for (const value of [
      undefined,
      "",
      "tomorrow",
      "2026-9-4",
      "04/09/2026",
      `${daysFromToday(10)}T00:00:00Z`,
      20_260_904,
      null,
    ]) {
      assertJsonError(
        await createPlan(planBody(username, { examDate: value })),
        400,
        "Exam date must be a valid date in YYYY-MM-DD format.",
      );
    }

    // A date that passes the regex and does not exist. `new Date` would roll
    // this over into March rather than rejecting it.
    assertJsonError(
      await createPlan(planBody(username, { examDate: "2027-02-31" })),
      400,
      "Exam date must be a valid date in YYYY-MM-DD format.",
    );

    assertJsonError(
      await createPlan(planBody(username, { examDate: daysFromToday(-1) })),
      400,
      "Exam date must not be in the past.",
    );

    assertJsonError(
      await createPlan(planBody(username, { examDate: daysFromToday(400) })),
      400,
      "Exam date must be within 365 days.",
    );
  });

  it("validates the difficulty level", async () => {
    const username = await makeUser();
    for (const value of [undefined, "", "Expert", "BEGINNER", 1, null]) {
      assertJsonError(
        await createPlan(planBody(username, { difficultyLevel: value })),
        400,
        "Difficulty level must be one of: beginner, intermediate, advanced.",
      );
    }
    for (const level of ["beginner", "intermediate", "advanced"]) {
      const res = await createPlan(planBody(username, { difficultyLevel: level }));
      assert.equal(res.status, 201, `${level} must be accepted: ${res.text}`);
    }
  });

  it("requires at least one study day and rejects nonsense ones (§13)", async () => {
    const username = await makeUser();

    for (const value of [undefined, [], null, "monday", {}]) {
      assertJsonError(
        await createPlan(planBody(username, { studyDays: value })),
        400,
        "At least one study day is required.",
      );
    }
    assertJsonError(
      await createPlan(planBody(username, { studyDays: [...ALL_DAYS, "monday"] })),
      400,
      "Study days must not contain more than seven days.",
    );
    for (const value of [["funday"], ["mon"], [1], [null], ["monday ", "tues"]]) {
      assertJsonError(
        await createPlan(planBody(username, { studyDays: value })),
        400,
        "Study days must be day names, for example: monday, wednesday, friday.",
      );
    }
    // The invariant a CHECK constraint cannot express, so the boundary owns it.
    assertJsonError(
      await createPlan(planBody(username, { studyDays: ["monday", "monday"] })),
      400,
      "Study days must not contain duplicates.",
    );
  });

  it("accepts study day names in any case, and stores them lowercased", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, {
      studyDays: ["Monday", " WEDNESDAY ", "friday"],
    });
    assert.deepEqual(plan.studyDays, ["monday", "wednesday", "friday"]);
  });

  it("validates the material id list", async () => {
    const username = await makeUser();

    assertJsonError(
      await createPlan(planBody(username, { materialIds: 7 })),
      400,
      "Material ids must be an array.",
    );
    assertJsonError(
      await createPlan(
        planBody(username, { materialIds: Array.from({ length: 11 }, (_, i) => i + 1) }),
      ),
      400,
      "A plan may reference at most 10 materials.",
    );
    for (const value of [["1"], [0], [-3], [1.5], [null]]) {
      assertJsonError(
        await createPlan(planBody(username, { materialIds: value })),
        400,
        "Each material id must be a positive integer.",
      );
    }
    assertJsonError(
      await createPlan(planBody(username, { materialIds: [1, 1] })),
      400,
      "Material ids must not contain duplicates.",
    );
  });

  it("rejects a malformed JSON body as 400, not 500", async () => {
    const res = await server.request("POST", "/api/study-plans", {
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    assertJsonError(res, 400);
  });

  it("rejects an empty body without crashing", async () => {
    // `req.body` is undefined here; destructuring it would turn a 400 into a 500.
    const res = await server.request("POST", "/api/study-plans", {});
    assertJsonError(res, 400, "Username is required.");
  });

  it("does not create a user as a side effect of a plan request (§10)", async () => {
    // Unlike /api/ask and /api/materials, these endpoints require a user that
    // already exists — a plan is not someone's first interaction with StudyPal.
    const username = testUser("ghost");
    const res = await createPlan(planBody(username));
    assertJsonError(res, 404, "Study plan not found.");

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM users WHERE username = $1",
      [username],
    );
    assert.equal(rows[0].c, 0, "no user row may be created by a failed plan request");
  });

  it("persists nothing when validation fails", async () => {
    const username = await makeUser();
    await createPlan(planBody(username, { dailyMinutes: 0 }));

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS c FROM study_plans
        WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [username],
    );
    assert.equal(rows[0].c, 0);
  });
});

// ── §26, §27: retrieval ─────────────────────────────────────────────────────

describe("GET /api/study-plans lists a learner's plans (§26)", () => {
  it("returns metadata with counts, newest first, and no task lists", async () => {
    const username = await makeUser();
    const first = await createPlanOk(username, { subject: "Biology" });
    const second = await createPlanOk(username, { subject: "Chemistry" });

    const res = await listPlans(username);
    assert.equal(res.status, 200, res.text);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);

    assert.equal(res.body[0].id, second.id, "newest first");
    assert.equal(res.body[1].id, first.id);

    const summary = res.body[0];
    assert.deepEqual(Object.keys(summary).sort(), SUMMARY_KEYS);
    assert.equal(summary.tasks, undefined, "§26 is metadata, not full task lists");
    assert.equal(summary.taskCount, second.tasks.length);
    assert.equal(summary.completedTaskCount, 0);
    assert.equal(summary.skippedTaskCount, 0);
    assertNoInternals(res.body);
  });

  it("counts completed and skipped tasks separately", async () => {
    // Both are terminal and both count towards completion, but a learner who
    // skipped half their plan is not in the same position as one who finished it.
    const username = await makeUser();
    const plan = await createPlanOk(username);

    await patchTask(plan.id, plan.tasks[0].id, { username, status: "completed" });
    await patchTask(plan.id, plan.tasks[1].id, { username, status: "skipped" });

    const res = await listPlans(username);
    assert.equal(res.body[0].completedTaskCount, 1);
    assert.equal(res.body[0].skippedTaskCount, 1);
    assert.equal(res.body[0].taskCount, plan.tasks.length);
  });

  it("returns an empty array for a learner with no plans", async () => {
    const username = await makeUser();
    const res = await listPlans(username);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it("returns an empty array for a username that does not exist", async () => {
    // Matches listMaterials and GET /api/history: the frontend maps over the
    // result unguarded, and the two cases are the same answer to a client that
    // cannot authenticate anyway.
    const res = await listPlans(testUser("nobody"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it("requires a username", async () => {
    assertJsonError(
      await server.request("GET", "/api/study-plans"),
      400,
      "Username is required.",
    );
    assertJsonError(
      await server.request("GET", "/api/study-plans?username=%20%20"),
      400,
      "Username is required.",
    );
  });

  it("rejects a repeated username parameter rather than taking the first", async () => {
    // Express parses ?username=a&username=b into an array. Quietly taking the
    // first is how filter-bypass bugs start.
    const username = await makeUser();
    await createPlanOk(username);
    const res = await server.request(
      "GET",
      `/api/study-plans?username=${username}&username=${testUser("other")}`,
    );
    assertJsonError(res, 400, "Username is required.");
  });
});

describe("GET /api/study-plans/:id returns one plan with its tasks (§27)", () => {
  it("returns the plan exactly as creation did", async () => {
    const username = await makeUser();
    const created = await createPlanOk(username);

    const res = await getPlan(created.id, username);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), [...PLAN_KEYS].sort());
    assert.equal(res.body.id, created.id);
    assert.equal(res.body.title, created.title);
    assert.equal(res.body.startDate, created.startDate);
    assert.equal(res.body.tasks.length, created.tasks.length);
    assert.deepEqual(
      res.body.tasks.map((t) => t.id),
      created.tasks.map((t) => t.id),
      "and in the same order",
    );
  });

  it("404s for a plan id that does not exist", async () => {
    const username = await makeUser();
    assertJsonError(await getPlan(999_999_999, username), 404, "Study plan not found.");
  });

  it("404s for a username that does not exist", async () => {
    assertJsonError(await getPlan(1, testUser("nobody")), 404, "Study plan not found.");
  });

  it("400s for an id that is not a positive integer", async () => {
    const username = await makeUser();
    for (const id of ["abc", "1.5", "-1", "0", "1e3", "0x10", "%20", "999999999999999999999"]) {
      assertJsonError(
        await getPlan(id, username),
        400,
        "Study plan id must be a positive integer.",
      );
    }
  });

  it("requires a username", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);
    assertJsonError(
      await server.request("GET", `/api/study-plans/${plan.id}`),
      400,
      "Username is required.",
    );
  });
});

// ── §27: ownership ──────────────────────────────────────────────────────────

describe("knowing a plan id is not authorisation (§27)", () => {
  let alice;
  let bob;
  let alicePlan;

  before(async () => {
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    alicePlan = await createPlanOk(alice);
  });

  it("Bob cannot read Alice's plan, and gets the same 404 as for a fake id", async () => {
    const real = await getPlan(alicePlan.id, bob);
    const fake = await getPlan(999_999_999, bob);

    assertJsonError(real, 404, "Study plan not found.");
    // Identical bodies: a 403, or a different message, would confirm the id is
    // real and let a caller enumerate plan ids.
    assert.deepEqual(real.body, fake.body);
    assert.equal(real.status, fake.status);
  });

  it("Bob's list does not contain Alice's plan", async () => {
    const res = await listPlans(bob);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it("Bob cannot update a task in Alice's plan", async () => {
    const res = await patchTask(alicePlan.id, alicePlan.tasks[0].id, {
      username: bob,
      status: "completed",
    });
    assertJsonError(res, 404, "Study plan not found.");

    // And the task is untouched — a 404 that still wrote would be worse than no
    // check at all.
    const check = await getPlan(alicePlan.id, alice);
    assert.equal(check.body.tasks[0].status, "pending");
  });

  it("Bob cannot regenerate Alice's plan", async () => {
    const res = await regenerate(alicePlan.id, { username: bob });
    assertJsonError(res, 404, "Study plan not found.");

    const { rows } = await pool.query(
      `SELECT status FROM study_plans WHERE id = $1`,
      [alicePlan.id],
    );
    assert.equal(rows[0].status, "active", "Alice's plan must not be archived");
  });

  it("Bob cannot ground a plan in Alice's material (§10)", async () => {
    // The ids are real and belong to Alice. The client says they are Bob's;
    // the database says otherwise, and the database is the authority.
    const aliceMaterial = await makeMaterial(alice, "alice-notes.pdf");
    const res = await createPlan(planBody(bob, { materialIds: [aliceMaterial] }));

    assertJsonError(res, 400, "One or more of the selected materials could not be found.");
    // The message names no id and does not distinguish "not yours" from "does
    // not exist", so material ids cannot be enumerated through it.
    assert.doesNotMatch(res.text, new RegExp(String(aliceMaterial)));
  });

  it("rejects a material id that exists for nobody with the same message", async () => {
    const res = await createPlan(planBody(bob, { materialIds: [999_999_999] }));
    assertJsonError(res, 400, "One or more of the selected materials could not be found.");
  });

  it("Alice can still do everything Bob could not", async () => {
    // The control. Without this, every assertion above would also pass if the
    // endpoints were simply broken.
    const read = await getPlan(alicePlan.id, alice);
    assert.equal(read.status, 200);

    const patched = await patchTask(alicePlan.id, alicePlan.tasks[0].id, {
      username: alice,
      status: "in_progress",
    });
    assert.equal(patched.status, 200, patched.text);

    const listed = await listPlans(alice);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, alicePlan.id);
  });
});

// ── §28, §29: task status and derived plan status ───────────────────────────

describe("PATCH task status, and the plan status derived from it (§28, §29)", () => {
  it("moves a task to each of the four statuses", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);
    const taskId = plan.tasks[0].id;

    for (const status of ["in_progress", "completed", "skipped", "pending"]) {
      const res = await patchTask(plan.id, taskId, { username, status });
      assert.equal(res.status, 200, `${status} rejected: ${res.text}`);
      assert.equal(res.body.task.status, status);
      assert.equal(res.body.task.id, taskId);
      assert.deepEqual(Object.keys(res.body.task).sort(), [...TASK_KEYS].sort());
      assert.equal(typeof res.body.planStatus, "string");
    }
  });

  it("allows a completed task to be reopened", async () => {
    // Undoing a completion is a normal thing to do; a one-way transition would
    // make a mis-tap permanent.
    const username = await makeUser();
    const plan = await createPlanOk(username);
    const taskId = plan.tasks[0].id;

    await patchTask(plan.id, taskId, { username, status: "completed" });
    const res = await patchTask(plan.id, taskId, { username, status: "pending" });

    assert.equal(res.status, 200);
    assert.equal(res.body.task.status, "pending");
  });

  it("rejects a status outside the four allowed", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);

    for (const status of [undefined, "", "done", "COMPLETED", "cancelled", 1, null, {}]) {
      assertJsonError(
        await patchTask(plan.id, plan.tasks[0].id, { username, status }),
        400,
        "Status must be one of: pending, in_progress, completed, skipped.",
      );
    }
  });

  it("requires a username in the body", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);
    assertJsonError(
      await patchTask(plan.id, plan.tasks[0].id, { status: "completed" }),
      400,
      "Username is required.",
    );
  });

  it("400s for ids that are not positive integers, naming which one", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);

    assertJsonError(
      await patchTask("abc", plan.tasks[0].id, { username, status: "completed" }),
      400,
      "Study plan id must be a positive integer.",
    );
    assertJsonError(
      await patchTask(plan.id, "abc", { username, status: "completed" }),
      400,
      "Task id must be a positive integer.",
    );
  });

  it("404s for a task that belongs to a different plan", async () => {
    // Both ids are real and both are the learner's own — but the task is not in
    // the plan the URL names, and the UPDATE's three conditions are one
    // statement, so it matches nothing.
    const username = await makeUser();
    const planA = await createPlanOk(username, { subject: "Biology" });
    const planB = await createPlanOk(username, { subject: "Chemistry" });

    const res = await patchTask(planA.id, planB.tasks[0].id, {
      username,
      status: "completed",
    });
    assertJsonError(res, 404, "Study plan not found.");

    const check = await getPlan(planB.id, username);
    assert.equal(check.body.tasks[0].status, "pending", "and nothing was written");
  });

  it("404s for a task id that does not exist", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);
    assertJsonError(
      await patchTask(plan.id, 999_999_999, { username, status: "completed" }),
      404,
      "Study plan not found.",
    );
  });

  it("completes the plan when the last task is finished, and reopens it (§29)", async () => {
    const username = await makeUser();
    // A short horizon so the plan has few enough tasks to finish in a test.
    const plan = await createPlanOk(username, {
      examDate: daysFromToday(1),
      studyDays: ALL_DAYS,
    });
    assert.ok(plan.tasks.length >= 2, `expected a few tasks, got ${plan.tasks.length}`);

    let last;
    for (const [index, task] of plan.tasks.entries()) {
      last = await patchTask(plan.id, task.id, { username, status: "completed" });
      assert.equal(last.status, 200, last.text);

      const expected = index === plan.tasks.length - 1 ? "completed" : "active";
      assert.equal(
        last.body.planStatus,
        expected,
        `after ${index + 1} of ${plan.tasks.length} tasks`,
      );
    }

    // Derived, so it is visible on the read path too — not only in the PATCH
    // response.
    const read = await getPlan(plan.id, username);
    assert.equal(read.body.status, "completed");

    // And it reopens. This is the direction a one-way transition would break.
    const reopened = await patchTask(plan.id, plan.tasks[0].id, {
      username,
      status: "pending",
    });
    assert.equal(reopened.body.planStatus, "active");
    assert.equal((await getPlan(plan.id, username)).body.status, "active");
  });

  it("treats a skipped task as done for the plan's status", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, { examDate: daysFromToday(1) });

    for (const task of plan.tasks.slice(0, -1)) {
      await patchTask(plan.id, task.id, { username, status: "completed" });
    }
    const res = await patchTask(plan.id, plan.tasks.at(-1).id, {
      username,
      status: "skipped",
    });

    assert.equal(res.body.planStatus, "completed", "skipped is terminal too");
  });

  it("leaves an in_progress task counting as unfinished", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username, { examDate: daysFromToday(1) });

    for (const task of plan.tasks.slice(0, -1)) {
      await patchTask(plan.id, task.id, { username, status: "completed" });
    }
    const res = await patchTask(plan.id, plan.tasks.at(-1).id, {
      username,
      status: "in_progress",
    });

    assert.equal(res.body.planStatus, "active", "in_progress is not done");
  });

  it("never lets a client set the plan status directly", async () => {
    // §29: derived, and there is no endpoint that accepts one. A `planStatus`
    // in the PATCH body is simply ignored.
    const username = await makeUser();
    const plan = await createPlanOk(username);

    const res = await patchTask(plan.id, plan.tasks[0].id, {
      username,
      status: "completed",
      planStatus: "cancelled",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.planStatus, "active", "one task of many is not a finished plan");
  });
});

// ── §30: regeneration ───────────────────────────────────────────────────────

describe("POST /api/study-plans/:id/regenerate never overwrites (§30)", () => {
  it("creates a new plan that points back at the original", async () => {
    const username = await makeUser();
    const original = await createPlanOk(username);

    const res = await regenerate(original.id, { username });
    assert.equal(res.status, 201, res.text);

    const replacement = res.body;
    assert.notEqual(replacement.id, original.id, "a new row, not an overwrite");
    assert.equal(replacement.parentPlanId, original.id, "lineage is recorded");
    assert.equal(replacement.status, "active");
    assert.ok(replacement.tasks.length > 0);
    assert.deepEqual(Object.keys(replacement).sort(), [...PLAN_KEYS].sort());
  });

  it("archives the original and preserves the learner's progress in it", async () => {
    const username = await makeUser();
    const original = await createPlanOk(username);
    await patchTask(original.id, original.tasks[0].id, {
      username,
      status: "completed",
    });

    await regenerate(original.id, { username });

    const old = await getPlan(original.id, username);
    assert.equal(old.status, 200, "the original is still readable");
    assert.equal(old.body.status, "archived");
    assert.equal(old.body.tasks.length, original.tasks.length, "its tasks survive");
    assert.equal(
      old.body.tasks[0].status,
      "completed",
      "and so does the progress through them",
    );
  });

  it("carries the original's goals rather than taking new ones from the body", async () => {
    // A regeneration that accepted new goals would be a create endpoint with a
    // confusing name, and the lineage would be a lie about what the two share.
    const username = await makeUser();
    const original = await createPlanOk(username, {
      subject: "Organic Chemistry",
      topics: ["Alkenes"],
      dailyMinutes: 90,
      difficultyLevel: "advanced",
      studyDays: ["tuesday", "thursday"],
    });

    const res = await regenerate(original.id, {
      username,
      subject: "Astrophysics",
      dailyMinutes: 15,
      difficultyLevel: "beginner",
      studyDays: ["sunday"],
    });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.subject, "Organic Chemistry");
    assert.deepEqual(res.body.topics, ["Alkenes"]);
    assert.equal(res.body.dailyMinutes, 90);
    assert.equal(res.body.difficultyLevel, "advanced");
    assert.deepEqual(res.body.studyDays, ["tuesday", "thursday"]);
    assert.equal(res.body.examDate, original.examDate);
  });

  it("shows both plans in the list, newest first", async () => {
    const username = await makeUser();
    const original = await createPlanOk(username);
    const replacement = (await regenerate(original.id, { username })).body;

    const res = await listPlans(username);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].id, replacement.id);
    assert.equal(res.body[0].status, "active");
    assert.equal(res.body[1].id, original.id);
    assert.equal(res.body[1].status, "archived");
  });

  it("can be repeated, forming a chain", async () => {
    const username = await makeUser();
    const first = await createPlanOk(username);
    const second = (await regenerate(first.id, { username })).body;
    const third = (await regenerate(second.id, { username })).body;

    assert.equal(second.parentPlanId, first.id);
    assert.equal(third.parentPlanId, second.id);

    const statuses = new Map(
      (await listPlans(username)).body.map((plan) => [plan.id, plan.status]),
    );
    assert.equal(statuses.get(first.id), "archived");
    assert.equal(statuses.get(second.id), "archived");
    assert.equal(statuses.get(third.id), "active");
  });

  it("records lineage without rewriting a completed plan's outcome", async () => {
    // The archive is a compare-and-set on `status = 'active'`. A plan that
    // finished is a fact, and a newer plan existing does not unmake it.
    const username = await makeUser();
    const plan = await createPlanOk(username, { examDate: daysFromToday(1) });
    for (const task of plan.tasks) {
      await patchTask(plan.id, task.id, { username, status: "completed" });
    }
    assert.equal((await getPlan(plan.id, username)).body.status, "completed");

    const replacement = (await regenerate(plan.id, { username })).body;

    assert.equal(replacement.parentPlanId, plan.id, "lineage is still recorded");
    assert.equal(
      (await getPlan(plan.id, username)).body.status,
      "completed",
      "but the completion stands",
    );
  });

  it("requires a username, and 404s for a plan that is not the caller's", async () => {
    const username = await makeUser();
    const plan = await createPlanOk(username);

    assertJsonError(await regenerate(plan.id, {}), 400, "Username is required.");
    assertJsonError(
      await regenerate(999_999_999, { username }),
      404,
      "Study plan not found.",
    );
    assertJsonError(
      await regenerate("abc", { username }),
      400,
      "Study plan id must be a positive integer.",
    );
  });
});

// ── §41: one full journey ───────────────────────────────────────────────────

describe("a complete learner journey over HTTP (§41)", () => {
  it("creates, lists, reads, works through and regenerates a plan", async () => {
    const username = await makeUser("journey");

    // 1. No plans yet.
    assert.deepEqual((await listPlans(username)).body, []);

    // 2. Create one, grounded in nothing, over a short horizon.
    const created = await createPlanOk(username, {
      subject: "Cell Biology",
      topics: ["Mitosis", "Meiosis"],
      examDate: daysFromToday(2),
      dailyMinutes: 50,
      difficultyLevel: "beginner",
      studyDays: ALL_DAYS,
    });
    assert.equal(created.status, "active");
    assert.ok(created.tasks.length > 0);

    // 3. It appears in the list with the right counts.
    const listed = (await listPlans(username)).body;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].taskCount, created.tasks.length);
    assert.equal(listed[0].completedTaskCount, 0);

    // 4. It reads back identically.
    const fetched = (await getPlan(created.id, username)).body;
    assert.deepEqual(
      fetched.tasks.map((t) => t.id),
      created.tasks.map((t) => t.id),
    );

    // 5. Work through every task; the plan completes exactly at the end.
    for (const [index, task] of fetched.tasks.entries()) {
      const res = await patchTask(created.id, task.id, {
        username,
        status: "completed",
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(
        res.body.planStatus,
        index === fetched.tasks.length - 1 ? "completed" : "active",
      );
    }

    // 6. The list reflects it without a second round trip per plan.
    const afterWork = (await listPlans(username)).body[0];
    assert.equal(afterWork.status, "completed");
    assert.equal(afterWork.completedTaskCount, fetched.tasks.length);

    // 7. Regenerate: a new active plan, the old one intact behind it.
    const replacement = (await regenerate(created.id, { username })).body;
    assert.equal(replacement.parentPlanId, created.id);
    assert.equal(replacement.status, "active");

    const finalList = (await listPlans(username)).body;
    assert.equal(finalList.length, 2);
    assert.equal(finalList[0].id, replacement.id);
    assert.equal(finalList[1].status, "completed", "history is not rewritten");

    // 8. Nothing internal leaked anywhere along the way.
    assertNoInternals(finalList);
    assertNoInternals(replacement);
  });
});

// ── the shape of the surface itself ─────────────────────────────────────────

describe("the endpoint surface is exactly five routes", () => {
  it("does not expose a delete or a cancel", async () => {
    // §29 reserves `cancelled` as a status, and nothing writes it yet — see the
    // header of src/study-plans/study-plan.routes.js. If a DELETE is added
    // later, this test is where the decision gets recorded.
    const username = await makeUser();
    const plan = await createPlanOk(username);

    for (const [method, path] of [
      ["DELETE", `/api/study-plans/${plan.id}`],
      ["PUT", `/api/study-plans/${plan.id}`],
      ["POST", `/api/study-plans/${plan.id}/cancel`],
      ["PATCH", `/api/study-plans/${plan.id}`],
    ]) {
      const res = await server.request(method, path, { json: { username } });
      assert.equal(res.status, 404, `${method} ${path} must not exist`);
      assert.equal(res.body.error, "Not found");
    }

    // And the plan is untouched by any of it.
    assert.equal((await getPlan(plan.id, username)).body.status, "active");
  });

  it("answers unknown study-plan paths with JSON, not an HTML error page", async () => {
    const res = await server.request("GET", "/api/study-plans/1/tasks");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });
});
