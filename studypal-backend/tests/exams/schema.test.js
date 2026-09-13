/**
 * Exam schema tests — SP-V2-006 §16's "Database persistence" group, at the
 * level the database itself enforces.
 *
 * The same approach as tests/study-plans/schema.test.js, one migration later:
 * go through SQL directly, and assert that the DATABASE refuses a bad row
 * rather than that the application avoids writing one. Every CHECK, foreign key
 * and uniqueness rule in migrations/postgres/005_exams.sql has to hold even if a
 * future code path forgets it, and the only way to demonstrate that is to try
 * the write.
 *
 * Constraint NAMES are matched rather than message text, so renaming a
 * constraint fails here and a reworded PostgreSQL error does not.
 *
 * THE FOUR CONSTRAINTS WORTH READING FIRST
 * ----------------------------------------
 * Most of what follows is ordinary bounds checking. Four are the reason this
 * file exists:
 *
 *   exam_questions_material_user_fkey and exam_attempts_exam_user_fkey — both
 *   COMPOSITE, against `(id, user_id)`. They are what make §12's ownership
 *   rules properties of the database rather than checks the service performs.
 *   The tests below write a cross-user row through raw SQL, bypassing every
 *   service, and the write still fails.
 *
 *   exam_attempts_result_matches_status — the §11 state machine as a
 *   constraint. A half-graded attempt (completed with no score, or scored while
 *   in progress) is not storable, so a bug in the submission path fails at the
 *   INSERT rather than quietly producing an attempt nobody can interpret.
 *
 *   attempt_answers_question_fkey — NO ACTION DEFERRABLE INITIALLY DEFERRED.
 *   The two delete behaviours it produces are opposite, both required, and
 *   neither is what the conventional choice would give: deleting a USER must
 *   succeed even though two cascade paths reach the same answer rows, and
 *   deleting ONE QUESTION of an attempted exam must fail. Both are asserted
 *   below, because a future migration "tidying" this to CASCADE would pass
 *   every other test in this suite.
 *
 *   node --test tests/exams/schema.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createIsolatedDatabase } from "../helpers/test-database.mjs";

const { Pool } = pg;

let database;
let pool;

before(async () => {
  database = await createIsolatedDatabase({ label: "examschema" });
  pool = new Pool({ connectionString: database.url, max: 4 });
});

after(async () => {
  await pool?.end();
  await database?.drop();
});

let userSequence = 0;

/** A fresh user, since every row below needs an owner. */
async function createUser() {
  const { rows } = await pool.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [`examschema_${(userSequence += 1)}`],
  );
  return rows[0].id;
}

/** A material owned by `userId`, for the composite-FK tests. */
let keySequence = 0;
async function createMaterial(userId) {
  // Flat, no slashes: materials_storage_key_safe requires a single safe path
  // segment, which is what stops a key escaping the storage root.
  const key = `exam-${userId}-${(keySequence += 1)}.pdf`;
  const { rows } = await pool.query(
    `INSERT INTO materials
       (user_id, original_filename, storage_key, mime_type, file_size)
     VALUES ($1, 'notes.pdf', $2, 'application/pdf', 1024)
     RETURNING id`,
    [userId, key],
  );
  return rows[0].id;
}

/** Insert an exam, every column defaulted to something valid. */
async function insertExam(userId, overrides = {}) {
  const exam = {
    title: "Photosynthesis Practice Exam",
    subject: "Biology",
    difficulty: "medium",
    question_count: 2,
    source_type: "topics",
    topics: ["Photosynthesis"],
    material_ids: [],
    ...overrides,
  };

  const { rows } = await pool.query(
    `INSERT INTO exams
       (user_id, title, subject, difficulty, question_count, source_type,
        topics, material_ids${overrides.status === undefined ? "" : ", status"})
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::bigint[]${
       overrides.status === undefined ? "" : ", $9"
     })
     RETURNING *`,
    [
      userId,
      exam.title,
      exam.subject,
      exam.difficulty,
      exam.question_count,
      exam.source_type,
      exam.topics,
      exam.material_ids,
      ...(overrides.status === undefined ? [] : [overrides.status]),
    ],
  );
  return rows[0];
}

/** Insert one question of `examId`. */
async function insertQuestion(examId, userId, overrides = {}) {
  const question = {
    question_order: 1,
    question_type: "multiple_choice",
    question_text: "Which statement about photosynthesis is correct?",
    options: [
      { id: "A", text: "It converts light energy into chemical energy." },
      { id: "B", text: "It occurs only in the mitochondria." },
      { id: "C", text: "It consumes oxygen." },
      { id: "D", text: "It requires no water." },
    ],
    correct_answer: "A",
    explanation: "Light energy becomes chemical energy in the light reactions.",
    source_material_id: null,
    source_chunk_id: null,
    ...overrides,
  };

  const { rows } = await pool.query(
    `INSERT INTO exam_questions
       (exam_id, user_id, question_order, question_type, question_text,
        options, correct_answer, explanation, source_material_id,
        source_chunk_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING *`,
    [
      examId,
      userId,
      question.question_order,
      question.question_type,
      question.question_text,
      JSON.stringify(question.options),
      question.correct_answer,
      question.explanation,
      question.source_material_id,
      question.source_chunk_id,
    ],
  );
  return rows[0];
}

/** Insert an attempt. Result columns omitted unless overridden. */
async function insertAttempt(examId, userId, overrides = {}) {
  const columns = ["exam_id", "user_id"];
  const values = [examId, userId];

  for (const [column, value] of Object.entries(overrides)) {
    columns.push(column);
    values.push(value);
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO exam_attempts (${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values,
  );
  return rows[0];
}

/** Insert one answer of `attemptId`. */
async function insertAnswer(attemptId, userId, questionId, overrides = {}) {
  const answer = {
    selected_answer: "A",
    is_correct: true,
    ...overrides,
  };

  const { rows } = await pool.query(
    `INSERT INTO attempt_answers
       (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [attemptId, userId, questionId, answer.selected_answer, answer.is_correct],
  );
  return rows[0];
}

/**
 * Assert that `run` fails, and that PostgreSQL names `constraint`.
 *
 * The constraint name is the assertion. A test that only checked "it threw"
 * would pass when a typo made the INSERT fail for an unrelated reason.
 */
async function assertViolates(constraint, run) {
  await assert.rejects(
    run,
    (err) => {
      assert.equal(
        err.constraint,
        constraint,
        `expected ${constraint}, got ${err.constraint} (${err.message})`,
      );
      return true;
    },
    `expected ${constraint} to reject the write`,
  );
}

/**
 * The same, where the row violates SEVERAL constraints and PostgreSQL is free
 * to report whichever it evaluated first.
 *
 * Needed for exactly the rows where one mistake necessarily breaks two rules.
 * An invalid `status` is the clear case: it fails exam_attempts_status_valid,
 * and it also fails exam_attempts_result_matches_status, because that CHECK is
 * written as "either the in_progress shape or the completed shape" and a third
 * status matches neither. Pinning one name there would be asserting an
 * evaluation order PostgreSQL never promised.
 *
 * The set is still the assertion — an unrelated failure fails the test.
 */
async function assertViolatesOneOf(constraints, run) {
  await assert.rejects(
    run,
    (err) => {
      assert.ok(
        constraints.includes(err.constraint),
        `expected one of ${constraints.join(", ")}, got ${err.constraint} (${err.message})`,
      );
      return true;
    },
    `expected one of ${constraints.join(", ")} to reject the write`,
  );
}

/**
 * A coherent started/submitted pair for a completed attempt.
 *
 * BOTH are set explicitly, and that is not tidiness. `started_at` defaults to
 * `now()`, which PostgreSQL evaluates on the server when the row is inserted,
 * whereas a JavaScript `new Date()` is evaluated in this process before the
 * query is even sent — so it lands a few milliseconds EARLIER than the default
 * it is meant to follow, and exam_attempts_submitted_after_started rejects the
 * row. Fixing it by sending a future timestamp would be a fixture that depends
 * on a clock; sending both makes the ordering explicit and local.
 */
const STARTED_AT = "2026-01-01T09:00:00.000Z";
const SUBMITTED_AT = "2026-01-01T09:30:00.000Z";


// ── exams ───────────────────────────────────────────────────────────────────

describe("exams constraints", () => {
  it("accepts a well-formed exam and defaults its status to ready", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);

    // Generation is synchronous and an exam row only exists after its questions
    // validated, so 'ready' is the state every exam is born in.
    assert.equal(exam.status, "ready");
    assert.equal(exam.source_type, "topics");
    assert.deepEqual(exam.topics, ["Photosynthesis"]);
    assert.deepEqual(exam.material_ids, []);
    assert.ok(exam.created_at);
  });

  it("rejects a status outside the two the lifecycle uses", async () => {
    const userId = await createUser();

    // 'draft' and 'in_progress' are deliberately absent — see the status
    // discussion in the migration. A CHECK rather than an ENUM, so adding a
    // state later is one migration that rewrites no rows.
    for (const status of ["draft", "in_progress", "completed", "archived", ""]) {
      await assertViolates("exams_status_valid", () =>
        insertExam(userId, { status }),
      );
    }
  });

  it("accepts cancelled, which nothing writes today", async () => {
    // A deliberate seam: the schema accepts it, no endpoint produces it. The
    // test exists so that adding the endpoint does not also need a migration.
    const userId = await createUser();
    const exam = await insertExam(userId, { status: "cancelled" });
    assert.equal(exam.status, "cancelled");
  });

  it("rejects an unknown difficulty", async () => {
    const userId = await createUser();
    for (const difficulty of ["extreme", "Medium", "", "impossible"]) {
      await assertViolates("exams_difficulty_valid", () =>
        insertExam(userId, { difficulty }),
      );
    }
  });

  it("rejects an unknown source type", async () => {
    const userId = await createUser();
    for (const source_type of ["mixed", "Material", "", "rag"]) {
      await assertViolates("exams_source_type_valid", () =>
        insertExam(userId, { source_type }),
      );
    }
  });

  it("rejects a blank or oversized title", async () => {
    const userId = await createUser();

    await assertViolates("exams_title_not_blank", () =>
      insertExam(userId, { title: "   \t\n  " }),
    );
    await assertViolates("exams_title_bounded", () =>
      insertExam(userId, { title: "T".repeat(201) }),
    );
  });

  it("rejects a blank or oversized subject", async () => {
    const userId = await createUser();

    await assertViolates("exams_subject_not_blank", () =>
      insertExam(userId, { subject: " " }),
    );
    await assertViolates("exams_subject_bounded", () =>
      insertExam(userId, { subject: "S".repeat(201) }),
    );
  });

  it("makes an exam with no questions unrepresentable", async () => {
    // The floor, not the ceiling, is the point: it is what stops "an exam with
    // zero questions" existing at the schema level as well as in the service.
    const userId = await createUser();

    await assertViolates("exams_question_count_positive", () =>
      insertExam(userId, { question_count: 0 }),
    );
    await assertViolates("exams_question_count_positive", () =>
      insertExam(userId, { question_count: -5 }),
    );
    await assertViolates("exams_question_count_bounded", () =>
      insertExam(userId, { question_count: 101 }),
    );
  });

  it("bounds the topics and material id arrays", async () => {
    const userId = await createUser();

    await assertViolates("exams_topics_bounded", () =>
      insertExam(userId, {
        topics: Array.from({ length: 101 }, (_, i) => `Topic ${i}`),
      }),
    );
    await assertViolates("exams_material_ids_bounded", () =>
      insertExam(userId, {
        material_ids: Array.from({ length: 101 }, (_, i) => i + 1),
      }),
    );
  });

  it("deletes a user's exams with the user", async () => {
    // CASCADE, for the reason 001 gives: an exam is meaningless without the
    // student it belongs to, and deleting a user must actually delete it.
    const userId = await createUser();
    const exam = await insertExam(userId);

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    const { rows } = await pool.query("SELECT id FROM exams WHERE id = $1", [
      exam.id,
    ]);
    assert.equal(rows.length, 0);
  });
});

// ── exam_questions ──────────────────────────────────────────────────────────

describe("exam_questions constraints", () => {
  it("stores the answer key as a non-null column with no default", async () => {
    // A question without an answer key cannot be stored, so grading can never
    // find itself with nothing to compare against.
    const userId = await createUser();
    const exam = await insertExam(userId);

    await assert.rejects(
      pool.query(
        `INSERT INTO exam_questions
           (exam_id, user_id, question_order, question_type, question_text,
            options, explanation)
         VALUES ($1, $2, 1, 'true_false', 'Is this stored?',
                 '[{"id":"true","text":"True"}]'::jsonb, 'Because.')`,
        [exam.id, userId],
      ),
      (err) => {
        // NOT NULL violations name the column rather than a constraint.
        assert.equal(err.code, "23502");
        assert.equal(err.column, "correct_answer");
        return true;
      },
    );
  });

  it("refuses a question attached to another user's exam", async () => {
    // The composite FK. This is the database refusing a cross-user row, not the
    // service — the write below bypasses every layer.
    const owner = await createUser();
    const stranger = await createUser();
    const exam = await insertExam(owner);

    await assertViolates("exam_questions_exam_user_fkey", () =>
      insertQuestion(exam.id, stranger, {}),
    );
  });

  it("refuses a question citing another user's material", async () => {
    // §12, as a property of the schema: user A's exam cannot cite user B's
    // document even if the generator's ownership check were skipped entirely.
    const owner = await createUser();
    const stranger = await createUser();
    const exam = await insertExam(owner);
    const strangersMaterial = await createMaterial(stranger);

    await assertViolates("exam_questions_material_user_fkey", () =>
      insertQuestion(exam.id, owner, {
        source_material_id: strangersMaterial,
      }),
    );
  });

  it("accepts a question citing the owner's own material", async () => {
    const owner = await createUser();
    const exam = await insertExam(owner);
    const material = await createMaterial(owner);

    const question = await insertQuestion(exam.id, owner, {
      source_material_id: material,
    });
    assert.equal(question.source_material_id, material);
  });

  it("nulls the source material when the material is deleted, keeping the question", async () => {
    // ON DELETE SET NULL, not CASCADE: deleting a material must not delete the
    // questions generated from it, or a learner loses their attempt history by
    // tidying up their uploads.
    const owner = await createUser();
    const exam = await insertExam(owner);
    const material = await createMaterial(owner);
    const question = await insertQuestion(exam.id, owner, {
      source_material_id: material,
    });

    await pool.query("DELETE FROM materials WHERE id = $1", [material]);

    const { rows } = await pool.query(
      "SELECT id, source_material_id, user_id FROM exam_questions WHERE id = $1",
      [question.id],
    );
    assert.equal(rows.length, 1, "the question was deleted with the material");
    assert.equal(rows[0].source_material_id, null);
    // Only source_material_id is nulled — the composite key names its column
    // explicitly, so user_id survives.
    assert.equal(rows[0].user_id, owner);
  });

  it("allows one question per position per exam", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);
    await insertQuestion(exam.id, userId, { question_order: 1 });

    await assertViolates("exam_questions_exam_order_key", () =>
      insertQuestion(exam.id, userId, { question_order: 1 }),
    );

    // A different position is fine, and so is the same position in another exam.
    await insertQuestion(exam.id, userId, { question_order: 2 });
    const other = await insertExam(userId);
    await insertQuestion(other.id, userId, { question_order: 1 });
  });

  it("rejects the excluded question types", async () => {
    // essay/coding/audio are excluded by the CHECK rather than by validation
    // alone, so a future code path cannot introduce one without a migration.
    const userId = await createUser();
    const exam = await insertExam(userId);

    for (const question_type of ["essay", "coding", "short_answer", "audio", ""]) {
      await assertViolates("exam_questions_type_valid", () =>
        insertQuestion(exam.id, userId, { question_type }),
      );
    }
  });

  it("rejects a non-positive question order", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);

    for (const question_order of [0, -1]) {
      await assertViolates("exam_questions_order_positive", () =>
        insertQuestion(exam.id, userId, { question_order }),
      );
    }
  });

  it("rejects blank or oversized text, keys and explanations", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);

    await assertViolates("exam_questions_text_not_blank", () =>
      insertQuestion(exam.id, userId, { question_text: "  \n " }),
    );
    await assertViolates("exam_questions_text_bounded", () =>
      insertQuestion(exam.id, userId, { question_text: "Q".repeat(2001) }),
    );

    await assertViolates("exam_questions_correct_answer_not_blank", () =>
      insertQuestion(exam.id, userId, { correct_answer: " " }),
    );
    await assertViolates("exam_questions_correct_answer_bounded", () =>
      insertQuestion(exam.id, userId, { correct_answer: "A".repeat(101) }),
    );

    await assertViolates("exam_questions_explanation_not_blank", () =>
      insertQuestion(exam.id, userId, { explanation: "\t" }),
    );
    await assertViolates("exam_questions_explanation_bounded", () =>
      insertQuestion(exam.id, userId, { explanation: "E".repeat(2001) }),
    );
  });

  it("refuses options that are not a non-empty JSON array", async () => {
    // Not the full shape rule — that is the validator's — but enough that a
    // reader which iterates `options` cannot meet a scalar or an empty list.
    const userId = await createUser();
    const exam = await insertExam(userId);

    for (const options of [[], {}, "A", 7, null]) {
      await assertViolates("exam_questions_options_is_array", () =>
        insertQuestion(exam.id, userId, { options }),
      );
    }
  });

  it("survives quotes, braces and commas in option text", async () => {
    // The insert path casts a JSON.stringify'd array through $n::jsonb[], and
    // the array literal parser is the part that could mangle punctuation.
    const userId = await createUser();
    const exam = await insertExam(userId);

    const awkward = [
      { id: "A", text: `He said "yes", then {left}` },
      { id: "B", text: "a,b,c" },
      { id: "C", text: "{\"nested\": true}" },
      { id: "D", text: "back\\slash" },
    ];
    const question = await insertQuestion(exam.id, userId, { options: awkward });

    assert.deepEqual(question.options, awkward);
  });

  it("deletes questions with their exam", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);
    await insertQuestion(exam.id, userId);

    await pool.query("DELETE FROM exams WHERE id = $1", [exam.id]);

    const { rows } = await pool.query(
      "SELECT id FROM exam_questions WHERE exam_id = $1",
      [exam.id],
    );
    assert.equal(rows.length, 0);
  });
});

// ── exam_attempts ───────────────────────────────────────────────────────────

describe("exam_attempts constraints", () => {
  it("starts in_progress with every result column null", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);
    const attempt = await insertAttempt(exam.id, userId);

    assert.equal(attempt.status, "in_progress");
    assert.equal(attempt.submitted_at, null);
    assert.equal(attempt.score, null);
    assert.equal(attempt.total_questions, null);
    assert.equal(attempt.correct_answers, null);
    assert.equal(attempt.percentage, null);
    assert.equal(attempt.passed, null);
    assert.ok(attempt.started_at);
  });

  it("rejects a status outside in_progress and completed", async () => {
    // §11's lifecycle, and nothing else. No 'abandoned' or 'expired' because
    // nothing in SP-V2-006 expires an attempt.
    //
    // Two constraints accept responsibility for this row — see
    // assertViolatesOneOf — because result_matches_status is written as a
    // disjunction over the two valid statuses and so also refuses a third.
    const userId = await createUser();
    const exam = await insertExam(userId);

    for (const status of ["abandoned", "expired", "graded", "submitted", ""]) {
      await assertViolatesOneOf(
        ["exam_attempts_status_valid", "exam_attempts_result_matches_status"],
        () => insertAttempt(exam.id, userId, { status }),
      );
    }
  });

  it("refuses an attempt against another user's exam", async () => {
    // §12's "user A must not start an attempt against user B's exam", as a
    // database rule rather than a service check.
    const owner = await createUser();
    const stranger = await createUser();
    const exam = await insertExam(owner);

    await assertViolates("exam_attempts_exam_user_fkey", () =>
      insertAttempt(exam.id, stranger),
    );
  });

  it("refuses a half-graded attempt in either direction", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);

    // Completed, but with no result.
    await assertViolates("exam_attempts_result_matches_status", () =>
      insertAttempt(exam.id, userId, { status: "completed" }),
    );

    // Completed with a score but no submitted_at.
    await assertViolates("exam_attempts_result_matches_status", () =>
      insertAttempt(exam.id, userId, {
        status: "completed",
        score: 1,
        total_questions: 2,
        correct_answers: 1,
        percentage: 50,
        passed: false,
      }),
    );

    // Scored while still in progress — the other direction, and the one a
    // partial-write bug would produce.
    await assertViolates("exam_attempts_result_matches_status", () =>
      insertAttempt(exam.id, userId, {
        status: "in_progress",
        score: 1,
        total_questions: 2,
        correct_answers: 1,
        percentage: 50,
        passed: false,
        started_at: STARTED_AT,
        submitted_at: SUBMITTED_AT,
      }),
    );
  });

  it("accepts a fully graded completed attempt", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);
    const attempt = await insertAttempt(exam.id, userId, {
      status: "completed",
      started_at: STARTED_AT,
      submitted_at: SUBMITTED_AT,
      score: 1,
      total_questions: 2,
      correct_answers: 1,
      percentage: 50,
      passed: false,
    });

    assert.equal(attempt.status, "completed");
    assert.equal(attempt.percentage, 50);
    assert.equal(attempt.passed, false);
  });

  /** A completed attempt's result columns, with overrides merged in. */
  const completed = (overrides) => ({
    status: "completed",
    started_at: STARTED_AT,
    submitted_at: SUBMITTED_AT,
    score: 1,
    total_questions: 2,
    correct_answers: 1,
    percentage: 50,
    passed: false,
    ...overrides,
  });

  it("makes an impossible grade unrepresentable", async () => {
    // correct_answers <= total_questions is the one that matters: a grading bug
    // fails loudly at the INSERT rather than quietly becoming a 120% result.
    const userId = await createUser();
    const exam = await insertExam(userId);

    await assertViolates("exam_attempts_correct_within_total", () =>
      insertAttempt(exam.id, userId, completed({
        score: 3,
        correct_answers: 3,
        total_questions: 2,
        percentage: 100,
      })),
    );

    await assertViolates("exam_attempts_percentage_bounded", () =>
      insertAttempt(exam.id, userId, completed({ percentage: 101 })),
    );
    await assertViolates("exam_attempts_percentage_bounded", () =>
      insertAttempt(exam.id, userId, completed({ percentage: -1 })),
    );

    await assertViolates("exam_attempts_counts_non_negative", () =>
      insertAttempt(exam.id, userId, completed({
        score: -1,
        correct_answers: -1,
      })),
    );

    // total_questions: 0 breaks the floor AND puts correct_answers above the
    // total, so either constraint may report it first.
    await assertViolatesOneOf(
      ["exam_attempts_counts_non_negative", "exam_attempts_correct_within_total"],
      () => insertAttempt(exam.id, userId, completed({ total_questions: 0 })),
    );
  });

  it("keeps score and correct_answers equal", async () => {
    // The same number under §9's two names. If they disagree, one of the two
    // writers is wrong — and the grader computes both so that they cannot.
    const userId = await createUser();
    const exam = await insertExam(userId);

    await assertViolates("exam_attempts_score_matches_correct", () =>
      insertAttempt(exam.id, userId, completed({ score: 2, correct_answers: 1 })),
    );
  });

  it("refuses a submission that precedes the start", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);

    await assertViolates("exam_attempts_submitted_after_started", () =>
      insertAttempt(exam.id, userId, completed({
        started_at: "2026-01-02T00:00:00Z",
        submitted_at: "2026-01-01T00:00:00Z",
      })),
    );
  });

  it("allows many attempts at one exam, including concurrent ones", async () => {
    // §2 asks for attempt history, which is a history of more than one. Nothing
    // de-duplicates, and two in-progress attempts at once are legitimate.
    const userId = await createUser();
    const exam = await insertExam(userId);

    const first = await insertAttempt(exam.id, userId);
    const second = await insertAttempt(exam.id, userId);

    assert.notEqual(first.id, second.id);
    assert.equal(first.status, "in_progress");
    assert.equal(second.status, "in_progress");
  });

  it("deletes attempts with their exam", async () => {
    const userId = await createUser();
    const exam = await insertExam(userId);
    const attempt = await insertAttempt(exam.id, userId);

    await pool.query("DELETE FROM exams WHERE id = $1", [exam.id]);

    const { rows } = await pool.query(
      "SELECT id FROM exam_attempts WHERE id = $1",
      [attempt.id],
    );
    assert.equal(rows.length, 0);
  });
});

// ── attempt_answers ─────────────────────────────────────────────────────────

describe("attempt_answers constraints", () => {
  /** An exam with one question, an attempt on it, and all three ids. */
  async function scenario() {
    const userId = await createUser();
    const exam = await insertExam(userId);
    const question = await insertQuestion(exam.id, userId);
    const attempt = await insertAttempt(exam.id, userId);
    return { userId, exam, question, attempt };
  }

  it("stores what was selected and whether it was right", async () => {
    const { userId, question, attempt } = await scenario();
    const answer = await insertAnswer(attempt.id, userId, question.id);

    assert.equal(answer.selected_answer, "A");
    assert.equal(answer.is_correct, true);
    assert.ok(answer.answered_at);
  });

  it("requires a selection rather than accepting a null one", async () => {
    // An unanswered question is the ABSENCE of a row, not a row with a NULL.
    // That distinction is what lets "unanswered" be counted wrong without being
    // confused for "answered with nothing".
    const { userId, question, attempt } = await scenario();

    await assert.rejects(
      pool.query(
        `INSERT INTO attempt_answers
           (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
         VALUES ($1, $2, $3, NULL, false)`,
        [attempt.id, userId, question.id],
      ),
      (err) => {
        assert.equal(err.code, "23502");
        assert.equal(err.column, "selected_answer");
        return true;
      },
    );
  });

  it("requires is_correct rather than leaving it unknown", async () => {
    const { userId, question, attempt } = await scenario();

    await assert.rejects(
      pool.query(
        `INSERT INTO attempt_answers
           (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
         VALUES ($1, $2, $3, 'A', NULL)`,
        [attempt.id, userId, question.id],
      ),
      (err) => {
        assert.equal(err.code, "23502");
        assert.equal(err.column, "is_correct");
        return true;
      },
    );
  });

  it("prevents two answers to the same question in one attempt", async () => {
    // §4's requirement, as a constraint rather than only a service check: this
    // is what makes a duplicate unrepresentable even under a concurrent
    // double-submit.
    const { userId, question, attempt } = await scenario();
    await insertAnswer(attempt.id, userId, question.id);

    await assertViolates("attempt_answers_attempt_question_key", () =>
      insertAnswer(attempt.id, userId, question.id, { selected_answer: "B" }),
    );
  });

  it("allows the same question to be answered in a different attempt", async () => {
    const { userId, question, attempt } = await scenario();
    await insertAnswer(attempt.id, userId, question.id);

    const retake = await insertAttempt(question.exam_id, userId);
    const answer = await insertAnswer(retake.id, userId, question.id, {
      selected_answer: "B",
      is_correct: false,
    });

    assert.equal(answer.selected_answer, "B");
  });

  it("refuses an answer attached to another user's attempt", async () => {
    const { userId, question, attempt } = await scenario();
    const stranger = await createUser();

    await assertViolates("attempt_answers_attempt_user_fkey", () =>
      insertAnswer(attempt.id, stranger, question.id),
    );
    assert.ok(userId);
  });

  it("rejects a blank or oversized selection", async () => {
    const { userId, question, attempt } = await scenario();

    await assertViolates("attempt_answers_selected_not_blank", () =>
      insertAnswer(attempt.id, userId, question.id, { selected_answer: "  " }),
    );
    await assertViolates("attempt_answers_selected_bounded", () =>
      insertAnswer(attempt.id, userId, question.id, {
        selected_answer: "A".repeat(101),
      }),
    );
  });

  it("deletes answers with their attempt", async () => {
    const { userId, question, attempt } = await scenario();
    await insertAnswer(attempt.id, userId, question.id);

    await pool.query("DELETE FROM exam_attempts WHERE id = $1", [attempt.id]);

    const { rows } = await pool.query(
      "SELECT id FROM attempt_answers WHERE attempt_id = $1",
      [attempt.id],
    );
    assert.equal(rows.length, 0);
  });
});

// ── the deferred foreign key ────────────────────────────────────────────────

describe("attempt_answers_question_fkey is deferred, and both behaviours matter", () => {
  /** A graded attempt: exam, two questions, an attempt, two answers. */
  async function gradedAttempt() {
    const userId = await createUser();
    const exam = await insertExam(userId);
    const first = await insertQuestion(exam.id, userId, { question_order: 1 });
    const second = await insertQuestion(exam.id, userId, {
      question_order: 2,
      correct_answer: "B",
    });
    const attempt = await insertAttempt(exam.id, userId, {
      status: "completed",
      started_at: STARTED_AT,
      submitted_at: SUBMITTED_AT,
      score: 1,
      total_questions: 2,
      correct_answers: 1,
      percentage: 50,
      passed: false,
    });
    await insertAnswer(attempt.id, userId, first.id);
    await insertAnswer(attempt.id, userId, second.id, {
      selected_answer: "A",
      is_correct: false,
    });
    return { userId, exam, first, second, attempt };
  }

  it("lets a user be deleted even though two cascade paths reach the answers", async () => {
    // The case an immediate check breaks. The cascade reaches attempt_answers by
    // exam → questions AND by exam → attempts → answers, and PostgreSQL runs
    // each as its own statement — so RESTRICT and plain NO ACTION both fire
    // while the sibling cascade has not run yet and abort the whole delete.
    const { userId, exam } = await gradedAttempt();

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    for (const [table, column, value] of [
      ["exams", "id", exam.id],
      ["exam_questions", "exam_id", exam.id],
      ["exam_attempts", "exam_id", exam.id],
    ]) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ${table} WHERE ${column} = $1`,
        [value],
      );
      assert.equal(rows.length, 0, `${table} still had rows`);
    }
  });

  it("lets an exam be deleted, taking its questions, attempts and answers", async () => {
    const { exam, attempt } = await gradedAttempt();

    await pool.query("DELETE FROM exams WHERE id = $1", [exam.id]);

    const { rows } = await pool.query(
      "SELECT 1 FROM attempt_answers WHERE attempt_id = $1",
      [attempt.id],
    );
    assert.equal(rows.length, 0);
  });

  it("refuses to delete one question of an attempted exam", async () => {
    // The case CASCADE would break. Deleting a single question would leave an
    // attempt whose total_questions no longer matches its questions — a
    // silently corrupted grade, and corrupted input for SP-V2-007.
    //
    // The error surfaces at COMMIT rather than at the statement, which is what
    // "DEFERRABLE INITIALLY DEFERRED" means and what withTransaction already
    // handles: it rolls back on any throw, wherever it comes from.
    const { first, attempt } = await gradedAttempt();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The DELETE itself succeeds — the check is deferred to COMMIT.
      await client.query("DELETE FROM exam_questions WHERE id = $1", [first.id]);
      await assert.rejects(
        client.query("COMMIT"),
        (err) => {
          assert.equal(err.constraint, "attempt_answers_question_fkey");
          return true;
        },
        "COMMIT should have been refused",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    // The question and the answer both survive the rolled-back transaction.
    const { rows } = await pool.query(
      "SELECT 1 FROM exam_questions WHERE id = $1",
      [first.id],
    );
    assert.equal(rows.length, 1, "the question was deleted after all");

    const { rows: answers } = await pool.query(
      "SELECT 1 FROM attempt_answers WHERE attempt_id = $1",
      [attempt.id],
    );
    assert.equal(answers.length, 2, "graded history was lost");
  });

  it("allows deleting a question nobody has answered", async () => {
    // The deferred FK constrains answered questions, not all of them — an exam
    // that has never been sat is still editable by a future migration.
    const userId = await createUser();
    const exam = await insertExam(userId);
    const question = await insertQuestion(exam.id, userId);

    await pool.query("DELETE FROM exam_questions WHERE id = $1", [question.id]);

    const { rows } = await pool.query(
      "SELECT 1 FROM exam_questions WHERE id = $1",
      [question.id],
    );
    assert.equal(rows.length, 0);
  });
});

// ── indexes and comments ────────────────────────────────────────────────────

describe("the migration's indexes exist", () => {
  it("creates the four indexes the API's reads and cascades need", async () => {
    const { rows } = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('exams', 'exam_questions', 'exam_attempts',
                            'attempt_answers')
        ORDER BY indexname`,
    );
    const names = rows.map((row) => row.indexname);

    for (const expected of [
      "idx_exams_user_created",
      "idx_exam_attempts_user_started",
      "idx_exam_attempts_exam",
      "idx_exam_questions_source_material",
    ]) {
      assert.ok(names.includes(expected), `${expected} is missing: ${names.join(", ")}`);
    }
  });

  it("indexes the source material partially, skipping the null rows", async () => {
    // A topic-only exam's questions have no source, and no query wants those
    // rows — so the index carries only the ones that can be found by it.
    const { rows } = await pool.query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_exam_questions_source_material'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /WHERE \(?source_material_id IS NOT NULL\)?/);
  });

  it("documents the invariants a CHECK cannot express", async () => {
    // The COMMENT ON COLUMN statements are DDL, so they ship with the schema and
    // \d+ shows them. A reader who finds is_correct in the table needs to know
    // it is never accepted from a client.
    const { rows } = await pool.query(
      `SELECT col_description(
                ('public.' || table_name)::regclass, ordinal_position
              ) AS comment
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'attempt_answers'
          AND column_name = 'is_correct'`,
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0].comment, /never accepted from a client/i);
  });
});
