/**
 * Exam, question, attempt and answer persistence — the only module with SQL for
 * these four tables.
 *
 * Same rules as src/study-plans/study-plan.repository.js and
 * src/materials/material.repository.js: every value is a bind parameter, no
 * layer above this one writes SQL, and THERE IS NO `findById(id)`. An exam, an
 * attempt and an attempt's answers are each reachable only through a function
 * that also takes the owner, so §12's "user A must not retrieve user B's exam"
 * is a property of this module's INTERFACE rather than a rule every caller has
 * to remember to apply.
 *
 * Absent and not-yours are indistinguishable in the return value — both
 * `undefined`. The service answers 404 for both without knowing which happened,
 * so the API never confirms that an exam id is real (§15).
 *
 * THE ANSWER KEY IS A SEPARATE READ PATH, AND THAT IS THE POINT
 * ------------------------------------------------------------
 * §4: "The client MUST NOT receive the correct answer while taking the exam."
 * That is enforced here, structurally, rather than by filtering a field out
 * somewhere upstream:
 *
 *   findQuestionsForTaking()  SELECTs neither correct_answer NOR explanation.
 *                             The columns are not in the result set, so no
 *                             mapping mistake, no accidental spread and no
 *                             future `...row` can leak them. This is what backs
 *                             GET /api/exams/:id and the in-progress attempt.
 *   findAnswerKey()           correct_answer only, no prose. Feeds the grader
 *                             inside the submission transaction and is never
 *                             returned to a controller.
 *   findQuestionsWithAnswers()  everything, and it is called from exactly one
 *                             place: reading a COMPLETED attempt, where §9
 *                             permits the answers and explanations.
 *
 * Three functions rather than one with a `includeAnswers` flag, deliberately. A
 * boolean parameter puts the security decision at the call site, where it is one
 * typo from being wrong and invisible in review; three names put it in the
 * function you chose to call. tests/exams/architecture.test.js asserts that the
 * taking path's SQL does not mention correct_answer at all.
 *
 * WHY NO GRADING HAPPENS IN HERE
 * ------------------------------
 * No SQL below computes `is_correct`, and none may. It would be easy — the
 * answer key is one join away — but the marking rule would then exist twice,
 * once in SQL and once in src/exams/grader.js, and §23 is explicit about
 * duplicated validation. §10's comparison is stated once, in the grader; this
 * module loads the key and writes down what the grader decided.
 *
 * WHY GENERATION IS NOT IN HERE EITHER
 * ------------------------------------
 * No function below calls Gemini. §13 requires the model to be called BEFORE the
 * transaction opens: a provider round trip inside `BEGIN` holds a connection and
 * its locks for however long generation takes, which is tens of seconds.
 * `insertExamWithQuestions` receives a finished, validated exam and does nothing
 * but write it.
 */

import { query, withTransaction } from "../config/database.js";

/**
 * Exam columns the API layer may see.
 *
 * Written out rather than `SELECT *` for the reason SP-V2-005 records: a future
 * ALTER TABLE must not be able to start feeding a new column into an API
 * payload by itself.
 */
const EXAM_COLUMNS = `
  id, user_id, title, subject, difficulty,
  question_count, status, source_type,
  topics, material_ids,
  created_at, updated_at
`;

/** The same, qualified for an aliased `exams e`. */
const EXAM_COLUMNS_QUALIFIED = `
  e.id, e.user_id, e.title, e.subject, e.difficulty,
  e.question_count, e.status, e.source_type,
  e.topics, e.material_ids,
  e.created_at, e.updated_at
`;

/**
 * Question columns for a learner who is TAKING the exam.
 *
 * correct_answer and explanation are both absent, and both deliberately.
 * Withholding the key while shipping "the answer is B because …" would satisfy
 * the letter of §4 and none of it — an explanation names the right answer in
 * prose nearly every time.
 *
 * user_id is absent too: it is an internal surrogate key, and the denormalised
 * copy on this table exists to pin the composite foreign keys (see
 * migrations/postgres/005_exams.sql), not to be read.
 */
const QUESTION_COLUMNS_FOR_TAKING = `
  id, exam_id, question_order, question_type, question_text, options,
  source_material_id, source_chunk_id, created_at
`;

/**
 * The same plus the answer key — for a SUBMITTED attempt only (§9).
 *
 * The one place `correct_answer` reaches a response, and it does so after the
 * attempt is `completed` and immutable, when telling the learner which answer
 * was right is the entire purpose of the screen.
 */
const QUESTION_COLUMNS_WITH_ANSWERS = `
  id, exam_id, question_order, question_type, question_text, options,
  correct_answer, explanation,
  source_material_id, source_chunk_id, created_at
`;

/** Attempt columns. user_id omitted for the same reason as above. */
const ATTEMPT_COLUMNS = `
  id, exam_id, status, started_at, submitted_at,
  score, total_questions, correct_answers, percentage, passed,
  created_at, updated_at
`;

/** The same, qualified for an aliased `exam_attempts a`. */
const ATTEMPT_COLUMNS_QUALIFIED = `
  a.id, a.exam_id, a.status, a.started_at, a.submitted_at,
  a.score, a.total_questions, a.correct_answers, a.percentage, a.passed,
  a.created_at, a.updated_at
`;

/** Answer columns. */
const ANSWER_COLUMNS = `
  id, attempt_id, exam_question_id, selected_answer, is_correct, answered_at
`;

/**
 * Write an exam and all of its questions, atomically (§13).
 *
 * ONE transaction, and §13 spells out why: "Never leave half-generated exams."
 * An exam row without its questions is not a short exam, it is a paper with
 * nothing on it — the learner would start an attempt, see zero questions, and
 * get no error explaining it. Either both happen or neither.
 *
 * The guard rejects an empty question list before opening the transaction. It is
 * unreachable from the service — the validator refuses a response whose question
 * count does not match the request, and the request's count is `> 0` — which is
 * exactly why it throws a plain Error rather than an AppError: reaching it means
 * a programming mistake upstream, not a request worth answering with a status
 * code.
 *
 * @param {object} input
 * @param {object} input.exam {userId, title, subject, difficulty, questionCount,
 *   sourceType, topics, materialIds}
 * @param {Array<object>} input.questions validated questions in exam order;
 *   question_order is assigned from array position, never from the model
 * @returns {Promise<{exam: object, questions: Array<object>}>}
 */
export async function insertExamWithQuestions({ exam, questions }) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Refusing to persist an exam with no questions");
  }

  return withTransaction(async (client) => {
    const { rows: examRows } = await client.query(
      `INSERT INTO exams (
         user_id, title, subject, difficulty,
         question_count, source_type, topics, material_ids
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::bigint[])
       RETURNING ${EXAM_COLUMNS}`,
      [
        exam.userId,
        exam.title,
        exam.subject,
        exam.difficulty,
        exam.questionCount,
        exam.sourceType,
        exam.topics,
        exam.materialIds,
      ],
    );

    const created = examRows[0];

    // One statement for every question, with a FIXED placeholder count however
    // many there are — the `unnest` pattern from insertPlanWithTasks. A loop of
    // INSERTs would be N round trips inside the transaction, and a built-up
    // VALUES list would make the statement text vary with the question count,
    // which defeats the prepared-statement cache and puts string building next
    // to user data.
    //
    // The denormalised user_id is written from the EXAM's row, not from the
    // caller's argument, so the composite foreign keys cannot be satisfied by a
    // mismatched pair even if a caller passed one.
    const { rows: questionRows } = await client.query(
      `INSERT INTO exam_questions (
         exam_id, user_id, question_order, question_type, question_text,
         options, correct_answer, explanation,
         source_material_id, source_chunk_id
       )
       SELECT $1, $2, q.question_order, q.question_type, q.question_text,
              q.options, q.correct_answer, q.explanation,
              q.source_material_id, q.source_chunk_id
         FROM unnest(
                $3::int[], $4::text[], $5::text[], $6::jsonb[],
                $7::text[], $8::text[], $9::bigint[], $10::bigint[]
              ) AS q(
                question_order, question_type, question_text, options,
                correct_answer, explanation, source_material_id, source_chunk_id
              )
       RETURNING ${QUESTION_COLUMNS_WITH_ANSWERS}`,
      [
        created.id,
        created.user_id,
        questions.map((_, index) => index + 1),
        questions.map((q) => q.type),
        questions.map((q) => q.questionText),
        questions.map((q) => JSON.stringify(q.options)),
        questions.map((q) => q.correctAnswer),
        questions.map((q) => q.explanation),
        questions.map((q) => q.sourceMaterialId ?? null),
        questions.map((q) => q.sourceChunkId ?? null),
      ],
    );

    // RETURNING follows the INSERT's own order, which is the order of the
    // arrays. Sorted anyway so that this function's contract is the sort order
    // rather than a PostgreSQL implementation detail that agrees with it today.
    questionRows.sort((a, b) => a.question_order - b.question_order);

    return { exam: withNumericMaterialIds(created), questions: questionRows };
  });
}

/**
 * One exam, only if it belongs to this user.
 *
 * The function every ownership check goes through. There is no id-only variant.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<object | undefined>} undefined if absent OR not theirs
 */
export async function findOwnedExamById(id, userId) {
  const { rows } = await query(
    `SELECT ${EXAM_COLUMNS}
       FROM exams
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] === undefined ? undefined : withNumericMaterialIds(rows[0]);
}

/**
 * An exam's questions WITHOUT the answer key — the read that serves a learner
 * taking the exam (§4, §9).
 *
 * Takes no userId, and that is safe rather than sloppy for the reason
 * findTasksByPlanId records: the only way to hold an exam id is
 * findOwnedExamById, which already applied the owner. Adding a redundant userId
 * here would suggest the check had not happened yet — the more dangerous shape,
 * because a caller might then believe passing it was sufficient.
 *
 * ORDER BY matches exam_questions_exam_order_key exactly, so this reads straight
 * off the index with no sort step.
 *
 * @param {number} examId
 * @returns {Promise<Array<object>>}
 */
export async function findQuestionsForTaking(examId) {
  const { rows } = await query(
    `SELECT ${QUESTION_COLUMNS_FOR_TAKING}
       FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order ASC`,
    [examId],
  );
  return rows;
}

/**
 * An exam's questions WITH the answer key and explanations.
 *
 * For a completed attempt's result screen only. The caller is responsible for
 * having established that the attempt is `completed` — which
 * findOwnedAttempt() reports and the service checks — because this function
 * cannot see an attempt from here.
 *
 * @param {number} examId
 * @returns {Promise<Array<object>>}
 */
export async function findQuestionsWithAnswers(examId) {
  const { rows } = await query(
    `SELECT ${QUESTION_COLUMNS_WITH_ANSWERS}
       FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order ASC`,
    [examId],
  );
  return rows;
}

/**
 * The answer key, and nothing else — id and correct_answer per question.
 *
 * Loaded inside the submission transaction and handed to the grader. It never
 * reaches a controller, so the narrow projection is not an optimisation: it is
 * the reason a bug in the submit path cannot accidentally return prose that
 * names the right answer.
 *
 * FOR SHARE locks every question row against concurrent modification for the
 * rest of the transaction. A question cannot be edited today — there is no
 * endpoint — but the lock is what makes "the key that was graded against" and
 * "the key stored at COMMIT" provably the same rows rather than the same rows by
 * assumption.
 *
 * @param {import("pg").PoolClient} client the transaction's client — this query
 *   must run inside the submission transaction, so the client is required
 *   rather than taken from the pool
 * @param {number} examId
 * @returns {Promise<Array<{id: number, correctAnswer: string}>>} in exam order,
 *   already in the grader's vocabulary
 */
export async function findAnswerKey(client, examId) {
  const { rows } = await client.query(
    `SELECT id, correct_answer
       FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order ASC
        FOR SHARE`,
    [examId],
  );
  return rows.map((row) => ({ id: row.id, correctAnswer: row.correct_answer }));
}

/**
 * Start an attempt (§9).
 *
 * The exam id and user id are written together, and exam_attempts_exam_user_fkey
 * is composite, so an attempt against someone else's exam cannot be inserted
 * even if both checks above this were skipped. The service checks ownership
 * first and gets a clean 404; this is the backstop that makes the check's
 * absence a constraint violation rather than a data breach.
 *
 * `status`, `started_at` and every result column take their defaults:
 * 'in_progress', now(), and NULL respectively. Passing them would let a caller
 * start an attempt that was already marked complete — exam_attempts_result_
 * matches_status would reject the worst version of that, but the narrower INSERT
 * means it cannot be attempted.
 *
 * MULTIPLE ATTEMPTS AT ONE EXAM ARE ALLOWED, including concurrently. §2 asks for
 * attempt history, which is a history of more than one, and §11 constrains the
 * lifecycle of each attempt rather than how many may exist. Nothing here
 * de-duplicates; the uniqueness that matters is one answer per question per
 * attempt, which attempt_answers_attempt_question_key enforces.
 *
 * @param {object} input
 * @param {number} input.examId
 * @param {number} input.userId
 * @returns {Promise<object>}
 */
export async function insertAttempt({ examId, userId }) {
  const { rows } = await query(
    `INSERT INTO exam_attempts (exam_id, user_id)
     VALUES ($1, $2)
     RETURNING ${ATTEMPT_COLUMNS}`,
    [examId, userId],
  );
  return rows[0];
}

/**
 * One attempt, only if it belongs to this user AND to this exam (§9).
 *
 * Both conditions in one statement. §9's submit sequence asks for "verify
 * ownership" and "verify attempt belongs to exam" as separate steps; they are
 * separate checks but not separate queries, because a read-then-compare would
 * give two failure branches for a caller to get right and both answer 404
 * anyway. An attempt of another exam, and an attempt of another user, are both
 * `undefined` here.
 *
 * @param {object} input
 * @param {number} input.attemptId
 * @param {number} input.examId
 * @param {number} input.userId
 * @returns {Promise<object | undefined>}
 */
export async function findOwnedAttempt({ attemptId, examId, userId }) {
  const { rows } = await query(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM exam_attempts
      WHERE id = $1 AND exam_id = $2 AND user_id = $3`,
    [attemptId, examId, userId],
  );
  return rows[0];
}

/**
 * Persist a graded submission and complete the attempt, atomically (§13).
 *
 * THE ORDER OF THE TWO STATEMENTS IS THE CONCURRENCY CONTROL, and it is the
 * reason §11's "do not overwrite the original result" holds under a double
 * submit rather than merely under a sequential one.
 *
 * The UPDATE runs FIRST and is a compare-and-set: `WHERE status = 'in_progress'`
 * means the first transaction to reach it takes the row's write lock and flips
 * the status, and a second concurrent submit blocks on that lock, then matches
 * zero rows when the first commits. Zero rows is returned as `undefined`, and
 * the service answers 409 (§11) without having written anything — the answers
 * INSERT is never reached, so there is no half-written second submission to
 * clean up and the original result is untouched.
 *
 * Doing it the other way round — INSERT the answers, then UPDATE — would have
 * the second submit fail on attempt_answers_attempt_question_key instead. That
 * is still safe, because the unique constraint holds, but it surfaces as a
 * constraint violation rather than a controlled conflict, and §11 asks for the
 * controlled one.
 *
 * `results` may legitimately be shorter than the exam: an unanswered question
 * has no row (see the grader's header). An empty `results` — a learner who
 * submitted a blank paper — is a valid submission scoring 0, so the answers
 * INSERT is skipped rather than treated as an error.
 *
 * NOTHING IN `result` COMES FROM A CLIENT. Every field is computed by
 * src/exams/grader.js from the stored answer key, inside the caller's
 * transaction. §5 lists score, percentage, correct_answers, is_correct and
 * passed as values a client must never supply, and none of them has a path from
 * a request body to this function's arguments.
 *
 * @param {import("pg").PoolClient} client the transaction's client
 * @param {object} input
 * @param {number} input.attemptId
 * @param {number} input.userId
 * @param {object} input.result the grader's output: {results, score,
 *   totalQuestions, correctAnswers, percentage, passed}
 * @returns {Promise<{attempt: object, answers: Array<object>} | undefined>}
 *   undefined when the attempt was no longer in_progress — the 409 case
 */
export async function completeAttempt(client, { attemptId, userId, result }) {
  const { rows: attemptRows } = await client.query(
    `UPDATE exam_attempts
        SET status = 'completed',
            submitted_at = now(),
            score = $3,
            total_questions = $4,
            correct_answers = $5,
            percentage = $6,
            passed = $7,
            updated_at = now()
      WHERE id = $1
        AND user_id = $2
        AND status = 'in_progress'
      RETURNING ${ATTEMPT_COLUMNS}`,
    [
      attemptId,
      userId,
      result.score,
      result.totalQuestions,
      result.correctAnswers,
      result.percentage,
      result.passed,
    ],
  );

  const attempt = attemptRows[0];
  if (attempt === undefined) return undefined;

  if (result.results.length === 0) {
    return { attempt, answers: [] };
  }

  const { rows: answerRows } = await client.query(
    `INSERT INTO attempt_answers (
       attempt_id, user_id, exam_question_id, selected_answer, is_correct
     )
     SELECT $1, $2, a.exam_question_id, a.selected_answer, a.is_correct
       FROM unnest($3::bigint[], $4::text[], $5::boolean[])
         AS a(exam_question_id, selected_answer, is_correct)
     RETURNING ${ANSWER_COLUMNS}`,
    [
      attemptId,
      userId,
      result.results.map((r) => r.questionId),
      result.results.map((r) => r.selectedAnswer),
      result.results.map((r) => r.isCorrect),
    ],
  );

  return { attempt, answers: answerRows };
}

/**
 * An attempt's answers.
 *
 * Takes no userId for the same reason findQuestionsForTaking does not: an
 * attempt id can only have come from findOwnedAttempt.
 *
 * @param {number} attemptId
 * @returns {Promise<Array<object>>}
 */
export async function findAnswersByAttemptId(attemptId) {
  const { rows } = await query(
    `SELECT ${ANSWER_COLUMNS}
       FROM attempt_answers
      WHERE attempt_id = $1
      ORDER BY exam_question_id ASC`,
    [attemptId],
  );
  return rows;
}

/**
 * A user's attempts, newest first — §9's GET /api/exam-attempts.
 *
 * Joined to exams for the title and subject, because a history listing that
 * shows only ids is a list the learner cannot read. The join is on the attempt's
 * own exam_id with the user already fixed by the WHERE clause, so it cannot
 * widen what the query returns.
 *
 * ORDER BY matches idx_exam_attempts_user_started, with id as the tiebreak so
 * that two attempts started in the same millisecond have a stable order across
 * calls rather than whichever the executor happened to emit first.
 *
 * IN-PROGRESS ATTEMPTS ARE INCLUDED, with their result columns null. §2 asks for
 * attempt history; an attempt the learner abandoned halfway is part of that
 * history, and hiding it would make a started-but-unfinished exam disappear from
 * the only screen that could lead them back to it.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
export async function findAttemptsByUserId(userId, limit) {
  const { rows } = await query(
    `SELECT ${ATTEMPT_COLUMNS_QUALIFIED},
            e.title AS exam_title,
            e.subject AS exam_subject,
            e.difficulty AS exam_difficulty
       FROM exam_attempts a
       JOIN exams e ON e.id = a.exam_id
      WHERE a.user_id = $1
      ORDER BY a.started_at DESC, a.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Coerce `material_ids` to numbers.
 *
 * PostgreSQL's bigint ARRAY type (oid 1016) has no parser registered in
 * src/config/pg-types.js — oid 20 covers a scalar BIGINT, and the array type is
 * a separate oid — so node-postgres hands back `["1", "2"]` where the scalar
 * column would have given `1`. Verified empirically against PostgreSQL 16:
 * `bigint[]` elements arrive as strings, `int[]` elements as numbers.
 *
 * Fixed HERE rather than in pg-types.js, and that is a §25 decision rather than
 * a preference. study_plans.material_ids has the same type and the same
 * behaviour; SP-V2-005 never returns the column to a client, so nothing there is
 * broken today, but registering oid 1016 globally would change what that
 * module's queries receive. Touching a shipped feature to tidy a type mapping is
 * exactly the unrelated modification §25 forbids. Reported as a finding instead.
 *
 * This is a no-op if pg-types.js ever does register the array oid — Number() of
 * a number is that number — so the fix, when it comes, cannot break this.
 */
function withNumericMaterialIds(row) {
  if (!Array.isArray(row.material_ids)) return row;
  return { ...row, material_ids: row.material_ids.map(Number) };
}
