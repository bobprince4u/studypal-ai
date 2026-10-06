/**
 * The analytics SQL, against a real PostgreSQL (§21).
 *
 * §21: "Use real PostgreSQL for repository/database tests. Do NOT introduce
 * SQLite." Every assertion below runs against an isolated database created from
 * the same migrations production uses, seeded with direct INSERTs in the style
 * of tests/exams/schema.test.js — so a query's answer is a property of the SQL
 * and the schema, not of a mock that agrees with it.
 *
 * WHY THE FIXTURES ARE WRITTEN WITH SQL AND NOT THROUGH THE SERVICES
 * -----------------------------------------------------------------
 * Seeding through POST /api/exams would need a generation call per exam, and
 * seeding through the exam service would make each analytics assertion depend on
 * SP-V2-006 behaving — a failure would not say which layer broke. Direct INSERTs
 * make the input to each aggregate a literal in the test, which is what lets the
 * expected COUNT be arithmetic a reader can check.
 *
 * The seeds are still *legal*: every row below satisfies the CHECK constraints
 * 004_study_plans.sql and 005_exams.sql declare, including
 * exam_attempts_result_matches_status — so no fixture here describes a state the
 * application could not produce. The one deliberate exception is marked where it
 * appears (an in-progress attempt carrying answer rows), and it exists to prove
 * a WHERE clause is doing work rather than being covered accidentally by the
 * shape of realistic data.
 *
 * OWNERSHIP IS ASSERTED IN BOTH DIRECTIONS, PER AGGREGATE
 * -------------------------------------------------------
 * §21 asks for "User A cannot see User B, User B cannot see User A" and §24 adds
 * that "a query returning COUNT(*) AVG(...) SUM(...) is still a data-isolation
 * boundary". So the isolation block below does not check one endpoint — it walks
 * every exported read function with two fully-populated learners and asserts
 * each answer is unchanged by the other's existence.
 *
 *   node --test tests/analytics/repository.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { useIsolatedDatabase } from "../helpers/test-database.mjs";

// ── wiring ──────────────────────────────────────────────────────────────────
//
// The isolated database is claimed BEFORE src/config/env.js is imported, the
// arrangement tests/materials/retrieval.test.js uses: `useIsolatedDatabase`
// points STUDYPAL_TEST_DATABASE_URL at a fresh database, and the config module
// reads that once at import time. A static import would run first and the
// application pool would open against the shared development database.

const database = await useIsolatedDatabase({ label: "analyticsrepo" });

const { config } = await import("../../src/config/env.js");
const db = await import("../../src/config/database.js");
const repository = await import("../../src/analytics/analytics.repository.js");

assert.equal(
  config.database.url,
  database.url,
  "the application pool must be pointing at this suite's isolated database",
);

after(async () => {
  await db.closeDatabase();
  await database.drop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let sequence = 0;

/** A unique-per-row suffix, so fixtures never collide across describe blocks. */
function unique() {
  sequence += 1;
  return `${sequence}_${Date.now().toString(36)}`;
}

async function makeUser(prefix = "learner") {
  const { rows } = await db.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [`${prefix}_${unique()}`],
  );
  return rows[0].id;
}

async function makeMaterial(userId, { filename = "notes.pdf" } = {}) {
  const { rows } = await db.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size, status)
     VALUES ($1, $2, $3, 'application/pdf', 4096, 'ready')
     RETURNING id`,
    [userId, filename, `${unique().replace(/\W/g, "")}.pdf`.padStart(12, "a")],
  );
  return rows[0].id;
}

async function makePlan(
  userId,
  { status = "active", title = "Plan", subject = "Maths" } = {},
) {
  const { rows } = await db.query(
    `INSERT INTO study_plans
            (user_id, title, subject, goal, start_date, end_date, exam_date,
             daily_minutes, difficulty_level, status, topics, study_days)
     VALUES ($1, $2, $3, 'Pass the exam', '2026-01-01', '2026-01-31',
             '2026-02-05', 60, 'intermediate', $4, ARRAY['Algebra']::text[],
             ARRAY['monday', 'wednesday']::text[])
     RETURNING id`,
    [userId, title, subject, status],
  );
  return rows[0].id;
}

/**
 * Tasks for a plan, one per entry.
 *
 * `scheduled_date` and `position` are generated rather than passed: the
 * aggregates under test group by status and by topic and never by date, and
 * study_plan_tasks_slot_key makes an unthought-out pair a constraint violation
 * rather than a test failure.
 */
async function makeTasks(planId, userId, entries) {
  for (const [index, entry] of entries.entries()) {
    await db.query(
      `INSERT INTO study_plan_tasks
              (study_plan_id, user_id, scheduled_date, position, title, topic,
               task_type, duration_minutes, status)
       VALUES ($1, $2, '2026-01-05'::date + $3::int, $3, $4, $5, 'study', 45, $6)`,
      [
        planId,
        userId,
        index,
        entry.title ?? `Task ${index + 1}`,
        entry.topic ?? null,
        entry.status ?? "pending",
      ],
    );
  }
}

/**
 * An exam, its questions, one attempt and the answers for it.
 *
 * `results` is one boolean per ANSWERED question, so `[true, true, false]` means
 * a three-question paper with two right. `unanswered` adds questions to the
 * paper that get no attempt_answers row — the state SP-V2-006's grader produces
 * when a learner skips one, and the reason the topic denominator is "attempted"
 * rather than "on the paper".
 *
 * `sources` aligns with `results`: each entry is the material id for that
 * question, or null for an ungrounded one.
 *
 * The attempt's stored result columns are computed here the way src/exams/
 * grader.js computes them — over every question on the paper, not just the
 * answered ones — because §4 requires analytics to read SP-V2-006's persisted
 * verdict, and a fixture that stored a different percentage would be testing a
 * grading rule this phase does not own.
 */
async function sitExam(
  userId,
  {
    topics = ["Algebra"],
    results = [true],
    unanswered = 0,
    sources = [],
    submittedAt = null,
    status = "completed",
    passed = null,
    title = "Mock exam",
    subject = "Maths",
    examStatus = "ready",
  } = {},
) {
  const total = results.length + unanswered;
  const correct = results.filter(Boolean).length;
  const percentage = Math.round((correct / total) * 100);
  const sourceType = sources.some((id) => id !== null && id !== undefined)
    ? "material"
    : "topics";

  const { rows: examRows } = await db.query(
    `INSERT INTO exams
            (user_id, title, subject, difficulty, question_count, status,
             source_type, topics)
     VALUES ($1, $2, $3, 'medium', $4, $5, $6, $7::text[])
     RETURNING id`,
    [userId, title, subject, total, examStatus, sourceType, topics],
  );
  const examId = examRows[0].id;

  const questionIds = [];
  for (let order = 1; order <= total; order += 1) {
    const { rows } = await db.query(
      `INSERT INTO exam_questions
              (exam_id, user_id, question_order, question_type, question_text,
               options, correct_answer, explanation, source_material_id)
       VALUES ($1, $2, $3, 'multiple_choice', $4,
               '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
               'a', 'Because.', $5)
       RETURNING id`,
      [examId, userId, order, `Question ${order}?`, sources[order - 1] ?? null],
    );
    questionIds.push(rows[0].id);
  }

  // A completed attempt carries all five result columns; an in-progress one
  // carries none of them. exam_attempts_result_matches_status enforces both, so
  // this branch is the schema's rule and not a choice made here.
  const { rows: attemptRows } =
    status === "completed"
      ? await db.query(
          `INSERT INTO exam_attempts
                  (exam_id, user_id, status, started_at, submitted_at, score,
                   total_questions, correct_answers, percentage, passed)
           VALUES ($1, $2, 'completed', $3::timestamptz - interval '20 minutes',
                   $3::timestamptz, $4, $5, $4, $6, $7)
           RETURNING id`,
          [
            examId,
            userId,
            submittedAt ?? nextSubmittedAt(),
            correct,
            total,
            percentage,
            passed ?? percentage >= 60,
          ],
        )
      : await db.query(
          `INSERT INTO exam_attempts (exam_id, user_id, status)
           VALUES ($1, $2, 'in_progress')
           RETURNING id`,
          [examId, userId],
        );
  const attemptId = attemptRows[0].id;

  for (const [index, isCorrect] of results.entries()) {
    await db.query(
      `INSERT INTO attempt_answers
              (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
       VALUES ($1, $2, $3, $4, $5)`,
      [attemptId, userId, questionIds[index], isCorrect ? "a" : "b", isCorrect],
    );
  }

  return { examId, attemptId, questionIds, percentage, total, correct };
}

/**
 * Successive submission timestamps, one minute apart and ascending.
 *
 * Fixed base rather than `new Date()`: §17 forbids reconstructing historical
 * events from server time, and a test whose ordering depends on when it ran is a
 * test that can pass for the wrong reason. Ascending means "seeded later" is
 * "submitted later", so a history assertion reads in reverse seed order.
 */
let submittedAtTick = 0;
function nextSubmittedAt() {
  submittedAtTick += 1;
  return new Date(Date.UTC(2026, 0, 1, 9, submittedAtTick, 0)).toISOString();
}

describe("§2 study-plan totals", () => {
  let userId;

  before(async () => {
    userId = await makeUser("plans");
    await makePlan(userId, { status: "active" });
    await makePlan(userId, { status: "completed" });
    await makePlan(userId, { status: "completed" });
    await makePlan(userId, { status: "cancelled" });
    await makePlan(userId, { status: "archived" });
  });

  it("counts every state the schema allows", async () => {
    assert.deepEqual(await repository.findStudyPlanTotals(userId), {
      total: 5,
      active: 1,
      completed: 2,
      cancelled: 1,
      archived: 1,
    });
  });

  it("returns a row of zeros for a learner with nothing (§18)", async () => {
    // Not undefined, and not an empty array. An aggregate with no GROUP BY
    // returns one row over zero input rows, which is why the service needs no
    // branch for this case — and why this assertion is about SQL, not about JS.
    const empty = await makeUser("noplans");

    assert.deepEqual(await repository.findStudyPlanTotals(empty), {
      total: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
      archived: 0,
    });
  });
});

describe("§2 task totals", () => {
  let userId;

  before(async () => {
    userId = await makeUser("tasks");
    const first = await makePlan(userId, { title: "First" });
    const second = await makePlan(userId, { title: "Second" });

    await makeTasks(first, userId, [
      { status: "completed" },
      { status: "completed" },
      { status: "pending" },
      { status: "in_progress" },
    ]);
    await makeTasks(second, userId, [
      { status: "completed" },
      { status: "skipped" },
      { status: "pending" },
    ]);
  });

  it("counts tasks across every plan the learner owns", async () => {
    assert.deepEqual(await repository.findTaskTotals(userId), {
      total: 7,
      completed: 3,
      pending: 2,
      in_progress: 1,
      skipped: 1,
    });
  });

  it("is zero for plans that have no tasks (§18)", async () => {
    // §18's "study plans but no tasks". The inner JOIN produces no rows, and
    // COUNT(t.id) over no rows is 0 — so this is the case where counting
    // `COUNT(*)` instead of `COUNT(t.id)` would still be right, and the plan
    // aggregate below is where it would not.
    const planless = await makeUser("emptyplans");
    await makePlan(planless);

    assert.deepEqual(await repository.findTaskTotals(planless), {
      total: 0,
      completed: 0,
      pending: 0,
      in_progress: 0,
      skipped: 0,
    });
  });

  it("is zero for a learner with no plans at all", async () => {
    const nobody = await makeUser("notasks");

    assert.equal((await repository.findTaskTotals(nobody)).total, 0);
  });
});

describe("§2 exam totals", () => {
  it("counts every exam, cancelled ones included", async () => {
    // The field answers "how many exams have I made". Filtering by status would
    // answer "how many can I still sit", which §2 does not ask for — and which
    // would make the number shrink when a learner retires an old exam.
    const userId = await makeUser("exams");
    await sitExam(userId, { results: [true] });
    await sitExam(userId, { results: [false], examStatus: "cancelled" });

    assert.deepEqual(await repository.findExamTotals(userId), { total: 2 });
  });

  it("is zero for a learner with nothing", async () => {
    assert.deepEqual(await repository.findExamTotals(await makeUser("noexams")), {
      total: 0,
    });
  });
});

describe("§4 attempt totals", () => {
  let userId;

  before(async () => {
    userId = await makeUser("attempts");
    // Four completed at 100, 50, 80, 20 and one still in progress.
    await sitExam(userId, { results: [true, true] }); // 100, passed
    await sitExam(userId, { results: [true, false] }); //  50, failed
    await sitExam(userId, { results: [true, true, true, true, false] }); // 80, passed
    await sitExam(userId, { results: [true, false, false, false, false] }); // 20, failed
    await sitExam(userId, { results: [true], status: "in_progress" });
  });

  it("separates attempts from completed attempts (§4)", async () => {
    const totals = await repository.findAttemptTotals(userId);

    assert.equal(totals.attempts, 5, "every sitting, finished or not");
    assert.equal(totals.completed_attempts, 4);
    assert.equal(totals.in_progress_attempts, 1);
  });

  it("counts failures as NOT passed, never as total minus passed", async () => {
    // §4: "Do not silently treat an abandoned attempt as a failed exam."
    // `attempts - passed` would be 5 - 2 = 3 here, counting the unfinished
    // sitting as a failure. The FILTER gives 2, which is the number of attempts
    // this learner actually failed.
    const totals = await repository.findAttemptTotals(userId);

    assert.equal(totals.passed_attempts, 2);
    assert.equal(totals.failed_attempts, 2);
    assert.equal(
      totals.passed_attempts + totals.failed_attempts,
      totals.completed_attempts,
      "the two verdicts must partition the completed attempts",
    );
  });

  it("averages, maxes and mins over completed attempts only", async () => {
    // (100 + 50 + 80 + 20) / 4 = 62.5. The in-progress attempt has NULL in
    // every result column, so it could not move these numbers even without the
    // FILTER — the FILTER is what stops `attempts` and these from disagreeing.
    const totals = await repository.findAttemptTotals(userId);

    assert.equal(totals.average_percentage, 62.5);
    assert.equal(totals.highest_percentage, 100);
    assert.equal(totals.lowest_percentage, 20);
  });

  it("returns numbers, not strings, whatever parsers are registered", async () => {
    // The `::int` and `::double precision` casts the repository header explains.
    // A COUNT arriving as "4" would satisfy every assertion above under ==, and
    // would reach §18's finiteness checks as a string that quietly fails them.
    const totals = await repository.findAttemptTotals(userId);

    for (const [column, value] of Object.entries(totals)) {
      assert.equal(typeof value, "number", `${column} was ${typeof value}`);
    }
  });

  it("gives null averages for a learner with only unfinished attempts (§18)", async () => {
    // §18's "incomplete attempts only". Not 0 — a 0 here would be a claim that
    // the learner scored nothing, and they have not yet scored at all.
    const unfinished = await makeUser("unfinished");
    await sitExam(unfinished, { results: [true], status: "in_progress" });

    const totals = await repository.findAttemptTotals(unfinished);

    assert.equal(totals.attempts, 1);
    assert.equal(totals.completed_attempts, 0);
    assert.equal(totals.average_percentage, null);
    assert.equal(totals.highest_percentage, null);
    assert.equal(totals.lowest_percentage, null);
  });

  it("gives zeros and nulls for a learner with no attempts", async () => {
    // §18's "exams but no attempts": the exam exists, nothing has been sat.
    const untried = await makeUser("untried");
    await db.query(
      `INSERT INTO exams (user_id, title, subject, difficulty, question_count,
                          source_type, topics)
       VALUES ($1, 'Untouched', 'Maths', 'easy', 5, 'topics', ARRAY['Algebra'])`,
      [untried],
    );

    assert.deepEqual(await repository.findAttemptTotals(untried), {
      attempts: 0,
      completed_attempts: 0,
      in_progress_attempts: 0,
      passed_attempts: 0,
      failed_attempts: 0,
      average_percentage: null,
      highest_percentage: null,
      lowest_percentage: null,
    });
  });

  it("reports one completed attempt without averaging it away (§18)", async () => {
    const once = await makeUser("once");
    await sitExam(once, { results: [true, true, true, false] }); // 75

    const totals = await repository.findAttemptTotals(once);

    assert.equal(totals.completed_attempts, 1);
    assert.equal(totals.average_percentage, 75);
    assert.equal(totals.highest_percentage, 75);
    assert.equal(totals.lowest_percentage, 75);
  });
});

describe("§5 the recent completed attempts", () => {
  let userId;
  let sat;

  before(async () => {
    userId = await makeUser("history");
    // Seeded oldest-first, so the expected order below is the reverse of this.
    sat = [];
    for (const results of [
      [true, false], //  50
      [true, true], //  100
      [false, false], //  0
      [true, true, true, false], // 75
    ]) {
      sat.push(await sitExam(userId, { results }));
    }
    await sitExam(userId, { results: [true], status: "in_progress" });
  });

  it("returns the newest first", async () => {
    const rows = await repository.findRecentCompletedAttempts(userId, 10);

    assert.deepEqual(
      rows.map((row) => row.percentage),
      [75, 0, 100, 50],
    );
  });

  it("excludes attempts that are still in progress (§4)", async () => {
    const rows = await repository.findRecentCompletedAttempts(userId, 10);

    assert.equal(rows.length, 4, "five attempts exist, four are completed");
    for (const row of rows) {
      assert.notEqual(row.submitted_at, null);
    }
  });

  it("returns no more rows than the limit it was given (§5)", async () => {
    const rows = await repository.findRecentCompletedAttempts(userId, 2);

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.percentage),
      [75, 0],
      "the bound must keep the newest, not an arbitrary two",
    );
  });

  it("binds the limit rather than interpolating it (§15)", async () => {
    // The statement says `LIMIT $2`. If it were built by interpolation this
    // string would end up inside the SQL text and the query would throw a
    // syntax error; as a bind parameter it is rejected by the type, which is a
    // different failure and the one that proves the parameterisation.
    await assert.rejects(
      () => repository.findRecentCompletedAttempts(userId, "2; DROP TABLE exams"),
      /invalid input syntax for type bigint|integer/i,
    );

    // And the table is still there, which is the assertion that actually matters.
    assert.equal((await repository.findExamTotals(userId)).total, 5);
  });

  it("exposes no answer key and no private columns (§5, §24)", async () => {
    // §5: "Do not expose correct answers. Do not expose private database fields
    // unnecessarily." Asserted as an exact key set rather than as four
    // `assert.equal(row.correct_answer, undefined)` lines, so a column added to
    // the SELECT later fails here instead of reaching a client unnoticed.
    const [row] = await repository.findRecentCompletedAttempts(userId, 1);

    assert.deepEqual(Object.keys(row).sort(), [
      "attempt_id",
      "correct_answers",
      "exam_difficulty",
      "exam_id",
      "exam_subject",
      "exam_title",
      "passed",
      "percentage",
      "score",
      "started_at",
      "submitted_at",
      "total_questions",
    ]);
  });

  it("returns timestamps as ISO-8601 strings, as persisted (§17)", async () => {
    const [row] = await repository.findRecentCompletedAttempts(userId, 1);

    assert.match(row.submitted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(row.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("is empty for a learner with nothing", async () => {
    assert.deepEqual(
      await repository.findRecentCompletedAttempts(await makeUser("nohist"), 10),
      [],
    );
  });

  it("gives §6 the same percentages in the same order", async () => {
    // The trend and the history must not disagree about which attempt is most
    // recent: the overview reports `percentages[0]` as "most recent", and the
    // history's first row is the same sitting. Two ORDER BYs that differed
    // would make those two numbers contradict each other on the same page.
    const history = await repository.findRecentCompletedAttempts(userId, 10);
    const percentages = await repository.findRecentCompletedPercentages(userId, 10);

    assert.deepEqual(percentages, history.map((row) => row.percentage));
    assert.deepEqual(percentages, [75, 0, 100, 50]);
  });

  it("returns percentages as bare numbers for the trend", async () => {
    const percentages = await repository.findRecentCompletedPercentages(userId, 2);

    assert.deepEqual(percentages, [75, 0]);
    for (const value of percentages) {
      assert.equal(typeof value, "number");
    }
  });
});

describe("§7 the topic breakdown", () => {
  it("counts answered questions and correct answers per topic", async () => {
    const userId = await makeUser("topics");
    await sitExam(userId, { topics: ["Algebra"], results: [true, true, false] });
    await sitExam(userId, { topics: ["Geometry"], results: [false, false] });

    assert.deepEqual(await repository.findTopicBreakdown(userId), [
      { topic: "Algebra", attempted: 3, correct: 2 },
      { topic: "Geometry", attempted: 2, correct: 0 },
    ]);
  });

  it("orders by topic name, so the endpoint's order is the database's", async () => {
    const userId = await makeUser("topicorder");
    await sitExam(userId, { topics: ["Trigonometry"], results: [true] });
    await sitExam(userId, { topics: ["Algebra"], results: [true] });
    await sitExam(userId, { topics: ["Geometry"], results: [true] });

    assert.deepEqual(
      (await repository.findTopicBreakdown(userId)).map((row) => row.topic),
      ["Algebra", "Geometry", "Trigonometry"],
    );
  });

  it("aggregates one topic across several exams", async () => {
    // §21's "grouping": two exams on the same topic are one row, not two.
    const userId = await makeUser("topicgroup");
    await sitExam(userId, { topics: ["Algebra"], results: [true, false] });
    await sitExam(userId, { topics: ["Algebra"], results: [true, true, true] });

    assert.deepEqual(await repository.findTopicBreakdown(userId), [
      { topic: "Algebra", attempted: 5, correct: 4 },
    ]);
  });

  it("counts a multi-topic exam's questions under EVERY one of its topics", async () => {
    // The documented consequence of exam-level attribution: exam_questions has
    // no topic column, so the only attribution the persisted data supports is
    // "this exam was generated for these topics". A four-question exam on
    // ["Algebra", "Geometry"] therefore reports 4 under each, not 2 and 2.
    //
    // This test exists to pin the behaviour rather than to endorse it: it is
    // stated in docs/learning-analytics-architecture.md, and splitting the
    // counts would mean guessing which question is "really" Algebra, which §7
    // forbids.
    const userId = await makeUser("multitopic");
    await sitExam(userId, {
      topics: ["Algebra", "Geometry"],
      results: [true, true, true, false],
    });

    assert.deepEqual(await repository.findTopicBreakdown(userId), [
      { topic: "Algebra", attempted: 4, correct: 3 },
      { topic: "Geometry", attempted: 4, correct: 3 },
    ]);
  });

  it("keeps the accuracy honest even though the counts double up", async () => {
    // The property that makes the weak-area rule meaningful despite the above:
    // the same rows are in the numerator and the denominator, so each topic's
    // accuracy is the accuracy of the exams that mentioned it.
    const userId = await makeUser("multiacc");
    await sitExam(userId, {
      topics: ["Algebra", "Geometry"],
      results: [true, false],
    });

    for (const row of await repository.findTopicBreakdown(userId)) {
      assert.equal((row.correct / row.attempted) * 100, 50, row.topic);
    }
  });

  it("counts only questions that were actually answered", async () => {
    // §18's "empty topic results" neighbour: a skipped question has no
    // attempt_answers row, so it is in `exams.question_count` and in the
    // attempt's `total_questions` but not in the topic denominator. The two
    // denominators differ by design and the docs say so — the exam percentage
    // measures the paper, topic accuracy measures what was tried.
    const userId = await makeUser("skipped");
    await sitExam(userId, {
      topics: ["Algebra"],
      results: [true, false],
      unanswered: 3,
    });

    assert.deepEqual(await repository.findTopicBreakdown(userId), [
      { topic: "Algebra", attempted: 2, correct: 1 },
    ]);
  });

  it("ignores exams generated for no topics at all", async () => {
    // `unnest('{}')` produces zero rows, so the LATERAL join drops the
    // question. Correct: it has no topic to attribute to. Those answers are
    // still counted by the material breakdown and by every exam-level total.
    const userId = await makeUser("notopics");
    await sitExam(userId, { topics: [], results: [true, true] });

    assert.deepEqual(await repository.findTopicBreakdown(userId), []);
    assert.equal((await repository.findAttemptTotals(userId)).completed_attempts, 1);
  });

  it("reads is_correct and never re-grades (§7)", async () => {
    // Every fixture question above has correct_answer 'a'. Here the stored
    // verdict deliberately CONTRADICTS the key: the answer row says the learner
    // was right while selecting 'b'. A query that re-derived correctness by
    // comparing selected_answer to correct_answer would report 0 correct; one
    // that reads the persisted verdict reports 1.
    //
    // §7: "Do not calculate correctness using a second grading implementation
    // if SP-V2-006 already persists question-level correctness."
    const userId = await makeUser("nograding");
    const { attemptId, questionIds } = await sitExam(userId, {
      topics: ["Algebra"],
      results: [],
      unanswered: 1,
    });
    await db.query(
      `INSERT INTO attempt_answers
              (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
       VALUES ($1, $2, $3, 'b', true)`,
      [attemptId, userId, questionIds[0]],
    );

    assert.deepEqual(await repository.findTopicBreakdown(userId), [
      { topic: "Algebra", attempted: 1, correct: 1 },
    ]);
  });

  it("ignores answers belonging to an attempt that is not completed", async () => {
    // The one deliberately unrealistic fixture in this file. SP-V2-006 writes
    // attempt_answers only inside the submit transaction, so an in-progress
    // attempt with answer rows cannot occur through the application — which is
    // exactly why the `att.status = 'completed'` predicate would otherwise be
    // untested. Seeding the impossible state proves the filter is load-bearing.
    const userId = await makeUser("partialtopic");
    const { attemptId, questionIds } = await sitExam(userId, {
      topics: ["Algebra"],
      results: [],
      unanswered: 2,
      status: "in_progress",
    });
    await db.query(
      `INSERT INTO attempt_answers
              (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
       VALUES ($1, $2, $3, 'a', true)`,
      [attemptId, userId, questionIds[0]],
    );

    assert.deepEqual(await repository.findTopicBreakdown(userId), []);
  });

  it("is empty for a learner with nothing (§18)", async () => {
    assert.deepEqual(
      await repository.findTopicBreakdown(await makeUser("notopicdata")),
      [],
    );
  });
});

describe("§8 the material breakdown", () => {
  it("counts answered questions per source material, with its filename", async () => {
    const userId = await makeUser("materials");
    const first = await makeMaterial(userId, { filename: "algebra.pdf" });
    const second = await makeMaterial(userId, { filename: "geometry.pdf" });

    await sitExam(userId, {
      topics: ["Algebra"],
      results: [true, true, false],
      sources: [first, first, second],
    });

    const rows = await repository.findMaterialBreakdown(userId);

    assert.deepEqual(rows, [
      {
        material_id: first,
        original_filename: "algebra.pdf",
        attempted: 2,
        correct: 2,
      },
      {
        material_id: second,
        original_filename: "geometry.pdf",
        attempted: 1,
        correct: 0,
      },
    ]);
  });

  it("returns the material id as a number, not a BIGINT string (§16)", async () => {
    // §16's hazard, avoided rather than handled: `source_material_id` is a
    // scalar BIGINT, which src/config/pg-types.js parses to a number, so this
    // query needs no equivalent of exam.repository.js's withNumericMaterialIds.
    // Had the breakdown been built from `exams.material_ids BIGINT[]` this would
    // be the string "42", because no INT8-array parser is registered.
    const userId = await makeUser("bigintcheck");
    const materialId = await makeMaterial(userId);
    await sitExam(userId, { results: [true], sources: [materialId] });

    const [row] = await repository.findMaterialBreakdown(userId);

    assert.equal(typeof row.material_id, "number");
    assert.equal(row.material_id, materialId);
  });

  it("groups questions with no material into one null row", async () => {
    // §18's "missing material attribution". A topic-generated exam's questions
    // carry no source_material_id, and they must still be counted — dropping
    // them would make the material accuracies fail to account for questions the
    // learner demonstrably answered.
    const userId = await makeUser("unattributed");
    await sitExam(userId, { results: [true, false], sources: [null, null] });

    assert.deepEqual(await repository.findMaterialBreakdown(userId), [
      { material_id: null, original_filename: null, attempted: 2, correct: 1 },
    ]);
  });

  it("sorts the unattributed group last", async () => {
    const userId = await makeUser("nullslast");
    const materialId = await makeMaterial(userId, { filename: "cited.pdf" });
    await sitExam(userId, {
      results: [true, true],
      sources: [null, materialId],
    });

    assert.deepEqual(
      (await repository.findMaterialBreakdown(userId)).map((r) => r.material_id),
      [materialId, null],
    );
  });

  it("keeps a deleted material's answers, attributed to nothing (§8)", async () => {
    // The limitation SP-V2-006 documented and §8 names explicitly.
    // exam_questions_source_material_fkey is ON DELETE SET NULL (source_material_id),
    // so deleting the upload NULLs the attribution while leaving the question,
    // the answer and the graded attempt intact — and `exams.source_type` still
    // reads 'material', which is why §8 says not to pretend the attribution
    // survived.
    //
    // The deleted material's four answers move into the null bucket and join the
    // one ungrounded answer already there. No fabricated filename, no dropped
    // rows: "Represent unavailable attribution safely. Do not recreate deleted
    // material metadata."
    const userId = await makeUser("deletedmaterial");
    const doomed = await makeMaterial(userId, { filename: "temporary.pdf" });
    const kept = await makeMaterial(userId, { filename: "kept.pdf" });

    await sitExam(userId, {
      results: [true, true, false, false, true],
      sources: [doomed, doomed, doomed, doomed, kept],
    });
    await sitExam(userId, { results: [false], sources: [null] });

    const before = await repository.findMaterialBreakdown(userId);
    assert.equal(before.length, 3, "two materials plus the ungrounded question");

    await db.query("DELETE FROM materials WHERE id = $1", [doomed]);

    const after = await repository.findMaterialBreakdown(userId);

    assert.deepEqual(after, [
      { material_id: kept, original_filename: "kept.pdf", attempted: 1, correct: 1 },
      { material_id: null, original_filename: null, attempted: 5, correct: 2 },
    ]);
    assert.equal(
      after.reduce((sum, row) => sum + row.attempted, 0),
      6,
      "every answered question is still counted somewhere",
    );
  });

  it("is empty for a learner with nothing", async () => {
    assert.deepEqual(
      await repository.findMaterialBreakdown(await makeUser("nomaterials")),
      [],
    );
  });
});

describe("§3 one plan's progress", () => {
  let userId;
  let planId;

  before(async () => {
    userId = await makeUser("planprogress");
    planId = await makePlan(userId, { title: "Finals", subject: "Physics" });
    await makeTasks(planId, userId, [
      { status: "completed", topic: "Kinematics" },
      { status: "completed", topic: "Kinematics" },
      { status: "pending", topic: "Optics" },
      { status: "in_progress", topic: "Optics" },
      { status: "skipped", topic: null },
    ]);
  });

  it("returns the plan with its task counts", async () => {
    const plan = await repository.findPlanProgress(planId, userId);

    assert.equal(plan.id, planId);
    assert.equal(plan.title, "Finals");
    assert.equal(plan.subject, "Physics");
    assert.equal(plan.total_tasks, 5);
    assert.equal(plan.completed_tasks, 2);
    assert.equal(plan.pending_tasks, 1);
    assert.equal(plan.in_progress_tasks, 1);
    assert.equal(plan.skipped_tasks, 1);
  });

  it("reports the STORED status, never a recomputed one (§3)", async () => {
    // §3: "Do not duplicate study-plan state-management logic." SP-V2-005 owns
    // when a plan becomes 'completed'. Here every task is done while the plan's
    // stored status is still 'active' — the state a plan is in between a task
    // update and a status recompute — and analytics must report 'active' with
    // 100% completion rather than quietly promoting it.
    const owner = await makeUser("storedstatus");
    const stale = await makePlan(owner, { status: "active" });
    await makeTasks(stale, owner, [{ status: "completed" }, { status: "completed" }]);

    const plan = await repository.findPlanProgress(stale, owner);

    assert.equal(plan.status, "active");
    assert.equal(plan.total_tasks, 2);
    assert.equal(plan.completed_tasks, 2);
  });

  it("returns a zero-task plan as a row of zeros, not as nothing (§3)", async () => {
    // The LEFT JOIN. §3 requires the zero-task plan to be handled and forbids
    // NaN or Infinity; handling it here means the service never has to tell
    // "plan absent" from "plan empty", and `percentageOf(0, 0)` decides the rest
    // in one place.
    const owner = await makeUser("zerotask");
    const bare = await makePlan(owner, { title: "Nothing scheduled" });

    const plan = await repository.findPlanProgress(bare, owner);

    assert.equal(plan.id, bare);
    assert.equal(plan.total_tasks, 0);
    assert.equal(plan.completed_tasks, 0);
  });

  it("returns dates as stored, without a timezone shift (§17)", async () => {
    const plan = await repository.findPlanProgress(planId, userId);

    assert.equal(plan.start_date, "2026-01-01");
    assert.equal(plan.end_date, "2026-01-31");
    assert.equal(plan.exam_date, "2026-02-05");
  });

  it("is undefined for a plan that does not exist", async () => {
    assert.equal(await repository.findPlanProgress(999_999_999, userId), undefined);
  });

  it("groups the plan's tasks by topic, nulls last", async () => {
    assert.deepEqual(await repository.findPlanTopicProgress(planId, userId), [
      { topic: "Kinematics", total_tasks: 2, completed_tasks: 2 },
      { topic: "Optics", total_tasks: 2, completed_tasks: 0 },
      { topic: null, total_tasks: 1, completed_tasks: 0 },
    ]);
  });

  it("accounts for every task in the plan across the topic rows", async () => {
    // The per-topic numbers must add up to the plan totals, which is what makes
    // the null bucket necessary rather than tidy.
    const plan = await repository.findPlanProgress(planId, userId);
    const topics = await repository.findPlanTopicProgress(planId, userId);

    assert.equal(
      topics.reduce((sum, row) => sum + row.total_tasks, 0),
      plan.total_tasks,
    );
    assert.equal(
      topics.reduce((sum, row) => sum + row.completed_tasks, 0),
      plan.completed_tasks,
    );
  });

  it("is empty for a zero-task plan's topics", async () => {
    const owner = await makeUser("zerotopic");
    const bare = await makePlan(owner);

    assert.deepEqual(await repository.findPlanTopicProgress(bare, owner), []);
  });
});

describe("§11 and §24 ownership isolation, in both directions", () => {
  // Two learners with deliberately different data, so "A cannot see B" is not
  // satisfied by the two happening to have the same numbers. Every exported read
  // is asserted for both, because §24 is explicit that an aggregate is a
  // data-isolation boundary too: a COUNT that leaked would leak silently.
  let alice;
  let bob;
  let alicePlan;
  let bobPlan;

  before(async () => {
    alice = await makeUser("alice");
    bob = await makeUser("bob");

    alicePlan = await makePlan(alice, { title: "Alice's plan" });
    await makeTasks(alicePlan, alice, [
      { status: "completed", topic: "Algebra" },
      { status: "pending", topic: "Algebra" },
    ]);

    bobPlan = await makePlan(bob, { title: "Bob's plan", status: "completed" });
    await makeTasks(bobPlan, bob, [
      { status: "completed", topic: "Geometry" },
      { status: "completed", topic: "Geometry" },
      { status: "skipped", topic: "Geometry" },
      { status: "pending", topic: null },
    ]);

    const aliceMaterial = await makeMaterial(alice, { filename: "alice.pdf" });
    await sitExam(alice, {
      topics: ["Algebra"],
      results: [true, true, false, false],
      sources: [aliceMaterial, aliceMaterial, aliceMaterial, aliceMaterial],
    }); // 50

    const bobMaterial = await makeMaterial(bob, { filename: "bob.pdf" });
    await sitExam(bob, {
      topics: ["Geometry"],
      results: [true, true, true, true, true],
      sources: Array(5).fill(bobMaterial),
    }); // 100
    await sitExam(bob, { topics: ["Geometry"], results: [false, false] }); // 0
  });

  it("scopes the study-plan totals", async () => {
    assert.deepEqual(await repository.findStudyPlanTotals(alice), {
      total: 1,
      active: 1,
      completed: 0,
      cancelled: 0,
      archived: 0,
    });
    assert.deepEqual(await repository.findStudyPlanTotals(bob), {
      total: 1,
      active: 0,
      completed: 1,
      cancelled: 0,
      archived: 0,
    });
  });

  it("scopes the task totals", async () => {
    assert.deepEqual(await repository.findTaskTotals(alice), {
      total: 2,
      completed: 1,
      pending: 1,
      in_progress: 0,
      skipped: 0,
    });
    assert.deepEqual(await repository.findTaskTotals(bob), {
      total: 4,
      completed: 2,
      pending: 1,
      in_progress: 0,
      skipped: 1,
    });
  });

  it("scopes the exam and attempt totals", async () => {
    assert.deepEqual(await repository.findExamTotals(alice), { total: 1 });
    assert.deepEqual(await repository.findExamTotals(bob), { total: 2 });

    const aliceTotals = await repository.findAttemptTotals(alice);
    const bobTotals = await repository.findAttemptTotals(bob);

    assert.equal(aliceTotals.attempts, 1);
    assert.equal(aliceTotals.average_percentage, 50);
    assert.equal(bobTotals.attempts, 2);
    assert.equal(bobTotals.average_percentage, 50, "(100 + 0) / 2");
    assert.equal(bobTotals.highest_percentage, 100);
    assert.equal(
      aliceTotals.highest_percentage,
      50,
      "Bob's 100 must not become Alice's best",
    );
  });

  it("scopes the exam history", async () => {
    const aliceHistory = await repository.findRecentCompletedAttempts(alice, 50);
    const bobHistory = await repository.findRecentCompletedAttempts(bob, 50);

    assert.deepEqual(aliceHistory.map((r) => r.exam_title), ["Mock exam"]);
    assert.equal(aliceHistory.length, 1);
    assert.equal(bobHistory.length, 2);

    // The strongest form of the check: no row in either result belongs to the
    // other learner's attempts.
    const bobAttemptIds = new Set(bobHistory.map((r) => r.attempt_id));
    for (const row of aliceHistory) {
      assert.equal(bobAttemptIds.has(row.attempt_id), false);
    }
  });

  it("scopes the trend percentages", async () => {
    assert.deepEqual(await repository.findRecentCompletedPercentages(alice, 50), [50]);
    assert.deepEqual(await repository.findRecentCompletedPercentages(bob, 50), [0, 100]);
  });

  it("scopes the topic breakdown", async () => {
    assert.deepEqual(await repository.findTopicBreakdown(alice), [
      { topic: "Algebra", attempted: 4, correct: 2 },
    ]);
    assert.deepEqual(await repository.findTopicBreakdown(bob), [
      { topic: "Geometry", attempted: 7, correct: 5 },
    ]);
  });

  it("scopes the material breakdown", async () => {
    assert.deepEqual(
      (await repository.findMaterialBreakdown(alice)).map((r) => r.original_filename),
      ["alice.pdf"],
    );
    assert.deepEqual(
      (await repository.findMaterialBreakdown(bob)).map((r) => r.original_filename),
      ["bob.pdf", null],
    );
  });

  it("refuses another learner's plan without saying it exists (§11)", async () => {
    // Undefined for someone else's plan and undefined for a plan that never
    // existed. The service turns both into one 404, so the response cannot be
    // used to enumerate ids — and it cannot, because these two calls are
    // indistinguishable from here.
    assert.equal(await repository.findPlanProgress(bobPlan, alice), undefined);
    assert.equal(await repository.findPlanProgress(alicePlan, bob), undefined);
    assert.equal(await repository.findPlanProgress(999_999_998, alice), undefined);
  });

  it("refuses another learner's plan topics", async () => {
    // The second read of the per-plan endpoint needs its own ownership clause:
    // the service checks the plan first, but a function that trusted that check
    // would be one refactor away from leaking. Both statements carry the filter.
    assert.deepEqual(await repository.findPlanTopicProgress(bobPlan, alice), []);
    assert.deepEqual(await repository.findPlanTopicProgress(alicePlan, bob), []);
  });

  it("returns each learner's own plan intact", async () => {
    // The negative assertions above would all pass if the queries returned
    // nothing to anyone. This is the control.
    assert.equal(
      (await repository.findPlanProgress(alicePlan, alice)).title,
      "Alice's plan",
    );
    assert.equal(
      (await repository.findPlanProgress(bobPlan, bob)).title,
      "Bob's plan",
    );
  });
});
