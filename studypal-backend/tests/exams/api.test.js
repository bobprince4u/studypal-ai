/**
 * The exam HTTP API — SP-V2-006 §9, §11, §12, §15, §20, and §16's "ownership",
 * "attempt creation", "submission" and "grading" groups.
 *
 * Black box. A real server in a child process, a real PostgreSQL database, a
 * fake provider at the network boundary — nothing in this file imports from
 * src/. What it asserts is what a client would observe, which is the only level
 * at which §12's ownership rule and §5's "the server is authoritative" mean
 * anything.
 *
 * THE THREE CLAIMS THIS FILE IS REALLY ABOUT
 * ------------------------------------------
 * THE ANSWER KEY IS NOT REACHABLE WHILE THE EXAM IS BEING TAKEN (§4, §9). Every
 * response a learner can obtain before submitting is walked key by key, and a
 * `correctAnswer` or `explanation` anywhere in it is a failure. Not "the field
 * is filtered": the field must not be in the payload at all, at any depth. The
 * same walk run after submission asserts the opposite, because §9 permits the
 * key from that moment and a test that only proved absence would pass against a
 * server that never returned it.
 *
 * THE SCORE IS THE SERVER'S, COMPUTED FROM THE DATABASE'S KEY (§5, §10). The
 * submissions below are built by reading `exam_questions.correct_answer` out of
 * PostgreSQL and choosing answers against it, so a grader marking against
 * anything else — the request, the model's echo, a cached copy — gets a
 * different number than the one asserted. And one submission sends `isCorrect`,
 * `score`, `percentage`, `passed` and `correctAnswer` from the client, all
 * flattering, all of which must change nothing.
 *
 * KNOWING AN ID IS NOT AUTHORISATION (§12). Every read and write is tried twice:
 * once by the learner who owns the exam and once by a second, equally real
 * learner who does not. The second must get 404 — not 403, which would confirm
 * the id exists — and the identical body, so the two cases stay
 * indistinguishable from outside.
 *
 * WHAT IS NOT HERE
 * ----------------
 * The AI-output matrix (FAKE_EXAM_MODE) lives in
 * tests/exams/generation.test.js, because each mode needs its own server
 * process — tests/helpers/server-harness.mjs fixes the child's environment at
 * spawn. This suite runs entirely on the default "valid" mode.
 *
 * The grader's arithmetic — rounding, the threshold, the empty exam — is
 * exercised directly in tests/exams/grading.test.js, where a case costs
 * microseconds instead of a generation plus an attempt plus a submission. What
 * is asserted here is the part that file documents it cannot reach: that the key
 * came from the database, that the result was persisted, and that a client
 * cannot supply any of it.
 *
 *   node --test tests/exams/api.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";
import { CANNED_EXAM_TITLE } from "../helpers/fake-gemini.mjs";
import { fakeEmbedding } from "../fixtures/vectors.mjs";

/** The exact key set of an exam in a response body (§20). */
const EXAM_KEYS = [
  "createdAt",
  "difficulty",
  "id",
  "materialIds",
  "questionCount",
  "questions",
  "sourceType",
  "status",
  "subject",
  "title",
  "topics",
  "updatedAt",
];

/** One question as a learner taking the exam sees it. No key, no explanation. */
const TAKING_QUESTION_KEYS = [
  "id",
  "options",
  "order",
  "question",
  "sourceMaterialId",
  "type",
];

/** The same after submission, when §9 permits the answer (§4's "AFTER"). */
const GRADED_QUESTION_KEYS = [
  ...TAKING_QUESTION_KEYS,
  "correctAnswer",
  "explanation",
  "isCorrect",
  "selectedAnswer",
].sort();

/** The five result fields, present and null until an attempt is graded. */
const RESULT_KEYS = [
  "correctAnswers",
  "passed",
  "percentage",
  "score",
  "totalQuestions",
];

/** An attempt as returned by POST /attempts: the attempt, plus the exam to sit. */
const START_ATTEMPT_KEYS = [
  "id",
  "examId",
  "status",
  "startedAt",
  "submittedAt",
  ...RESULT_KEYS,
  "exam",
].sort();

/** An attempt as returned by GET /attempts/:id and by submit. */
const ATTEMPT_KEYS = [
  "id",
  "examId",
  "status",
  "startedAt",
  "submittedAt",
  ...RESULT_KEYS,
  "questions",
].sort();

/** A row of the history listing (§9's GET /api/exam-attempts). */
const SUMMARY_KEYS = [
  "id",
  "examId",
  "status",
  "startedAt",
  "submittedAt",
  "examTitle",
  "examSubject",
  "examDifficulty",
  ...RESULT_KEYS,
].sort();

let server;
let pool;

before(async () => {
  server = await startServer({ authenticatedFixtures: true, label: "exam-api" });
  pool = new pg.Pool({ connectionString: server.databaseUrl, max: 6 });
});

after(async () => {
  await pool?.end();
  await server?.stop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Create a user row directly.
 *
 * Exam endpoints deliberately do NOT upsert users — see requireUserId in
 * src/exams/exam.service.js. Going through the database rather than through
 * POST /api/ask also keeps these fixtures independent of another feature's
 * behaviour.
 */
async function makeUser(prefix = "exam") {
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
             $2, $3, 'application/pdf', 4096, 'ready', 'indexed')
     RETURNING id`,
    [username, filename, `exam-api-${(materialSequence += 1)}-${Date.now()}.pdf`],
  );
  return rows[0].id;
}

/**
 * Give a material one indexed chunk, so retrieval has something to return.
 *
 * The vector comes from tests/fixtures/vectors.mjs — the same function the fake
 * provider answers `:batchEmbedContents` with — so a chunk mentioning
 * "photosynthesis" and a retrieval query mentioning it share an axis and score
 * 1.0, comfortably above the 0.5 threshold. Written as a literal rather than by
 * running the indexing pipeline: this suite is about the exam API, and going
 * through an upload would make every material test depend on SP-V2-003's parser.
 */
async function addChunk(materialId, content, index = 0) {
  await pool.query(
    `INSERT INTO material_chunks
            (material_id, chunk_index, content, char_count, embedding)
     VALUES ($1, $2, $3, char_length($3), $4::vector)`,
    [materialId, index, content, `[${fakeEmbedding(content).join(",")}]`],
  );
}

/** A valid creation body. Override any field, including to an invalid value. */
function examBody(username, overrides = {}) {
  return {
    username,
    subject: "Biology",
    topics: ["Photosynthesis"],
    difficulty: "medium",
    questionCount: 4,
    ...overrides,
  };
}

const createExam = (body) => server.request("POST", "/api/exams", { json: body });

async function createExamOk(username, overrides) {
  const res = await createExam(examBody(username, overrides));
  assert.equal(res.status, 201, `create failed: ${res.text}`);
  return res.body;
}

const getExam = (id, username) =>
  server.request("GET", `/api/exams/${id}?username=${encodeURIComponent(username)}`);

const startAttempt = (examId, body) =>
  server.request("POST", `/api/exams/${examId}/attempts`, { json: body });

const getAttempt = (examId, attemptId, username) =>
  server.request(
    "GET",
    `/api/exams/${examId}/attempts/${attemptId}?username=${encodeURIComponent(username)}`,
  );

const submit = (examId, attemptId, body) =>
  server.request("POST", `/api/exams/${examId}/attempts/${attemptId}/submit`, {
    json: body,
  });

const listAttempts = (username) =>
  server.request("GET", `/api/exam-attempts?username=${encodeURIComponent(username)}`);

/** Create an exam and start an attempt on it — the setup most tests below need. */
async function sitExam(username, overrides) {
  const exam = await createExamOk(username, overrides);
  const res = await startAttempt(exam.id, { username });
  assert.equal(res.status, 201, `start failed: ${res.text}`);
  return { exam, attempt: res.body };
}

// ── reading the truth out of the database ───────────────────────────────────

/**
 * The answer key as PostgreSQL holds it.
 *
 * THE POINT OF THIS SUITE'S GRADING ASSERTIONS. Every submission below is
 * constructed from these rows, so a grader marking against anything other than
 * `exam_questions.correct_answer` — the request body, the model's response, a
 * copy cached at generation time — produces a different score than the one
 * asserted. Reading it through SQL rather than through the API is not a
 * shortcut: the API is precisely what must not reveal it.
 */
async function answerKey(examId) {
  const { rows } = await pool.query(
    `SELECT id, correct_answer FROM exam_questions
      WHERE exam_id = $1 ORDER BY question_order ASC`,
    [examId],
  );
  return rows.map((row) => ({ id: row.id, correctAnswer: row.correct_answer }));
}

/** Every answer stored for an attempt, as the database has it. */
async function storedAnswers(attemptId) {
  const { rows } = await pool.query(
    `SELECT exam_question_id, selected_answer, is_correct
       FROM attempt_answers WHERE attempt_id = $1
      ORDER BY exam_question_id ASC`,
    [attemptId],
  );
  return rows;
}

/** The attempt row itself — status and the five result columns. */
async function storedAttempt(attemptId) {
  const { rows } = await pool.query(
    `SELECT status, submitted_at, score, total_questions, correct_answers,
            percentage, passed
       FROM exam_attempts WHERE id = $1`,
    [attemptId],
  );
  return rows[0];
}

/** A full-marks submission, built from the database's own key. */
async function perfectAnswers(examId) {
  const key = await answerKey(examId);
  return key.map((entry) => ({
    questionId: entry.id,
    answer: entry.correctAnswer,
  }));
}

/**
 * An option id for `questionId` that is NOT the correct one.
 *
 * Chosen from the question's own options rather than invented, because the
 * service rejects an answer that is not an option of that question with a 400 —
 * a wrong answer and a malformed one are different cases, and a test meaning the
 * first must not accidentally exercise the second.
 */
async function wrongAnswerFor(questionId) {
  const { rows } = await pool.query(
    "SELECT options, correct_answer FROM exam_questions WHERE id = $1",
    [questionId],
  );
  const wrong = rows[0].options.find(
    (option) => String(option.id) !== rows[0].correct_answer,
  );
  assert.ok(wrong, "every question must have at least one incorrect option");
  return String(wrong.id);
}

// ── assertions ──────────────────────────────────────────────────────────────

/** An error response: right status, JSON, an `error` string, nothing internal. */
function assertJsonError(res, status, message) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(
    res.headers.get("content-type") ?? "",
    /application\/json/,
    "every error response must remain JSON (§15)",
  );
  assert.equal(typeof res.body?.error, "string", `no error string in ${res.text}`);
  if (message !== undefined) assert.equal(res.body.error, message);
  assertNoInternals(res.body);
}

/** §15: nothing internal in any body, success or failure. */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /"user_?id"/i, "no user id");
  assert.doesNotMatch(json, /storage_?[Kk]ey/, "no storage key");
  assert.doesNotMatch(json, /\/tmp\/|\/home\/|studypal-test-uploads/, "no path");
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, "no stack frame");
  assert.doesNotMatch(
    json,
    /generativelanguage|googleapis|GEMINI_API_KEY/i,
    "no provider detail",
  );
  assert.doesNotMatch(
    json,
    /SELECT |INSERT INTO|exam_questions|attempt_answers/i,
    "no SQL",
  );
}

/**
 * Walk every key at every depth and refuse the two the answer key lives in.
 *
 * §4: "The client MUST NOT receive the correct answer while taking the exam."
 * The assertion is structural rather than a string comparison against the key,
 * and deliberately so: an option id is a single letter, and "A" appears in every
 * multiple-choice question's own options. Searching the body for the key's VALUE
 * would find it in legitimate content and fail on a correct server; searching for
 * the FIELD finds it only where it should not be.
 *
 * `correctAnswers` — the count, null until an attempt is graded — is a different
 * field and is checked separately, by name, where it belongs.
 */
function assertNoAnswerKey(payload, where) {
  const forbidden = new Set(["correctAnswer", "explanation"]);
  const seen = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (forbidden.has(key)) seen.push(`${path}.${key}`);
      walk(value, `${path}.${key}`);
    }
  };

  walk(payload, "$");
  assert.deepEqual(seen, [], `${where} exposed the answer key at ${seen.join(", ")}`);
}

/** The five result fields present and null — an attempt that is not yet graded. */
function assertUngraded(attempt) {
  for (const field of RESULT_KEYS) {
    assert.ok(field in attempt, `${field} must be present, not absent`);
    assert.equal(attempt[field], null, `${field} must be null before grading`);
  }
  assert.equal(attempt.status, "in_progress");
  assert.equal(attempt.submittedAt, null);
}

// ── §9: the creation contract ───────────────────────────────────────────────

describe("POST /api/exams returns the documented shape (§9, §20)", () => {
  it("creates an exam with 201 and every documented field", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username);

    // The exact key set, so a field cannot be added to the public contract or
    // dropped from it without this test saying so.
    assert.deepEqual(Object.keys(exam).sort(), [...EXAM_KEYS].sort());

    assert.equal(typeof exam.id, "number");
    assert.equal(exam.title, CANNED_EXAM_TITLE);
    assert.equal(exam.subject, "Biology");
    assert.equal(exam.difficulty, "medium");
    assert.equal(exam.questionCount, 4);
    assert.equal(exam.status, "ready", "a new exam is ready to sit");
    assert.equal(exam.sourceType, "topics", "no materials were named");
    assert.deepEqual(exam.topics, ["Photosynthesis"]);
    assert.deepEqual(exam.materialIds, []);
    assert.match(exam.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assertNoInternals(exam);
  });

  it("returns exactly the requested number of questions, in order", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username, { questionCount: 6 });

    assert.equal(exam.questions.length, 6, "§8: the count must equal the request");
    assert.deepEqual(
      exam.questions.map((question) => question.order),
      [1, 2, 3, 4, 5, 6],
      "question_order is 1-based and contiguous",
    );

    for (const question of exam.questions) {
      assert.deepEqual(Object.keys(question).sort(), [...TAKING_QUESTION_KEYS].sort());
      assert.equal(typeof question.id, "number");
      assert.ok(question.question.length > 0);
      assert.ok(["multiple_choice", "true_false"].includes(question.type));
      assert.equal(question.sourceMaterialId, null, "no materials were named");

      const expectedOptions = question.type === "multiple_choice" ? 4 : 2;
      assert.equal(question.options.length, expectedOptions, "§8's option counts");
      const ids = question.options.map((option) => option.id);
      assert.equal(new Set(ids).size, ids.length, "option ids are unique");
      for (const option of question.options) {
        assert.equal(typeof option.id, "string");
        assert.ok(option.text.length > 0);
      }
    }
  });

  it("never returns the answer key at creation (§4)", async () => {
    // The learner has not sat the exam yet. §4's rule is about the moment, not
    // about the endpoint — this response is as much "while taking the exam" as
    // the attempt one is.
    const username = await makeUser();
    const exam = await createExamOk(username);

    assertNoAnswerKey(exam, "POST /api/exams");

    // And the key really does exist, so the assertion above is about what is
    // withheld rather than about what was never generated.
    const key = await answerKey(exam.id);
    assert.equal(key.length, 4);
    for (const entry of key) assert.ok(entry.correctAnswer.length > 0);
  });

  it("applies the documented defaults when fields are omitted", async () => {
    const username = await makeUser();
    const res = await createExam({ username, subject: "Chemistry" });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.difficulty, "medium", "the middle of the three");
    assert.equal(res.body.questionCount, 10, "config.exam.defaultQuestionCount");
    assert.equal(res.body.questions.length, 10);
    assert.deepEqual(res.body.topics, [], "topics are optional (§2)");

    // Both types by default: a paper of one kind is a weaker test than a mixed
    // one, and the fake alternates whenever both are allowed.
    const types = new Set(res.body.questions.map((question) => question.type));
    assert.deepEqual([...types].sort(), ["multiple_choice", "true_false"]);
  });

  it("honours a narrowed question type", async () => {
    const username = await makeUser();

    const mcq = await createExamOk(username, {
      questionTypes: ["multiple_choice"],
    });
    for (const question of mcq.questions) {
      assert.equal(question.type, "multiple_choice");
      assert.equal(question.options.length, 4);
    }

    const boolean = await createExamOk(username, {
      questionTypes: ["true_false"],
    });
    for (const question of boolean.questions) {
      assert.equal(question.type, "true_false");
      assert.deepEqual(
        question.options.map((option) => option.id),
        ["true", "false"],
      );
    }
  });

  it("ignores a client-supplied id, status, score or source type (§5)", async () => {
    // Fields a client might send hopefully. None is in the accepted input set,
    // and none may influence the stored exam.
    const username = await makeUser();
    const exam = await createExamOk(username, {
      id: 999_999,
      status: "cancelled",
      sourceType: "material",
      score: 100,
      title: "An Exam I Named Myself",
      questions: [{ question: "Mine", correctAnswer: "A" }],
    });

    assert.notEqual(exam.id, 999_999);
    assert.equal(exam.status, "ready");
    assert.equal(exam.sourceType, "topics");
    assert.equal(exam.title, CANNED_EXAM_TITLE, "the title comes from generation");
    assert.equal(exam.questions.length, 4, "the client's question list was ignored");
  });

  it("trims and de-duplicates what the learner typed", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username, {
      subject: "  Physics  ",
      topics: ["  Optics  ", "", "   "],
      questionTypes: ["true_false", "true_false"],
    });

    assert.equal(exam.subject, "Physics");
    assert.deepEqual(exam.topics, ["Optics"], "blank entries are a form artefact");
    assert.equal(exam.questions.length, 4);
  });
});

// ── §15: the rejections ─────────────────────────────────────────────────────

describe("POST /api/exams rejects bad input (§15)", () => {
  it("requires authentication and a subject", async () => {
    assertJsonError(
      await createExam({ subject: "Biology" }),
      401,
      "Authentication required.",
    );
    assertJsonError(
      await createExam({ username: "   ", subject: "Biology" }),
      400,
      "Username is required.",
    );

    const username = await makeUser();
    assertJsonError(await createExam({ username }), 400, "Subject is required.");
    assertJsonError(
      await createExam({ username, subject: "   " }),
      400,
      "Subject is required.",
    );
  });

  it("rejects a difficulty outside the three", async () => {
    const username = await makeUser();
    for (const difficulty of ["extreme", "EASY", 3, null]) {
      const res = await createExam(examBody(username, { difficulty }));
      if (difficulty === null) {
        assert.equal(res.status, 201, "null means 'not stated', and defaults");
        continue;
      }
      assertJsonError(res, 400, "Difficulty must be one of: easy, medium, hard.");
    }
  });

  it("bounds the question count at both ends", async () => {
    const username = await makeUser();

    assertJsonError(
      await createExam(examBody(username, { questionCount: 0 })),
      400,
      "An exam must have at least 1 question(s).",
    );
    assertJsonError(
      await createExam(examBody(username, { questionCount: 51 })),
      400,
      "An exam may have at most 50 questions.",
    );
    assertJsonError(
      await createExam(examBody(username, { questionCount: 4.5 })),
      400,
      "Question count must be an integer.",
    );
    assertJsonError(
      await createExam(examBody(username, { questionCount: "4" })),
      400,
      "Question count must be an integer.",
    );
  });

  it("rejects a question type §2 rules out of scope", async () => {
    const username = await makeUser();

    for (const type of ["essay", "short_answer", "coding"]) {
      assertJsonError(
        await createExam(examBody(username, { questionTypes: [type] })),
        400,
        "Question types must be one of: multiple_choice, true_false.",
      );
    }
    assertJsonError(
      await createExam(examBody(username, { questionTypes: [] })),
      400,
      "At least one question type is required.",
    );
    assertJsonError(
      await createExam(examBody(username, { questionTypes: "multiple_choice" })),
      400,
      "Question types must be an array.",
    );
  });

  it("rejects malformed topics and material ids", async () => {
    const username = await makeUser();

    assertJsonError(
      await createExam(examBody(username, { topics: "Photosynthesis" })),
      400,
      "Topics must be an array.",
    );
    assertJsonError(
      await createExam(examBody(username, { topics: [42] })),
      400,
      "Each topic must be a string.",
    );
    assertJsonError(
      await createExam(
        examBody(username, { topics: Array.from({ length: 21 }, (_, i) => `T${i}`) }),
      ),
      400,
      "An exam may cover at most 20 topics.",
    );
    assertJsonError(
      await createExam(examBody(username, { materialIds: 7 })),
      400,
      "Material ids must be an array.",
    );
    assertJsonError(
      await createExam(examBody(username, { materialIds: [0] })),
      400,
      "Each material id must be a positive integer.",
    );
  });
  it("creates exams only for an authenticated existing account", async () => {
    const res = await createExam(examBody("nobody_at_all_1234"));
    assert.equal(res.status, 201);
  });

  it("persists nothing when the request is refused", async () => {
    const username = await makeUser();
    await createExam(examBody(username, { questionCount: 0 }));
    await createExam(examBody(username, { questionTypes: ["essay"] }));

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS exams FROM exams
        WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [username],
    );
    assert.equal(rows[0].exams, 0);
  });
});

// ── §6 and §14: generating from the learner's own documents ─────────────────

describe("material-grounded generation (§6, §14)", () => {
  it("records the material and the chunk a question came from", async () => {
    const username = await makeUser("grounded");
    const materialId = await makeMaterial(username, "biology.pdf");
    await addChunk(
      materialId,
      "Photosynthesis converts light energy into chemical energy in the chloroplast.",
    );

    const exam = await createExamOk(username, { materialIds: [materialId] });

    assert.equal(exam.sourceType, "material", "material actually reached the model");
    assert.deepEqual(exam.materialIds, [materialId]);
    assert.equal(
      typeof exam.materialIds[0],
      "number",
      "bigint[] must not surface as strings at the API boundary",
    );

    for (const question of exam.questions) {
      assert.equal(question.sourceMaterialId, materialId, "§14's traceability");
    }

    // §14 also asks for the chunk, which the API does not return — it is an
    // internal surrogate key SP-V2-007 will read, so it is asserted at the
    // database instead.
    const { rows } = await pool.query(
      `SELECT DISTINCT source_chunk_id IS NOT NULL AS has_chunk
         FROM exam_questions WHERE exam_id = $1`,
      [exam.id],
    );
    assert.deepEqual(rows, [{ has_chunk: true }]);
  });

  it("falls back to a topic-only exam when nothing is retrievable", async () => {
    // The material is owned and named, but has no indexed chunk — so no context
    // reached the model, and recording the exam as material-sourced would
    // misdescribe it to SP-V2-007.
    const username = await makeUser("empty-material");
    const materialId = await makeMaterial(username, "unindexed.pdf");

    const exam = await createExamOk(username, { materialIds: [materialId] });

    assert.equal(exam.sourceType, "topics");
    assert.deepEqual(exam.materialIds, [materialId], "what was asked for is kept");
    for (const question of exam.questions) {
      assert.equal(question.sourceMaterialId, null);
    }
  });

  it("refuses another learner's material, and generates nothing (§6, §12)", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    const materialId = await makeMaterial(owner, "private.pdf");
    await addChunk(materialId, "Photosynthesis happens in the chloroplast.");

    assertJsonError(
      await createExam(examBody(stranger, { materialIds: [materialId] })),
      404,
      "One or more materials were not found.",
    );

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS exams FROM exams
        WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [stranger],
    );
    assert.equal(rows[0].exams, 0, "no exam, not an exam grounded in nothing");
  });

  it("refuses the whole request when one of several materials is not theirs", async () => {
    // §6: an exam on four of the five documents a learner named, with nothing in
    // the response to say which is missing, is not the exam they asked for.
    const username = await makeUser("partial");
    const stranger = await makeUser("partial-other");
    const mine = await makeMaterial(username, "mine.pdf");
    const theirs = await makeMaterial(stranger, "theirs.pdf");
    await addChunk(mine, "Photosynthesis in the chloroplast.");

    assertJsonError(
      await createExam(examBody(username, { materialIds: [mine, theirs] })),
      404,
      "One or more materials were not found.",
    );
  });
});

// ── §9: reading an exam back ────────────────────────────────────────────────

describe("GET /api/exams/:id returns one exam without its key (§9)", () => {
  it("reads back exactly what creation returned", async () => {
    const username = await makeUser();
    const created = await createExamOk(username);
    const res = await getExam(created.id, username);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, created, "the same exam, field for field");
    assertNoAnswerKey(res.body, "GET /api/exams/:id");
  });

  it("rejects an id that is not a positive integer", async () => {
    const username = await makeUser();
    for (const id of ["abc", "-1", "1.5", "0"]) {
      assertJsonError(
        await getExam(id, username),
        400,
        "Exam id must be a positive integer.",
      );
    }
  });

  it("requires a authenticated session in the query string", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username);
    assertJsonError(
      await server.request("GET", `/api/exams/${exam.id}`),
      401,
      "Authentication required.",
    );
  });

  it("answers an unknown id with 404", async () => {
    const username = await makeUser();
    assertJsonError(await getExam(9_999_999, username), 404, "Exam not found.");
  });
});

// ── §12: the ownership matrix ───────────────────────────────────────────────

describe("knowing an exam id is not authorisation (§12)", () => {
  it("refuses every endpoint to a second learner, identically", async () => {
    const owner = await makeUser("mine");
    const stranger = await makeUser("theirs");
    const { exam, attempt } = await sitExam(owner);

    // The owner's own 404 for an id that does not exist, to compare against.
    const baseline = (await getExam(9_999_999, owner)).body;

    const forbidden = [
      ["GET exam", await getExam(exam.id, stranger), "Exam not found."],
      [
        "start attempt",
        await startAttempt(exam.id, { username: stranger }),
        "Exam not found.",
      ],
      [
        "read attempt",
        await getAttempt(exam.id, attempt.id, stranger),
        "Exam attempt not found.",
      ],
      [
        "submit attempt",
        await submit(exam.id, attempt.id, { username: stranger, answers: [] }),
        "Exam attempt not found.",
      ],
    ];

    for (const [what, res, message] of forbidden) {
      assert.equal(res.status, 404, `${what} must be 404, not ${res.status}`);
      assert.equal(res.body.error, message, what);
      assertNoInternals(res.body);
    }

    // 404 and not 403: the body for someone else's exam is the body for an exam
    // that does not exist, so the two are indistinguishable from outside.
    assert.deepEqual(forbidden[0][1].body, baseline);

    // And nothing the stranger did touched the owner's exam.
    const after = await getExam(exam.id, owner);
    assert.equal(after.status, 200);
    assert.equal(after.body.status, "ready");
    const attemptRow = await storedAttempt(attempt.id);
    assert.equal(attemptRow.status, "in_progress", "the stranger's submit wrote nothing");
  });

  it("refuses an attempt that belongs to another exam of the same learner", async () => {
    // §9's "verify attempt belongs to exam", which ownership alone does not
    // cover: both exams and the attempt are this learner's.
    const username = await makeUser("two-exams");
    const { attempt } = await sitExam(username);
    const other = await createExamOk(username, { subject: "Chemistry" });

    assertJsonError(
      await getAttempt(other.id, attempt.id, username),
      404,
      "Exam attempt not found.",
    );
    assertJsonError(
      await submit(other.id, attempt.id, { username, answers: [] }),
      404,
      "Exam attempt not found.",
    );

    const row = await storedAttempt(attempt.id);
    assert.equal(row.status, "in_progress");
  });

  it("does not let a learner answer another exam's questions", async () => {
    const username = await makeUser("cross-question");
    const { exam, attempt } = await sitExam(username);
    const other = await createExamOk(username, { subject: "Physics" });
    const otherKey = await answerKey(other.id);

    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [
          { questionId: otherKey[0].id, answer: otherKey[0].correctAnswer },
        ],
      }),
      400,
      "One or more answers refer to an unknown question.",
    );
  });
});

// ── §9, §11: starting an attempt ────────────────────────────────────────────

describe("POST /api/exams/:id/attempts starts one attempt (§9, §11)", () => {
  it("returns 201, an in-progress attempt and the exam to sit", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username);
    const res = await startAttempt(exam.id, { username });

    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), START_ATTEMPT_KEYS);

    assert.equal(typeof res.body.id, "number");
    assert.equal(res.body.examId, exam.id);
    assertUngraded(res.body);
    assert.match(res.body.startedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    assert.deepEqual(res.body.exam.questions, exam.questions, "the same paper");
    assertNoAnswerKey(res.body, "POST /api/exams/:id/attempts");
    assertNoInternals(res.body);
  });

  it("allows several attempts at the same exam", async () => {
    // §11 has no rule against re-sitting, and SP-V2-007 is going to compare
    // attempts at the same paper — so two attempts must be two rows, not an
    // overwrite of the first.
    const username = await makeUser("resit");
    const exam = await createExamOk(username);

    const first = (await startAttempt(exam.id, { username })).body;
    const second = (await startAttempt(exam.id, { username })).body;

    assert.notEqual(first.id, second.id);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM exam_attempts WHERE exam_id = $1",
      [exam.id],
    );
    assert.equal(rows[0].n, 2);
  });

  it("requires a authenticated session in the body", async () => {
    const username = await makeUser();
    const exam = await createExamOk(username);
    assertJsonError(await startAttempt(exam.id, {}), 401, "Authentication required.");
  });

  it("answers an unknown exam with 404, and a bad id with 400", async () => {
    const username = await makeUser();
    assertJsonError(
      await startAttempt(9_999_999, { username }),
      404,
      "Exam not found.",
    );
    assertJsonError(
      await startAttempt("abc", { username }),
      400,
      "Exam id must be a positive integer.",
    );
  });

  it("refuses an exam that is no longer available (§11)", async () => {
    // `cancelled` is a status the schema accepts and no endpoint writes — see
    // the header of src/exams/exam.routes.js. Set here directly, because the
    // service's guard against it should hold whether or not an endpoint exists
    // to reach that state.
    const username = await makeUser("cancelled");
    const exam = await createExamOk(username);
    await pool.query("UPDATE exams SET status = 'cancelled' WHERE id = $1", [exam.id]);

    assertJsonError(
      await startAttempt(exam.id, { username }),
      409,
      "This exam is no longer available.",
    );

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM exam_attempts WHERE exam_id = $1",
      [exam.id],
    );
    assert.equal(rows[0].n, 0);
  });
});

// ── §5, §10: the grading that matters ───────────────────────────────────────

describe("submission is graded by the server, from the database's key (§5, §10)", () => {
  it("marks a perfect paper 100% and passes it", async () => {
    const username = await makeUser("perfect");
    const { exam, attempt } = await sitExam(username);

    const res = await submit(exam.id, attempt.id, {
      username,
      answers: await perfectAnswers(exam.id),
    });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), ATTEMPT_KEYS);
    assert.equal(res.body.status, "completed");
    assert.equal(res.body.score, 4);
    assert.equal(res.body.correctAnswers, 4);
    assert.equal(res.body.totalQuestions, 4);
    assert.equal(res.body.percentage, 100);
    assert.equal(res.body.passed, true);
    assert.match(res.body.submittedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assertNoInternals(res.body);
  });

  it("marks a wrong answer wrong, and says which (§9's post-submission body)", async () => {
    const username = await makeUser("one-wrong");
    const { exam, attempt } = await sitExam(username);

    const key = await answerKey(exam.id);
    const spoiled = key[1].id;
    const wrong = await wrongAnswerFor(spoiled);
    const answers = key.map((entry) => ({
      questionId: entry.id,
      answer: entry.id === spoiled ? wrong : entry.correctAnswer,
    }));

    const res = await submit(exam.id, attempt.id, { username, answers });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.correctAnswers, 3);
    assert.equal(res.body.percentage, 75, "3/4 = 75");
    assert.equal(res.body.passed, true, "75 clears the threshold of 70");

    const graded = res.body.questions.find((question) => question.id === spoiled);
    assert.equal(graded.isCorrect, false);
    assert.equal(graded.selectedAnswer, wrong);
    assert.equal(
      graded.correctAnswer,
      key[1].correctAnswer,
      "the key in the response is the key in the database",
    );
    assert.equal(typeof graded.explanation, "string");
    assert.ok(graded.explanation.length > 0);

    for (const question of res.body.questions) {
      assert.deepEqual(Object.keys(question).sort(), GRADED_QUESTION_KEYS);
    }
  });

  it("rounds the percentage rather than truncating it (§10)", async () => {
    // 2/3 is 66.67. A grader written with Math.floor answers 66 and fails only
    // here — every whole-number case above passes either way.
    const username = await makeUser("rounding");
    const { exam, attempt } = await sitExam(username, { questionCount: 3 });

    const key = await answerKey(exam.id);
    const res = await submit(exam.id, attempt.id, {
      username,
      answers: [
        { questionId: key[0].id, answer: key[0].correctAnswer },
        { questionId: key[1].id, answer: key[1].correctAnswer },
        { questionId: key[2].id, answer: await wrongAnswerFor(key[2].id) },
      ],
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.correctAnswers, 2);
    assert.equal(res.body.percentage, 67);
    assert.equal(res.body.passed, false, "67 is below the threshold of 70");
  });

  it("counts an unanswered question as wrong, without inventing a row", async () => {
    // The percentage is over the paper, not over what was attempted — otherwise
    // skipping the hard questions is the optimal strategy.
    const username = await makeUser("skipped");
    const { exam, attempt } = await sitExam(username);

    const key = await answerKey(exam.id);
    const res = await submit(exam.id, attempt.id, {
      username,
      answers: [
        { questionId: key[0].id, answer: key[0].correctAnswer },
        { questionId: key[1].id, answer: key[1].correctAnswer },
      ],
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.totalQuestions, 4, "the paper had four questions");
    assert.equal(res.body.correctAnswers, 2);
    assert.equal(res.body.percentage, 50);

    const skipped = res.body.questions.find((question) => question.id === key[3].id);
    assert.equal(skipped.selectedAnswer, null, "null, rather than absent");
    assert.equal(skipped.isCorrect, false, "false, rather than null");

    // Two answers submitted, two rows stored: the skipped questions have no row
    // saying the learner chose nothing.
    assert.equal((await storedAnswers(attempt.id)).length, 2);
  });

  it("accepts an empty submission and scores it zero (§11)", async () => {
    // A learner who starts an exam and submits without answering has sat it.
    // Refusing the submission would leave the attempt in_progress forever, and
    // §11's lifecycle has no third state for it.
    const username = await makeUser("blank");
    const { exam, attempt } = await sitExam(username);

    const res = await submit(exam.id, attempt.id, { username, answers: [] });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, "completed");
    assert.equal(res.body.score, 0);
    assert.equal(res.body.percentage, 0);
    assert.equal(res.body.passed, false);
    assert.deepEqual(await storedAnswers(attempt.id), []);
  });

  it("ignores a score, a percentage, a pass and an isCorrect sent by the client (§5)", async () => {
    // The §5 cheat attempt, in one request: every authoritative field a client
    // might hope to supply, all flattering, on a paper that is mostly wrong.
    const username = await makeUser("cheat");
    const { exam, attempt } = await sitExam(username);

    const key = await answerKey(exam.id);
    const res = await submit(exam.id, attempt.id, {
      username,
      score: 4,
      correctAnswers: 4,
      percentage: 100,
      passed: true,
      answers: [
        {
          questionId: key[0].id,
          answer: key[0].correctAnswer,
          isCorrect: true,
        },
        {
          questionId: key[1].id,
          answer: await wrongAnswerFor(key[1].id),
          isCorrect: true,
          correctAnswer: key[1].correctAnswer,
          score: 1,
        },
        {
          questionId: key[2].id,
          answer: await wrongAnswerFor(key[2].id),
          isCorrect: true,
        },
        {
          questionId: key[3].id,
          answer: await wrongAnswerFor(key[3].id),
          isCorrect: true,
        },
      ],
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.score, 1, "one right answer, not the four claimed");
    assert.equal(res.body.correctAnswers, 1);
    assert.equal(res.body.percentage, 25);
    assert.equal(res.body.passed, false);

    const marks = res.body.questions.map((question) => question.isCorrect);
    assert.deepEqual(marks, [true, false, false, false]);

    // And the database holds the server's decision, not the client's claim.
    const stored = await storedAnswers(attempt.id);
    assert.deepEqual(
      stored.map((row) => row.is_correct),
      [true, false, false, false],
    );
    const row = await storedAttempt(attempt.id);
    assert.equal(row.score, 1);
    assert.equal(row.percentage, 25);
    assert.equal(row.passed, false);
  });

  it("persists what the learner selected, alongside the mark (§18)", async () => {
    // SP-V2-007 reads this table. What was chosen — not only whether it was
    // right — is the part that makes "you keep picking the distractor" possible.
    const username = await makeUser("persisted");
    const { exam, attempt } = await sitExam(username);
    const answers = await perfectAnswers(exam.id);

    await submit(exam.id, attempt.id, { username, answers });

    const stored = await storedAnswers(attempt.id);
    assert.equal(stored.length, 4);
    for (const [index, row] of stored.entries()) {
      assert.equal(row.exam_question_id, answers[index].questionId);
      assert.equal(row.selected_answer, answers[index].answer);
      assert.equal(row.is_correct, true);
    }

    const row = await storedAttempt(attempt.id);
    assert.equal(row.status, "completed");
    assert.ok(row.submitted_at, "§11's transition is recorded");
    assert.equal(row.score, row.correct_answers, "the same count, two names");
    assert.equal(row.total_questions, 4);
  });
});

// ── §9: the submission's own validation ─────────────────────────────────────

describe("submission rejects malformed answers before grading (§9)", () => {
  it("rejects a question id that is not on this paper", async () => {
    const username = await makeUser("unknown-q");
    const { exam, attempt } = await sitExam(username);

    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [{ questionId: 9_999_999, answer: "A" }],
      }),
      400,
      "One or more answers refer to an unknown question.",
    );
  });

  it("rejects two answers to the same question", async () => {
    const username = await makeUser("duplicate");
    const { exam, attempt } = await sitExam(username);
    const key = await answerKey(exam.id);

    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [
          { questionId: key[0].id, answer: key[0].correctAnswer },
          { questionId: key[0].id, answer: await wrongAnswerFor(key[0].id) },
        ],
      }),
      400,
      "A question was answered more than once.",
    );
  });

  it("rejects an answer that is not one of that question's options", async () => {
    const username = await makeUser("not-an-option");
    const { exam, attempt } = await sitExam(username);
    const key = await answerKey(exam.id);

    for (const answer of ["Z", "maybe", "0"]) {
      assertJsonError(
        await submit(exam.id, attempt.id, {
          username,
          answers: [{ questionId: key[0].id, answer }],
        }),
        400,
        "One or more answers are not a valid option.",
      );
    }
  });

  it("rejects an answer of the wrong shape", async () => {
    const username = await makeUser("shape");
    const { exam, attempt } = await sitExam(username);
    const key = await answerKey(exam.id);

    assertJsonError(
      await submit(exam.id, attempt.id, { username, answers: "A" }),
      400,
      "Answers must be an array.",
    );
    assertJsonError(
      await submit(exam.id, attempt.id, { username, answers: ["A"] }),
      400,
      "Each answer must be an object.",
    );
    assertJsonError(
      await submit(exam.id, attempt.id, { username, answers: [{ answer: "A" }] }),
      400,
      "Each answer must name a question id.",
    );
    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [{ questionId: key[0].id, answer: 1 }],
      }),
      400,
      "Each answer must be a non-empty string.",
    );
    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [{ questionId: key[0].id, answer: "  " }],
      }),
      400,
      "Each answer must be a non-empty string.",
    );
    assertJsonError(
      await submit(exam.id, attempt.id, {
        username,
        answers: [{ questionId: key[0].id, answer: "A".repeat(101) }],
      }),
      400,
      "Each answer must be 100 characters or fewer.",
    );
  });

  it("leaves the attempt in progress after every rejection", async () => {
    // §13's point at the submission end: a refused submission writes nothing,
    // and the learner can correct their client and submit again.
    const username = await makeUser("still-open");
    const { exam, attempt } = await sitExam(username);

    await submit(exam.id, attempt.id, {
      username,
      answers: [{ questionId: 9_999_999, answer: "A" }],
    });
    await submit(exam.id, attempt.id, { username, answers: "nonsense" });

    const row = await storedAttempt(attempt.id);
    assert.equal(row.status, "in_progress");
    assert.equal(row.score, null);
    assert.deepEqual(await storedAnswers(attempt.id), []);

    const ok = await submit(exam.id, attempt.id, {
      username,
      answers: await perfectAnswers(exam.id),
    });
    assert.equal(ok.status, 200, "the attempt was still sittable");
    assert.equal(ok.body.percentage, 100);
  });

  it("trims whitespace around an answer without case-folding it", async () => {
    // Trimming absorbs a form's stray whitespace; lowercasing would be the
    // validation layer deciding that "b" means "B", which is a marking
    // judgement the grader makes strictly (§10).
    const username = await makeUser("whitespace");
    const { exam, attempt } = await sitExam(username, {
      questionTypes: ["multiple_choice"],
    });
    const key = await answerKey(exam.id);

    const res = await submit(exam.id, attempt.id, {
      username,
      answers: [
        { questionId: key[0].id, answer: `  ${key[0].correctAnswer}  ` },
        { questionId: key[1].id, answer: key[1].correctAnswer.toLowerCase() },
      ],
    });

    // The lower-cased one is not an option id of that question, so it never
    // reaches the grader at all — it is a malformed request, not a wrong answer.
    assertJsonError(res, 400, "One or more answers are not a valid option.");

    const trimmedOnly = await submit(exam.id, attempt.id, {
      username,
      answers: [{ questionId: key[0].id, answer: `  ${key[0].correctAnswer}  ` }],
    });
    assert.equal(trimmedOnly.status, 200, trimmedOnly.text);
    assert.equal(trimmedOnly.body.correctAnswers, 1, "the trimmed answer was marked");
  });
});

// ── §11: a submitted attempt is immutable ───────────────────────────────────

describe("a submitted attempt cannot be resubmitted (§11)", () => {
  it("answers a second submission with 409 and keeps the first result", async () => {
    const username = await makeUser("double");
    const { exam, attempt } = await sitExam(username);
    const key = await answerKey(exam.id);

    const first = await submit(exam.id, attempt.id, {
      username,
      answers: [{ questionId: key[0].id, answer: key[0].correctAnswer }],
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.correctAnswers, 1);

    // A second, better submission. §11: "do not overwrite the original result."
    const second = await submit(exam.id, attempt.id, {
      username,
      answers: await perfectAnswers(exam.id),
    });
    assertJsonError(second, 409, "This attempt has already been submitted.");

    const row = await storedAttempt(attempt.id);
    assert.equal(row.correct_answers, 1, "the original result stands");
    assert.equal(row.percentage, 25);
    assert.equal((await storedAnswers(attempt.id)).length, 1, "no second answer set");
  });

  it("completes exactly once when two submissions race", async () => {
    // The pre-check alone cannot hold here: both requests read `in_progress`
    // before either writes. What makes this deterministic is the compare-and-set
    // in completeAttempt — the loser's UPDATE matches no row.
    const username = await makeUser("race");
    const { exam, attempt } = await sitExam(username);
    const answers = await perfectAnswers(exam.id);

    const [a, b] = await Promise.all([
      submit(exam.id, attempt.id, { username, answers }),
      submit(exam.id, attempt.id, { username, answers }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `got ${a.status} and ${b.status}`);

    const winner = a.status === 200 ? a : b;
    assert.equal(winner.body.percentage, 100);

    // One result, and one set of answers — not two of either.
    assert.equal((await storedAnswers(attempt.id)).length, 4);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM exam_attempts WHERE id = $1 AND status = 'completed'",
      [attempt.id],
    );
    assert.equal(rows[0].n, 1);
  });

  it("returns the same result on every subsequent read", async () => {
    const username = await makeUser("stable");
    const { exam, attempt } = await sitExam(username);
    const submitted = (
      await submit(exam.id, attempt.id, {
        username,
        answers: await perfectAnswers(exam.id),
      })
    ).body;

    const first = await getAttempt(exam.id, attempt.id, username);
    const second = await getAttempt(exam.id, attempt.id, username);

    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body, submitted, "the read matches the submission");
    assert.deepEqual(second.body, first.body, "and does not drift");
  });
});

// ── §4, §16: the key is withheld until it is earned ─────────────────────────

describe("the answer key is never exposed before submission (§4, §16)", () => {
  it("withholds it from creation, from the exam, from the attempt and from the read", async () => {
    const username = await makeUser("withheld");
    const exam = await createExamOk(username);
    const started = (await startAttempt(exam.id, { username })).body;
    const read = (await getAttempt(exam.id, started.id, username)).body;
    const fetched = (await getExam(exam.id, username)).body;

    for (const [where, payload] of [
      ["POST /api/exams", exam],
      ["GET /api/exams/:id", fetched],
      ["POST /api/exams/:id/attempts", started],
      ["GET /api/exams/:id/attempts/:attemptId", read],
    ]) {
      assertNoAnswerKey(payload, where);
    }

    // The in-progress read carries the questions to answer and the five result
    // fields, all null — not an absent key a client would have to distinguish
    // from a missing one.
    assert.deepEqual(Object.keys(read).sort(), ATTEMPT_KEYS);
    assertUngraded(read);
    assert.equal(read.questions.length, 4);
    for (const question of read.questions) {
      assert.deepEqual(Object.keys(question).sort(), [...TAKING_QUESTION_KEYS].sort());
    }
  });

  it("returns it after submission, and it matches the database", async () => {
    // The other half of the claim. A server that never returned the key would
    // pass every assertion above, and would also be broken: §9 permits the key
    // from this moment, and the review screen is the whole point of grading.
    const username = await makeUser("earned");
    const { exam, attempt } = await sitExam(username);
    const key = await answerKey(exam.id);

    const res = await submit(exam.id, attempt.id, {
      username,
      answers: await perfectAnswers(exam.id),
    });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      res.body.questions.map((question) => ({
        id: question.id,
        correctAnswer: question.correctAnswer,
      })),
      key.map((entry) => ({ id: entry.id, correctAnswer: entry.correctAnswer })),
    );

    // And it stays available on the completed attempt's own endpoint.
    const read = await getAttempt(exam.id, attempt.id, username);
    assert.equal(read.body.questions[0].correctAnswer, key[0].correctAnswer);
  });

  it("does not leak it through a second learner's completed attempt", async () => {
    const owner = await makeUser("graded-owner");
    const stranger = await makeUser("graded-stranger");
    const { exam, attempt } = await sitExam(owner);
    await submit(exam.id, attempt.id, {
      username: owner,
      answers: await perfectAnswers(exam.id),
    });

    // Completed, and therefore the one shape that carries the key — which makes
    // this the case most worth checking: 404 before the branch that would
    // return it, not a filtered version of it.
    assertJsonError(
      await getAttempt(exam.id, attempt.id, stranger),
      404,
      "Exam attempt not found.",
    );
    assertNoAnswerKey((await getExam(exam.id, owner)).body, "GET exam after grading");
  });
});

// ── §9: the history ─────────────────────────────────────────────────────────

describe("GET /api/exam-attempts is one learner's history (§9, §12)", () => {
  it("lists that learner's attempts, newest first, with their results", async () => {
    const username = await makeUser("history");
    const { exam, attempt } = await sitExam(username, { subject: "Geology" });
    await submit(exam.id, attempt.id, {
      username,
      answers: await perfectAnswers(exam.id),
    });
    const second = (await startAttempt(exam.id, { username })).body;

    const res = await listAttempts(username);
    assert.equal(res.status, 200, res.text);
    assert.equal(Array.isArray(res.body), true, "§20: a list is a bare array");
    assert.equal(res.body.length, 2);

    const [newest, oldest] = res.body;
    assert.equal(newest.id, second.id, "newest first");
    assert.equal(oldest.id, attempt.id);

    assert.deepEqual(Object.keys(newest).sort(), SUMMARY_KEYS);
    assert.equal(newest.examTitle, CANNED_EXAM_TITLE, "enough exam to render a row");
    assert.equal(newest.examSubject, "Geology");
    assert.equal(newest.examDifficulty, "medium");
    assertUngraded(newest);

    assert.equal(oldest.status, "completed");
    assert.equal(oldest.percentage, 100);
    assert.equal(oldest.passed, true);

    // A listing, not a paper: the questions are not in it, so a history screen
    // cannot become a way to read the key for an exam still in progress.
    assert.ok(!("questions" in newest));
    assertNoAnswerKey(res.body, "GET /api/exam-attempts");
    assertNoInternals(res.body);
  });

  it("shows a learner nothing of anyone else's", async () => {
    const owner = await makeUser("history-owner");
    const stranger = await makeUser("history-stranger");
    await sitExam(owner);

    const res = await listAttempts(stranger);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [], "empty, not someone else's");
  });

  it("requires authentication and returns empty history for a new account", async () => {
    assertJsonError(
      await server.request("GET", "/api/exam-attempts"),
      401,
      "Authentication required.",
    );
    const history = await listAttempts("nobody_at_all_5678");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body, []);
  });
});

// ── the whole flow, once, as a client would drive it ────────────────────────

describe("a complete learner journey over HTTP (§27)", () => {
  it("generates, sits, submits and reviews an exam grounded in a document", async () => {
    const username = await makeUser("journey");

    // 1. No history yet.
    assert.deepEqual((await listAttempts(username)).body, []);

    // 2. A document to be examined on.
    const materialId = await makeMaterial(username, "cells.pdf");
    await addChunk(
      materialId,
      "Photosynthesis stores light energy as chemical energy in glucose.",
    );

    // 3. Generate the exam. No key comes back.
    const exam = await createExamOk(username, {
      subject: "Cell Biology",
      topics: ["Photosynthesis"],
      difficulty: "hard",
      questionCount: 5,
      materialIds: [materialId],
    });
    assert.equal(exam.sourceType, "material");
    assert.equal(exam.questions.length, 5);
    assertNoAnswerKey(exam, "journey: creation");

    // 4. Start an attempt; the paper rides along.
    const attempt = (await startAttempt(exam.id, { username })).body;
    assertUngraded(attempt);
    assert.equal(attempt.exam.questions.length, 5);
    assertNoAnswerKey(attempt, "journey: attempt");

    // 5. Answer four of the five correctly and skip the last.
    const key = await answerKey(exam.id);
    const result = (
      await submit(exam.id, attempt.id, {
        username,
        answers: key
          .slice(0, 4)
          .map((entry) => ({ questionId: entry.id, answer: entry.correctAnswer })),
      })
    ).body;

    assert.equal(result.status, "completed");
    assert.equal(result.correctAnswers, 4);
    assert.equal(result.totalQuestions, 5);
    assert.equal(result.percentage, 80);
    assert.equal(result.passed, true);

    // 6. Review: every question, its answer, and what was chosen.
    assert.equal(result.questions.length, 5);
    assert.equal(result.questions[4].selectedAnswer, null, "the skipped one");
    assert.equal(result.questions[4].isCorrect, false);
    for (const question of result.questions) {
      assert.equal(question.sourceMaterialId, materialId, "§14 survives to review");
    }

    // 7. It is in the history, and it cannot be re-sat under the same attempt.
    const history = (await listAttempts(username)).body;
    assert.equal(history.length, 1);
    assert.equal(history[0].percentage, 80);
    assertJsonError(
      await submit(exam.id, attempt.id, { username, answers: [] }),
      409,
      "This attempt has already been submitted.",
    );

    // 8. A fresh attempt at the same paper starts clean.
    const retake = (await startAttempt(exam.id, { username })).body;
    assertUngraded(retake);
    assertNoAnswerKey(retake, "journey: retake");
    assert.equal((await listAttempts(username)).body.length, 2);
  });
});

// ── the shape of the surface itself ─────────────────────────────────────────

describe("the endpoint surface is exactly six routes (§9)", () => {
  it("exposes no list, no delete and no cancel", async () => {
    // §9 names six and src/exams/exam.routes.js registers those six. If a
    // seventh is added later, this test is where the decision gets recorded.
    const username = await makeUser("surface");
    const { exam, attempt } = await sitExam(username);

    for (const [method, path] of [
      ["GET", "/api/exams"],
      ["DELETE", `/api/exams/${exam.id}`],
      ["PUT", `/api/exams/${exam.id}`],
      ["PATCH", `/api/exams/${exam.id}`],
      ["POST", `/api/exams/${exam.id}/cancel`],
      ["GET", `/api/exams/${exam.id}/questions`],
      ["GET", `/api/exams/${exam.id}/answers`],
      ["PATCH", `/api/exams/${exam.id}/attempts/${attempt.id}`],
    ]) {
      // The username goes in the query string for every method and in the body
      // for those that may carry one, so a route that exists is reached with a
      // request it would accept — a 404 here means "no such route", not "no
      // username".
      const res = await server.request(
        method,
        `${path}?username=${encodeURIComponent(username)}`,
        method === "GET" ? undefined : { json: { username } },
      );
      assert.equal(res.status, 404, `${method} ${path} must not exist`);
      assert.equal(res.body.error, "Not found");
    }

    // And the exam is untouched by any of it.
    assert.equal((await getExam(exam.id, username)).body.status, "ready");
  });

  it("answers unknown exam paths with JSON, not an HTML error page", async () => {
    const res = await server.request("GET", `/api/exams/1/attempts?username=${testUser("surface")}`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(res.body.error, "Not found");
  });

  it("rejects a malformed JSON body as 400, not 500", async () => {
    const res = await server.request("POST", "/api/exams", {
      body: '{"username": "x", ',
      headers: { "content-type": "application/json" },
    });
    assertJsonError(res, 400, "Invalid JSON body");
  });
});
