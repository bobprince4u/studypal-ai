/**
 * The analytics HTTP API — §13's endpoints, §12's envelope, §18's zero-data
 * user, §11's ownership and §24's response-safety checks.
 *
 * Black box, like tests/study-plans/api.test.js and tests/exams/api.test.js:
 * a real server in a child process, a real PostgreSQL database, and nothing in
 * this file imported from src/. What it asserts is what a client observes, which
 * is the only level at which "the response contains no user_id" is a fact rather
 * than an intention.
 *
 * WHAT THIS FILE IS FOR THAT THE OTHER TWO ARE NOT
 * -----------------------------------------------
 * tests/analytics/metrics.test.js proves the arithmetic and
 * tests/analytics/repository.test.js proves the SQL. Neither can show that the
 * numbers reach the client, that the validators are actually mounted, or that
 * the six routes are the only six. Those are properties of the wiring, and the
 * wiring is what this file exercises — including the negative claim §1 rests on:
 * there is no verb but GET under /api/analytics.
 *
 * THE FIXTURES ARE SEEDED WITH SQL, NOT THROUGH THE API
 * ----------------------------------------------------
 * Producing one graded attempt through HTTP takes a plan, an exam generation, an
 * attempt start and a submission — four features, any of which failing would
 * make an analytics assertion red for a reason outside analytics. The exam and
 * study-plan suites already cover those paths. Here the persisted state is the
 * input, written directly, so each expected number is arithmetic over literals
 * in this file.
 *
 *   node --test tests/analytics/api.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";

/** §2's overview keys, asserted exactly so a new field is a deliberate change. */
const OVERVIEW_KEYS = ["exams", "studyPlans", "tasks", "trend"];

const STUDY_PLAN_KEYS = ["active", "archived", "cancelled", "completed", "total"];

const TASK_KEYS = [
  "completed",
  "completionPercentage",
  "inProgress",
  "pending",
  "skipped",
  "total",
];

const EXAM_KEYS = [
  "attempts",
  "averagePercentage",
  "completedAttempts",
  "failed",
  "highestPercentage",
  "inProgressAttempts",
  "lowestPercentage",
  "mostRecentPercentage",
  "passed",
  "total",
];

const TREND_KEYS = [
  "difference",
  "direction",
  "previousAveragePercentage",
  "recentAveragePercentage",
];

const HISTORY_KEYS = [
  "attemptId",
  "correctAnswers",
  "examDifficulty",
  "examId",
  "examSubject",
  "examTitle",
  "passed",
  "percentage",
  "score",
  "startedAt",
  "submittedAt",
  "totalQuestions",
];

const TOPIC_KEYS = [
  "accuracyPercentage",
  "correct",
  "incorrect",
  "questionsAttempted",
  "topic",
];

const WEAK_AREA_KEYS = [...TOPIC_KEYS, "reason"].sort();

const MATERIAL_KEYS = [
  "accuracyPercentage",
  "correct",
  "filename",
  "incorrect",
  "materialId",
  "questionsAttempted",
];

const PLAN_PROGRESS_KEYS = [
  "createdAt",
  "dailyMinutes",
  "endDate",
  "examDate",
  "planId",
  "startDate",
  "status",
  "subject",
  "tasks",
  "title",
  "topics",
  "updatedAt",
];

const PLAN_TOPIC_KEYS = [
  "completedTasks",
  "completionPercentage",
  "topic",
  "totalTasks",
];

let server;
let pool;

before(async () => {
  server = await startServer({ label: "analytics-api" });
  pool = new pg.Pool({ connectionString: server.databaseUrl, max: 4 });
});

after(async () => {
  await pool?.end();
  await server?.stop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let sequence = 0;
function unique() {
  sequence += 1;
  return `${sequence}_${Date.now().toString(36)}`;
}

/**
 * Create a user row directly.
 *
 * Analytics deliberately does NOT upsert users — §1 makes it read-only, and
 * `users.upsert` on a GET would be a write. So a username only exists here if
 * this function put it there, which is also what makes the unknown-username
 * tests below meaningful.
 */
async function makeUser(prefix = "an") {
  const username = testUser(prefix);
  await pool.query("INSERT INTO users (username) VALUES ($1)", [username]);
  return username;
}

const userId = (username) =>
  pool
    .query("SELECT id FROM users WHERE username = $1", [username])
    .then(({ rows }) => rows[0].id);

async function makeMaterial(username, filename = "notes.pdf") {
  const { rows } = await pool.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size, status)
     VALUES ((SELECT id FROM users WHERE username = $1),
             $2, $3, 'application/pdf', 2048, 'ready')
     RETURNING id`,
    [username, filename, `analytics-api-${unique()}.pdf`],
  );
  return rows[0].id;
}

async function makePlan(
  username,
  { status = "active", title = "Plan", subject = "Maths" } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO study_plans
            (user_id, title, subject, goal, start_date, end_date, exam_date,
             daily_minutes, difficulty_level, status, topics, study_days)
     VALUES ((SELECT id FROM users WHERE username = $1),
             $2, $3, 'Pass the exam', '2026-01-01', '2026-01-31', '2026-02-05',
             60, 'intermediate', $4, ARRAY['Algebra']::text[],
             ARRAY['monday', 'wednesday']::text[])
     RETURNING id`,
    [username, title, subject, status],
  );
  return rows[0].id;
}

async function makeTasks(planId, username, entries) {
  const owner = await userId(username);
  for (const [index, entry] of entries.entries()) {
    await pool.query(
      `INSERT INTO study_plan_tasks
              (study_plan_id, user_id, scheduled_date, position, title, topic,
               task_type, duration_minutes, status)
       VALUES ($1, $2, '2026-01-05'::date + $3::int, $3, $4, $5, 'study', 45, $6)`,
      [
        planId,
        owner,
        index,
        entry.title ?? `Task ${index + 1}`,
        entry.topic ?? null,
        entry.status ?? "pending",
      ],
    );
  }
}

let submittedAtTick = 0;
function nextSubmittedAt() {
  submittedAtTick += 1;
  return new Date(Date.UTC(2026, 0, 1, 9, submittedAtTick, 0)).toISOString();
}

/**
 * An exam, its questions, one attempt and its answers — the same helper
 * tests/analytics/repository.test.js uses, keyed on username.
 *
 * The stored `percentage` is computed over every question on the paper, the way
 * src/exams/grader.js computes it, so no fixture here asserts a grading rule
 * this phase does not own.
 */
async function sitExam(
  username,
  {
    topics = ["Algebra"],
    results = [true],
    unanswered = 0,
    sources = [],
    status = "completed",
    title = "Mock exam",
    subject = "Maths",
  } = {},
) {
  const owner = await userId(username);
  const total = results.length + unanswered;
  const correct = results.filter(Boolean).length;
  const percentage = Math.round((correct / total) * 100);
  const sourceType = sources.some((id) => id) ? "material" : "topics";

  const { rows: examRows } = await pool.query(
    `INSERT INTO exams
            (user_id, title, subject, difficulty, question_count, source_type, topics)
     VALUES ($1, $2, $3, 'medium', $4, $5, $6::text[])
     RETURNING id`,
    [owner, title, subject, total, sourceType, topics],
  );
  const examId = examRows[0].id;

  const questionIds = [];
  for (let order = 1; order <= total; order += 1) {
    const { rows } = await pool.query(
      `INSERT INTO exam_questions
              (exam_id, user_id, question_order, question_type, question_text,
               options, correct_answer, explanation, source_material_id)
       VALUES ($1, $2, $3, 'multiple_choice', $4,
               '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
               'a', 'Because.', $5)
       RETURNING id`,
      [examId, owner, order, `Question ${order}?`, sources[order - 1] ?? null],
    );
    questionIds.push(rows[0].id);
  }

  const { rows: attemptRows } =
    status === "completed"
      ? await pool.query(
          `INSERT INTO exam_attempts
                  (exam_id, user_id, status, started_at, submitted_at, score,
                   total_questions, correct_answers, percentage, passed)
           VALUES ($1, $2, 'completed', $3::timestamptz - interval '15 minutes',
                   $3::timestamptz, $4, $5, $4, $6, $7)
           RETURNING id`,
          [
            examId,
            owner,
            nextSubmittedAt(),
            correct,
            total,
            percentage,
            percentage >= 60,
          ],
        )
      : await pool.query(
          `INSERT INTO exam_attempts (exam_id, user_id, status)
           VALUES ($1, $2, 'in_progress') RETURNING id`,
          [examId, owner],
        );

  for (const [index, isCorrect] of results.entries()) {
    await pool.query(
      `INSERT INTO attempt_answers
              (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attemptRows[0].id,
        owner,
        questionIds[index],
        isCorrect ? "a" : "b",
        isCorrect,
      ],
    );
  }

  return { examId, attemptId: attemptRows[0].id, percentage };
}

// ── request helpers ─────────────────────────────────────────────────────────

const q = (username) => `username=${encodeURIComponent(username)}`;

const overview = (username) => server.request("GET", `/api/analytics?${q(username)}`);

const history = (username, extra = "") =>
  server.request("GET", `/api/analytics/exams?${q(username)}${extra}`);

const topics = (username) =>
  server.request("GET", `/api/analytics/topics?${q(username)}`);

const weakAreas = (username) =>
  server.request("GET", `/api/analytics/weak-areas?${q(username)}`);

const materials = (username) =>
  server.request("GET", `/api/analytics/materials?${q(username)}`);

const planProgress = (planId, username) =>
  server.request("GET", `/api/analytics/study-plans/${planId}?${q(username)}`);

/** Every analytics path, for the checks that must hold on all of them. */
const ALL_ENDPOINTS = [
  { name: "overview", path: () => "/api/analytics" },
  { name: "history", path: () => "/api/analytics/exams" },
  { name: "topics", path: () => "/api/analytics/topics" },
  { name: "weak areas", path: () => "/api/analytics/weak-areas" },
  { name: "materials", path: () => "/api/analytics/materials" },
  { name: "plan progress", path: (id) => `/api/analytics/study-plans/${id ?? 1}` },
];

function assertOk(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assertNoInternals(res.body);
  return res.body;
}

function assertJsonError(res, status, message) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(typeof res.body?.error, "string", `no error string in ${res.text}`);
  if (message !== undefined) assert.equal(res.body.error, message);
  assertNoInternals(res.body);
}

/**
 * §24's response-safety checklist, applied to every body this suite receives.
 *
 * "no raw DB rows returned, no password hashes returned, no secrets returned, no
 * stack traces returned, no database errors leaked". Each pattern below is one
 * of those, and the SQL-keyword check is the one that catches the specific
 * failure mode analytics has more of than any other feature: a `pg` error
 * reaching the client would carry the failing statement with it.
 */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload ?? null);

  assert.doesNotMatch(json, /\buser_?id\b/i, "no user id");
  assert.doesNotMatch(json, /password|hash|secret|token/i, "no credential field");
  assert.doesNotMatch(json, /storage_?[Kk]ey/, "no storage key");
  assert.doesNotMatch(json, /correct_?answer["']?\s*:/i, "no answer key");
  assert.doesNotMatch(json, /\/tmp\/|\/home\/|studypal-test-uploads/, "no path");
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, "no stack frame");
  assert.doesNotMatch(json, /generativelanguage|googleapis|GEMINI_API_KEY/i, "no provider");
  assert.doesNotMatch(
    json,
    /SELECT |INSERT |FROM exam_|attempt_answers|study_plan_tasks/i,
    "no SQL",
  );
  assert.doesNotMatch(json, /\b(NaN|Infinity|undefined)\b/, "§18: no NaN, Infinity or undefined");
}

/** §18 again, structurally: walk the body and refuse any non-finite number. */
function assertFiniteNumbers(value, path = "$") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(item, undefined, `${path}.${key} is undefined`);
      assertFiniteNumbers(item, `${path}.${key}`);
    }
  }
}

describe("§2 GET /api/analytics — the overall summary", () => {
  let username;

  before(async () => {
    username = await makeUser("overview");

    const active = await makePlan(username, { title: "Active", status: "active" });
    await makePlan(username, { title: "Done", status: "completed" });
    await makeTasks(active, username, [
      { status: "completed", topic: "Algebra" },
      { status: "completed", topic: "Algebra" },
      { status: "pending", topic: "Geometry" },
      { status: "skipped", topic: null },
    ]);

    // Four completed attempts, oldest first: 25, 50, 75, 100. Enough for §6's
    // trend, which needs four (window = min(5, floor(n/2)) ≥ 2).
    await sitExam(username, { results: [true, false, false, false] }); //  25
    await sitExam(username, { results: [true, true, false, false] }); //   50
    await sitExam(username, { results: [true, true, true, false] }); //    75
    await sitExam(username, { results: [true, true, true, true] }); //    100
    await sitExam(username, { results: [true], status: "in_progress" });
  });

  it("returns a bare object, not a {data: …} envelope (§12)", async () => {
    const body = assertOk(await overview(username));

    assert.equal(Array.isArray(body), false);
    assert.equal(body.data, undefined, "§12: no second response style");
    assert.deepEqual(Object.keys(body).sort(), OVERVIEW_KEYS);
  });

  it("names every field §2 asks for and nothing else", async () => {
    const body = assertOk(await overview(username));

    assert.deepEqual(Object.keys(body.studyPlans).sort(), STUDY_PLAN_KEYS);
    assert.deepEqual(Object.keys(body.tasks).sort(), TASK_KEYS);
    assert.deepEqual(Object.keys(body.exams).sort(), EXAM_KEYS);
    assert.deepEqual(Object.keys(body.trend).sort(), TREND_KEYS);
  });

  it("reports the plan and task totals", async () => {
    const body = assertOk(await overview(username));

    assert.deepEqual(body.studyPlans, {
      total: 2,
      active: 1,
      completed: 1,
      cancelled: 0,
      archived: 0,
    });
    assert.deepEqual(body.tasks, {
      total: 4,
      completed: 2,
      pending: 1,
      inProgress: 0,
      skipped: 1,
      // 2/4. The denominator includes the skipped task: it was scheduled and it
      // is not done, so excluding it would let a learner reach 100% by skipping.
      completionPercentage: 50,
    });
  });

  it("reports the exam and attempt numbers SP-V2-006 persisted (§4)", async () => {
    const body = assertOk(await overview(username));

    assert.deepEqual(body.exams, {
      total: 5,
      attempts: 5,
      completedAttempts: 4,
      inProgressAttempts: 1,
      passed: 2, // 75 and 100
      failed: 2, // 25 and 50
      averagePercentage: 62.5, // (25 + 50 + 75 + 100) / 4
      highestPercentage: 100,
      lowestPercentage: 25,
      mostRecentPercentage: 100,
    });
  });

  it("compares two equal windows and calls the direction (§6)", async () => {
    // Newest first the percentages are [100, 75, 50, 25]; window = 2, so
    // (100 + 75)/2 = 87.5 against (50 + 25)/2 = 37.5, difference +50.
    const body = assertOk(await overview(username));

    assert.deepEqual(body.trend, {
      recentAveragePercentage: 87.5,
      previousAveragePercentage: 37.5,
      difference: 50,
      direction: "up",
    });
  });

  it("uses no language of prediction anywhere in the body (§6, §26)", async () => {
    // §26 forbids "AI predicts the student will fail…" and §6 forbids language
    // suggesting prediction. Asserted over the serialised body, so it covers the
    // field names, the `reason` token and any string value.
    const body = assertOk(await overview(username));

    assert.doesNotMatch(
      JSON.stringify(body),
      /predict|forecast|recommend|suggest|should study|next topic|adaptive/i,
    );
  });

  it("returns only finite numbers (§18)", async () => {
    assertFiniteNumbers(assertOk(await overview(username)));
  });
});

describe("§18 the learner with no data", () => {
  let username;

  before(async () => {
    username = await makeUser("zerodata");
  });

  it("answers 200 with the zero shape, not 404 (§11)", async () => {
    // The aggregate endpoints match GET /api/progress: an unknown or empty
    // learner is "no data", not a missing resource. A 404 here would also
    // confirm to an unauthenticated caller which usernames exist.
    const body = assertOk(await overview(username));

    assert.deepEqual(body.studyPlans, {
      total: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
      archived: 0,
    });
    assert.deepEqual(body.tasks, {
      total: 0,
      completed: 0,
      pending: 0,
      inProgress: 0,
      skipped: 0,
      // null, not 0: nothing was measured. §3 forbids NaN here and this API
      // chooses null over a 0 that would claim a measurement.
      completionPercentage: null,
    });
    assert.equal(body.exams.total, 0);
    assert.equal(body.exams.averagePercentage, null);
    assert.equal(body.exams.highestPercentage, null);
    assert.equal(body.exams.lowestPercentage, null);
    assert.equal(body.exams.mostRecentPercentage, null);
  });

  it("reports no trend rather than omitting the object (§6)", async () => {
    const body = assertOk(await overview(username));

    assert.deepEqual(body.trend, {
      recentAveragePercentage: null,
      previousAveragePercentage: null,
      difference: null,
      direction: null,
    });
  });

  it("returns empty arrays from every collection endpoint", async () => {
    for (const [name, res] of [
      ["exams", await history(username)],
      ["topics", await topics(username)],
      ["weak-areas", await weakAreas(username)],
      ["materials", await materials(username)],
    ]) {
      assert.deepEqual(assertOk(res), [], name);
    }
  });

  it("has the same keys as a populated response", async () => {
    // The point of building the empty overview from zero-valued rows through the
    // same serializers: a client that renders `tasks.completionPercentage` must
    // not have to check whether the field exists for a new learner.
    const populated = await makeUser("populated");
    await sitExam(populated, { results: [true] });

    const empty = assertOk(await overview(username));
    const full = assertOk(await overview(populated));

    assert.deepEqual(Object.keys(empty).sort(), Object.keys(full).sort());
    assert.deepEqual(Object.keys(empty.tasks).sort(), Object.keys(full.tasks).sort());
    assert.deepEqual(Object.keys(empty.exams).sort(), Object.keys(full.exams).sort());
  });

  it("answers the same way for a username that was never created", async () => {
    // The aggregates cannot distinguish "no rows" from "no such user", and do
    // not try to: §11's "Do not leak whether another user's resource exists"
    // applies to usernames too.
    const unknown = `${testUser("ghost")}_never_created`;
    const known = assertOk(await overview(username));
    const ghost = assertOk(await overview(unknown));

    assert.deepEqual(ghost, known);
    assert.deepEqual(assertOk(await history(unknown)), []);
    assert.deepEqual(assertOk(await topics(unknown)), []);
  });

  it("does not create the user it was asked about (§1)", async () => {
    // A GET must not write. POST /api/ask upserts usernames; analytics must
    // not, or reading a dashboard would populate the users table.
    const unknown = `${testUser("ghost")}_stays_absent`;
    await overview(unknown);
    await history(unknown);
    await topics(unknown);
    await weakAreas(unknown);
    await materials(unknown);

    const { rows } = await pool.query(
      "SELECT 1 FROM users WHERE username = $1",
      [unknown],
    );
    assert.equal(rows.length, 0, "analytics created a user row");
  });
});

describe("§5 GET /api/analytics/exams — the history", () => {
  let username;

  before(async () => {
    username = await makeUser("history");
    // Twelve completed attempts, oldest first, so the default limit of 10 is
    // actually exercised rather than being larger than the data.
    for (let i = 0; i < 12; i += 1) {
      await sitExam(username, {
        results: Array.from({ length: 4 }, (_, k) => k <= i % 4),
        title: `Exam ${i + 1}`,
      });
    }
    await sitExam(username, { results: [true], status: "in_progress" });
  });

  it("returns a bare array (§12)", async () => {
    const body = assertOk(await history(username));

    assert.ok(Array.isArray(body));
    assert.deepEqual(Object.keys(body[0]).sort(), HISTORY_KEYS);
  });

  it("defaults to the 10 most recent (§5)", async () => {
    const body = assertOk(await history(username));

    assert.equal(body.length, 10);
    assert.deepEqual(
      body.map((row) => row.examTitle),
      ["Exam 12", "Exam 11", "Exam 10", "Exam 9", "Exam 8",
       "Exam 7", "Exam 6", "Exam 5", "Exam 4", "Exam 3"],
    );
  });

  it("honours a smaller limit", async () => {
    const body = assertOk(await history(username, "&limit=3"));

    assert.equal(body.length, 3);
    assert.deepEqual(body.map((r) => r.examTitle), ["Exam 12", "Exam 11", "Exam 10"]);
  });

  it("clamps an unbounded limit rather than rejecting it (§5)", async () => {
    // §5: "Do not allow an unbounded client-controlled limit. If a limit
    // parameter is supported: validate it, clamp it, establish a safe maximum."
    // The cap is 50 and there are 12 completed attempts, so the observable
    // consequence is that ?limit=100000 returns 12 and not an error — the clamp
    // is asserted directly against config in tests/analytics/architecture.test.js.
    const body = assertOk(await history(username, "&limit=100000"));

    assert.equal(body.length, 12);
  });

  it("excludes attempts that are still in progress (§4)", async () => {
    const body = assertOk(await history(username, "&limit=50"));

    assert.equal(body.length, 12, "13 attempts exist, 12 are completed");
    for (const row of body) {
      assert.equal(row.passed === true || row.passed === false, true);
      assert.notEqual(row.submittedAt, null);
    }
  });

  it("rejects a malformed limit without echoing it (§24)", async () => {
    for (const raw of ["abc", "-1", "0", "1.5", "1e3", "%20", "null"]) {
      const res = await history(username, `&limit=${raw}`);

      assertJsonError(res, 400, "Limit must be a positive integer.");
      assert.doesNotMatch(
        res.body.error,
        new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `the 400 echoed ${raw}`,
      );
    }
  });

  it("rejects a repeated limit parameter", async () => {
    // Express gives `?limit=1&limit=2` as an array. Accepting whichever one it
    // kept would make the bound depend on a framework detail.
    assertJsonError(
      await history(username, "&limit=1&limit=2"),
      400,
      "Limit must be a positive integer.",
    );
  });

  it("does not let a limit reach SQL unparsed (§15)", async () => {
    // The 400 arrives from the validator, so nothing is interpolated and no
    // database error is leaked (§24). The second assertion is the one that
    // matters: the table is still there.
    const res = await history(username, "&limit=1;DROP%20TABLE%20exams");

    assertJsonError(res, 400);
    const { rows } = await pool.query(
      "SELECT to_regclass('exams') IS NOT NULL AS present",
    );
    assert.equal(rows[0].present, true);
  });

  it("returns timestamps as ISO-8601 strings (§17)", async () => {
    const [row] = assertOk(await history(username, "&limit=1"));

    assert.match(row.submittedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(row.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("exposes no answer key (§5)", async () => {
    const body = assertOk(await history(username));
    const json = JSON.stringify(body);

    assert.doesNotMatch(json, /"(?:correctAnswer|selectedAnswer|explanation|options)"\s*:/i);
  });
});

describe("§7 GET /api/analytics/topics", () => {
  let username;

  before(async () => {
    username = await makeUser("topics");
    await sitExam(username, {
      topics: ["Algebra"],
      results: [true, true, true, true, false, false, false, false,
                false, false, false, false],
    }); // 4/12 = 33.33
    await sitExam(username, { topics: ["Geometry"], results: [true, true, true] }); // 100
    await sitExam(username, { topics: ["Calculus"], results: [true, false] }); // 50, 2 attempts
  });

  it("returns a bare array of topic breakdowns (§12)", async () => {
    const body = assertOk(await topics(username));

    assert.ok(Array.isArray(body));
    assert.deepEqual(Object.keys(body[0]).sort(), TOPIC_KEYS);
  });

  it("reports attempted, correct, incorrect and accuracy per topic (§7)", async () => {
    const body = assertOk(await topics(username));

    assert.deepEqual(body, [
      {
        topic: "Algebra",
        questionsAttempted: 12,
        correct: 4,
        incorrect: 8,
        accuracyPercentage: 33.33,
      },
      {
        topic: "Calculus",
        questionsAttempted: 2,
        correct: 1,
        incorrect: 1,
        accuracyPercentage: 50,
      },
      {
        topic: "Geometry",
        questionsAttempted: 3,
        correct: 3,
        incorrect: 0,
        accuracyPercentage: 100,
      },
    ]);
  });

  it("keeps correct + incorrect equal to questionsAttempted", async () => {
    for (const row of assertOk(await topics(username))) {
      assert.equal(row.correct + row.incorrect, row.questionsAttempted, row.topic);
    }
  });

  it("orders by topic name", async () => {
    assert.deepEqual(
      (await topics(username)).body.map((row) => row.topic),
      ["Algebra", "Calculus", "Geometry"],
    );
  });
});

describe("§9 and §10 GET /api/analytics/weak-areas", () => {
  let username;

  before(async () => {
    username = await makeUser("weak");
    // Algebra   3 attempts,   0% → weak (§22 case 2)
    // Geometry  5 attempts,  60% → NOT weak (§22 case 4, the strict comparison)
    // Calculus  2 attempts,   0% → NOT weak (§22 case 1, insufficient evidence)
    // Statistics 8 attempts, 25% → weak, and more questions than Algebra
    // Physics   4 attempts, 100% → NOT weak (§22 case 6)
    await sitExam(username, { topics: ["Algebra"], results: [false, false, false] });
    await sitExam(username, {
      topics: ["Geometry"],
      results: [true, true, true, false, false],
    });
    await sitExam(username, { topics: ["Calculus"], results: [false, false] });
    await sitExam(username, {
      topics: ["Statistics"],
      results: [true, true, false, false, false, false, false, false],
    });
    await sitExam(username, { topics: ["Physics"], results: [true, true, true, true] });
  });

  it("returns a bare array carrying the reason token (§10)", async () => {
    const body = assertOk(await weakAreas(username));

    assert.ok(Array.isArray(body));
    assert.deepEqual(Object.keys(body[0]).sort(), WEAK_AREA_KEYS);
    for (const row of body) {
      assert.equal(row.reason, "accuracy_below_threshold");
    }
  });

  it("includes only topics with enough evidence below the threshold (§9)", async () => {
    const body = assertOk(await weakAreas(username));

    assert.deepEqual(body.map((row) => row.topic), ["Algebra", "Statistics"]);
  });

  it("excludes exactly 60%, above 60%, 100% and thin evidence (§22)", async () => {
    const listed = new Set(
      (await weakAreas(username)).body.map((row) => row.topic),
    );

    assert.equal(listed.has("Geometry"), false, "60% is not weak");
    assert.equal(listed.has("Physics"), false, "100% is not weak");
    assert.equal(listed.has("Calculus"), false, "2 attempts is not evidence");
  });

  it("orders by lowest accuracy, then most questions, then name (§10)", async () => {
    // Algebra 0% before Statistics 25%, even though Statistics has more
    // questions — accuracy is the first key.
    const body = assertOk(await weakAreas(username));

    assert.deepEqual(
      body.map((row) => [row.topic, row.accuracyPercentage, row.questionsAttempted]),
      [
        ["Algebra", 0, 3],
        ["Statistics", 25, 8],
      ],
    );
  });

  it("orders ties deterministically across repeated requests (§10)", async () => {
    // Three topics at the same accuracy and the same question count, so only the
    // name tie-breaker can decide — and the same request must give the same
    // sequence every time, which a GROUP BY without a total order would not.
    const tied = await makeUser("ties");
    for (const topic of ["Mechanics", "Optics", "Acoustics"]) {
      await sitExam(tied, { topics: [topic], results: [true, false, false, false] });
    }

    const first = assertOk(await weakAreas(tied)).map((row) => row.topic);
    const second = assertOk(await weakAreas(tied)).map((row) => row.topic);

    assert.deepEqual(first, ["Acoustics", "Mechanics", "Optics"]);
    assert.deepEqual(second, first);
  });

  it("reports the same counts the topics endpoint reports", async () => {
    // The weak-area list is built from the topic breakdown, not from a second
    // query, so a topic cannot appear with one accuracy here and another there.
    const weak = assertOk(await weakAreas(username));
    const all = new Map(
      assertOk(await topics(username)).map((row) => [row.topic, row]),
    );

    for (const row of weak) {
      const source = all.get(row.topic);
      assert.ok(source, `${row.topic} is not in the topic breakdown`);
      assert.equal(row.questionsAttempted, source.questionsAttempted);
      assert.equal(row.correct, source.correct);
      assert.equal(row.incorrect, source.incorrect);
      assert.equal(row.accuracyPercentage, source.accuracyPercentage);
    }
  });

  it("offers no recommendation, no ranking language and no next step (§26)", async () => {
    // §26: SP-V2-007 must not say "Study this topic next", must not rank the
    // learner, and must not produce advice. The response is counts, an accuracy
    // and a machine-readable reason — asserted over the whole body so a helpful
    // future `message` field fails here.
    const json = JSON.stringify(assertOk(await weakAreas(username)));

    assert.doesNotMatch(
      json,
      /recommend|suggest|should|next|advice|priorit|focus|improve|weakness score|rank/i,
    );
  });

  it("is empty when nothing meets the rule", async () => {
    const strong = await makeUser("strong");
    await sitExam(strong, { topics: ["Algebra"], results: [true, true, true, true] });

    assert.deepEqual(assertOk(await weakAreas(strong)), []);
  });
});

describe("§8 GET /api/analytics/materials", () => {
  let username;
  let kept;

  before(async () => {
    username = await makeUser("materials");
    kept = await makeMaterial(username, "kept.pdf");
    const doomed = await makeMaterial(username, "doomed.pdf");

    await sitExam(username, {
      results: [true, true, false, true],
      sources: [kept, kept, doomed, doomed],
    });
    await sitExam(username, { results: [false], sources: [null] });

    await pool.query("DELETE FROM materials WHERE id = $1", [doomed]);
  });

  it("returns a bare array with the material's id and filename (§8)", async () => {
    const body = assertOk(await materials(username));

    assert.ok(Array.isArray(body));
    assert.deepEqual(Object.keys(body[0]).sort(), MATERIAL_KEYS);
    assert.deepEqual(body[0], {
      materialId: kept,
      filename: "kept.pdf",
      questionsAttempted: 2,
      correct: 2,
      incorrect: 0,
      accuracyPercentage: 100,
    });
  });

  it("represents lost attribution as null, with no invented metadata (§8)", async () => {
    // The deleted material's two answers join the one ungrounded answer in a
    // single null-attributed row. §8: "Do not pretend deleted-material
    // attribution still exists… Do not recreate deleted material metadata."
    const body = assertOk(await materials(username));
    const unattributed = body.find((row) => row.materialId === null);

    assert.ok(unattributed, "the unattributed group is missing");
    assert.equal(unattributed.filename, null);
    assert.equal(unattributed.questionsAttempted, 3);
    assert.equal(unattributed.correct, 1);
    assert.doesNotMatch(JSON.stringify(body), /doomed\.pdf|deleted|unknown material/i);
  });

  it("accounts for every answered question across the rows", async () => {
    const body = assertOk(await materials(username));

    assert.equal(
      body.reduce((sum, row) => sum + row.questionsAttempted, 0),
      5,
      "four answers on the first exam plus one on the second",
    );
  });

  it("returns the material id as a number, not a BIGINT string (§16)", async () => {
    const [row] = assertOk(await materials(username));

    assert.equal(typeof row.materialId, "number");
  });

  it("never exposes a storage key (§24)", async () => {
    const body = assertOk(await materials(username));

    assert.doesNotMatch(JSON.stringify(body), /"(?:storageKey|storage_key)"\s*:/);
  });
});

describe("§3 GET /api/analytics/study-plans/:id", () => {
  let username;
  let planId;

  before(async () => {
    username = await makeUser("planprogress");
    planId = await makePlan(username, { title: "Finals", subject: "Physics" });
    await makeTasks(planId, username, [
      { status: "completed", topic: "Kinematics" },
      { status: "completed", topic: "Kinematics" },
      { status: "completed", topic: "Optics" },
      { status: "pending", topic: "Optics" },
      { status: "in_progress", topic: null },
    ]);
  });

  it("returns the plan, its task counts and its topics (§3)", async () => {
    const body = assertOk(await planProgress(planId, username));

    assert.deepEqual(Object.keys(body).sort(), PLAN_PROGRESS_KEYS);
    assert.equal(body.planId, planId);
    assert.equal(body.title, "Finals");
    assert.equal(body.status, "active");
    assert.deepEqual(body.tasks, {
      total: 5,
      completed: 3,
      pending: 1,
      inProgress: 1,
      skipped: 0,
      completionPercentage: 60, // 3/5
    });
  });

  it("breaks the progress down by topic, nulls last (§3)", async () => {
    const body = assertOk(await planProgress(planId, username));

    assert.deepEqual(Object.keys(body.topics[0]).sort(), PLAN_TOPIC_KEYS);
    assert.deepEqual(body.topics, [
      {
        topic: "Kinematics",
        totalTasks: 2,
        completedTasks: 2,
        completionPercentage: 100,
      },
      { topic: "Optics", totalTasks: 2, completedTasks: 1, completionPercentage: 50 },
      { topic: null, totalTasks: 1, completedTasks: 0, completionPercentage: 0 },
    ]);
  });

  it("returns null, never NaN, for a plan with no tasks (§3, §18)", async () => {
    const bare = await makePlan(username, { title: "Nothing scheduled" });
    const body = assertOk(await planProgress(bare, username));

    assert.equal(body.tasks.total, 0);
    assert.equal(body.tasks.completionPercentage, null);
    assert.deepEqual(body.topics, []);
    assert.doesNotMatch(JSON.stringify(body), /NaN|Infinity|null,null/);
    assertFiniteNumbers(body);
  });

  it("returns dates as 'YYYY-MM-DD', unshifted (§17)", async () => {
    const body = assertOk(await planProgress(planId, username));

    assert.equal(body.startDate, "2026-01-01");
    assert.equal(body.endDate, "2026-01-31");
    assert.equal(body.examDate, "2026-02-05");
  });

  it("404s for a plan that does not exist", async () => {
    assertJsonError(
      await planProgress(999_999_999, username),
      404,
      "Study plan not found.",
    );
  });

  it("404s identically for an unknown username (§11)", async () => {
    // The same 404 and the same message as the absent plan, so the pair of
    // responses cannot be used to tell which of the two was wrong.
    const absent = await planProgress(planId, `${testUser("ghost")}_unknown`);

    assertJsonError(absent, 404, "Study plan not found.");
  });

  it("rejects a malformed id before touching the database", async () => {
    for (const raw of ["abc", "0", "-1", "1.5", "12abc", "%20"]) {
      assertJsonError(
        await server.request(
          "GET",
          `/api/analytics/study-plans/${raw}?${q(username)}`,
        ),
        400,
        "Study plan id must be a positive integer.",
      );
    }
  });

  it("validates the id before the username, so the specific error wins", async () => {
    const res = await server.request("GET", "/api/analytics/study-plans/abc");

    assertJsonError(res, 400, "Study plan id must be a positive integer.");
  });
});

describe("§11 ownership, through HTTP, in both directions", () => {
  let alice;
  let bob;
  let alicePlan;
  let bobPlan;

  before(async () => {
    alice = await makeUser("alice");
    bob = await makeUser("bob");

    alicePlan = await makePlan(alice, { title: "Alice's plan" });
    await makeTasks(alicePlan, alice, [{ status: "completed", topic: "Algebra" }]);

    bobPlan = await makePlan(bob, { title: "Bob's plan" });
    await makeTasks(bobPlan, bob, [
      { status: "pending", topic: "Geometry" },
      { status: "pending", topic: "Geometry" },
    ]);

    const aliceMaterial = await makeMaterial(alice, "alice.pdf");
    await sitExam(alice, {
      topics: ["Algebra"],
      results: [false, false, false],
      sources: Array(3).fill(aliceMaterial),
      title: "Alice's exam",
    });

    const bobMaterial = await makeMaterial(bob, "bob.pdf");
    await sitExam(bob, {
      topics: ["Geometry"],
      results: [true, true, true, true],
      sources: Array(4).fill(bobMaterial),
      title: "Bob's exam",
    });
  });

  it("gives each learner only their own overview (§24)", async () => {
    const aliceBody = assertOk(await overview(alice));
    const bobBody = assertOk(await overview(bob));

    assert.equal(aliceBody.exams.averagePercentage, 0, "Alice got everything wrong");
    assert.equal(bobBody.exams.averagePercentage, 100, "Bob got everything right");
    assert.equal(aliceBody.tasks.total, 1);
    assert.equal(bobBody.tasks.total, 2);
  });

  it("gives each learner only their own history", async () => {
    assert.deepEqual(
      assertOk(await history(alice)).map((row) => row.examTitle),
      ["Alice's exam"],
    );
    assert.deepEqual(
      assertOk(await history(bob)).map((row) => row.examTitle),
      ["Bob's exam"],
    );
  });

  it("gives each learner only their own topics and weak areas", async () => {
    assert.deepEqual(
      assertOk(await topics(alice)).map((row) => row.topic),
      ["Algebra"],
    );
    assert.deepEqual(
      assertOk(await topics(bob)).map((row) => row.topic),
      ["Geometry"],
    );
    assert.deepEqual(
      assertOk(await weakAreas(alice)).map((row) => row.topic),
      ["Algebra"],
    );
    assert.deepEqual(
      assertOk(await weakAreas(bob)).map((row) => row.topic),
      [],
      "Bob has no weak areas, and must not inherit Alice's",
    );
  });

  it("gives each learner only their own materials", async () => {
    assert.deepEqual(
      assertOk(await materials(alice)).map((row) => row.filename),
      ["alice.pdf"],
    );
    assert.deepEqual(
      assertOk(await materials(bob)).map((row) => row.filename),
      ["bob.pdf"],
    );
  });

  it("404s when a learner asks for the other's plan, with the same body (§11)", async () => {
    // Knowing an id is not authorisation. 404 rather than 403, and the same
    // message as an absent plan, so the response says nothing about whether the
    // plan exists.
    const stranger = await planProgress(bobPlan, alice);
    const absent = await planProgress(999_999_997, alice);

    assertJsonError(stranger, 404, "Study plan not found.");
    assert.deepEqual(stranger.body, absent.body);

    assertJsonError(await planProgress(alicePlan, bob), 404, "Study plan not found.");
  });

  it("still serves each learner their own plan", async () => {
    // The control for the assertions above: they would all pass if the endpoint
    // 404'd for everyone.
    assert.equal(
      assertOk(await planProgress(alicePlan, alice)).title,
      "Alice's plan",
    );
    assert.equal(assertOk(await planProgress(bobPlan, bob)).title, "Bob's plan");
  });
});

describe("§13 and §24 the route surface", () => {
  let username;

  before(async () => {
    username = await makeUser("surface");
  });

  it("requires a username on every endpoint (§11)", async () => {
    for (const endpoint of ALL_ENDPOINTS) {
      assertJsonError(
        await server.request("GET", endpoint.path()),
        400,
        "Username is required.",
      );
    }
  });

  it("rejects a blank or whitespace username", async () => {
    for (const raw of ["", "%20", "%09"]) {
      assertJsonError(
        await server.request("GET", `/api/analytics?username=${raw}`),
        400,
        "Username is required.",
      );
    }
  });

  it("rejects an over-long username without echoing it", async () => {
    const res = await server.request(
      "GET",
      `/api/analytics?username=${"a".repeat(500)}`,
    );

    assert.equal(res.status, 400);
    assert.match(res.body.error, /^Username must be \d+ characters or fewer\.$/);
    assert.doesNotMatch(res.body.error, /aaaa/);
  });

  it("answers 200 for every endpoint given a valid username", async () => {
    // The positive control for the 400s above, and a check that all six routes
    // are actually mounted — a typo in src/routes/index.js would make these 404.
    const planId = await makePlan(username);

    for (const endpoint of ALL_ENDPOINTS) {
      const res = await server.request(
        "GET",
        `${endpoint.path(planId)}?${q(username)}`,
      );
      assert.equal(res.status, 200, `${endpoint.name}: ${res.status} ${res.text}`);
    }
  });

  it("accepts no verb but GET under /api/analytics (§1)", async () => {
    // §1 makes analytics a read-only consumer, and the router has only GETs.
    // Express answers 404 for a path it has no handler for, which is what a
    // client sees — and what must keep being seen if someone adds a POST here
    // by accident.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [
        "/api/analytics",
        "/api/analytics/exams",
        "/api/analytics/topics",
        "/api/analytics/weak-areas",
        "/api/analytics/materials",
        "/api/analytics/study-plans/1",
      ]) {
        const res = await server.request(method, `${path}?${q(username)}`, {
          json: { username },
        });

        assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
      }
    }
  });

  it("has no recommendation endpoint (§26)", async () => {
    // §1: "It must NOT decide what the student should study next." §26 lists
    // the four things not to build. The absence is asserted rather than assumed
    // because a route added later would be the first sign of the boundary moving.
    for (const path of [
      "/api/analytics/recommendations",
      "/api/analytics/suggestions",
      "/api/analytics/next",
      "/api/analytics/study-next",
      "/api/analytics/predictions",
      "/api/analytics/adaptive-plan",
    ]) {
      const res = await server.request("GET", `${path}?${q(username)}`);

      assert.equal(res.status, 404, `${path} exists`);
    }
  });

  it("leaks no database error when a query parameter is hostile (§24)", async () => {
    for (const raw of [
      "' OR 1=1 --",
      "'; DROP TABLE users; --",
      "admin'/**/UNION/**/SELECT/**/1",
      "\u0000",
    ]) {
      const res = await server.request(
        "GET",
        `/api/analytics?username=${encodeURIComponent(raw)}`,
      );

      // A username is a value, not an identifier: it binds as a parameter, finds
      // nothing, and the zero-data shape comes back. What must never come back
      // is a PostgreSQL error, and assertNoInternals is where that is checked.
      assert.ok(
        res.status === 200 || res.status === 400,
        `${raw} produced ${res.status}: ${res.text}`,
      );
      assertNoInternals(res.body);
    }

    const { rows } = await pool.query(
      "SELECT to_regclass('users') IS NOT NULL AS present",
    );
    assert.equal(rows[0].present, true);
  });

  it("returns only finite numbers from every endpoint (§18)", async () => {
    // The whole of §18's "Never return: NaN Infinity undefined", applied to one
    // learner whose data is deliberately lopsided: a plan with no tasks, an exam
    // with one answered question, and an in-progress attempt.
    const edge = await makeUser("edge");
    const bare = await makePlan(edge);
    await sitExam(edge, { results: [false], unanswered: 4 });
    await sitExam(edge, { results: [true], status: "in_progress" });

    for (const endpoint of ALL_ENDPOINTS) {
      const res = await server.request("GET", `${endpoint.path(bare)}?${q(edge)}`);

      assert.equal(res.status, 200, endpoint.name);
      assertFiniteNumbers(res.body, `$(${endpoint.name})`);
      assertNoInternals(res.body);
    }
  });

  it("writes nothing, whatever is asked of it (§1)", async () => {
    // The structural claim, checked from outside: every row count in every table
    // analytics reads is unchanged by a full sweep of every endpoint. A hidden
    // upsert, a status recompute or a cached-metric INSERT would move one.
    const tables = [
      "users",
      "study_plans",
      "study_plan_tasks",
      "exams",
      "exam_questions",
      "exam_attempts",
      "attempt_answers",
      "materials",
    ];
    const census = async () => {
      const counts = {};
      for (const table of tables) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        counts[table] = rows[0].n;
      }
      return counts;
    };

    const populated = await makeUser("readonly");
    const planId = await makePlan(populated);
    await makeTasks(planId, populated, [{ status: "pending" }]);
    await sitExam(populated, { results: [true, false] });

    const before = await census();

    for (const endpoint of ALL_ENDPOINTS) {
      await server.request("GET", `${endpoint.path(planId)}?${q(populated)}`);
    }
    await history(populated, "&limit=50");
    await overview(`${testUser("ghost")}_readonly`);

    assert.deepEqual(await census(), before);
  });
});
