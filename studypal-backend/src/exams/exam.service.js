/**
 * Exam orchestration: ownership, generation, attempts and grading.
 *
 * The layer between the controller and everything else (§23). It touches no
 * `req` and no `res`, writes no SQL, and never calls the Google SDK directly —
 * generation goes through src/exams/exam-generator.js, persistence through
 * src/exams/exam.repository.js, marking through src/exams/grader.js.
 *
 * WHERE EACH OF §12'S FOUR RULES IS ENFORCED
 * ------------------------------------------
 * Every one of them is a WHERE clause rather than an `if`:
 *
 *   retrieve someone else's exam      findOwnedExamById(id, userId)
 *   use someone else's material       findOwnedByIds(ids, userId), via
 *                                     resolveMaterials
 *   start an attempt on their exam    findOwnedExamById again, before insert
 *   submit or read their attempt      findOwnedAttempt({attemptId, examId,
 *                                     userId})
 *
 * None of those functions has an id-only variant, so there is no way to write a
 * handler in this file that forgets the owner — the repository would not compile
 * a query for it. All four answer 404 rather than 403, per §15 and the reason
 * src/utils/app-error.js records: a 403 confirms the resource exists.
 *
 * THE TWO TRANSACTIONS (§13)
 * --------------------------
 * Generation: call Gemini → validate → BEGIN → insert exam → insert questions →
 * COMMIT. The provider call happens BEFORE the transaction opens, so a slow
 * generation does not hold a connection, and a failed one leaves nothing behind
 * because nothing was opened.
 *
 * Submission: validate → BEGIN → verify state → grade → write answers → update
 * attempt → COMMIT. Grading happens INSIDE the transaction, against an answer
 * key read with FOR SHARE, so the key that was marked against and the key stored
 * at COMMIT are provably the same rows.
 */

import { config } from "../config/env.js";
import { badRequest, conflict, notFound } from "../utils/app-error.js";
import { withTransaction } from "../config/database.js";
import * as examRepository from "./exam.repository.js";
import { buildExamMaterialContext, resolveMaterials } from "./material-brief.js";
import { generateExam } from "./exam-generator.js";
import { gradeAttempt } from "./grader.js";
import * as users from "../repositories/user.repository.js";

/** Items returned by GET /api/exam-attempts. Shares the material list ceiling. */
const ATTEMPT_LIST_LIMIT = config.limits.materialListItems;

/**
 * Generate and persist an exam (§6, §13).
 *
 * @param {object} input already validated by exam-validation.middleware.js
 * @returns {Promise<object>} the API shape, questions included, NO answer key
 */
export async function createExam({
  username,
  subject,
  topics,
  difficulty,
  questionCount,
  questionTypes,
  materialIds,
}) {
  const userId = await requireUserId(username);

  // §6's ownership check, before any provider call. A request naming a material
  // the learner does not own is refused rather than quietly generating from the
  // ones they do — they asked for an exam on five documents, and an exam on four
  // of them with no indication which is missing is not that exam.
  const { materials, missing } = await resolveMaterials(materialIds, userId);
  if (missing > 0) {
    throw notFound("One or more materials were not found.");
  }

  const { context, sources } = await buildExamMaterialContext({
    userId,
    materials,
    subject,
    topics,
  });

  const generated = await generateExam({
    request: {
      subject,
      topics,
      difficulty,
      questionCount,
      questionTypes,
      materials,
    },
    materialContext: context,
    sourceCount: sources.length,
  });

  // §14's traceability, resolved HERE rather than in the generator: the model
  // returns a 1-based source number that means nothing outside the prompt, and
  // this is the only layer that still holds the list it was numbered against.
  const questions = generated.questions.map((question) => ({
    ...question,
    ...resolveSource(question.sourceNumber, sources),
  }));

  // 'material' only when material actually reached the model. A request that
  // named documents none of whose chunks were retrievable — unindexed, or
  // nothing above the similarity threshold — produced a topic-only exam, and
  // recording it as material-sourced would misdescribe it to SP-V2-007.
  const sourceType = sources.length > 0 ? "material" : "topics";

  const { exam, questions: persisted } =
    await examRepository.insertExamWithQuestions({
      exam: {
        userId,
        title: generated.title,
        subject,
        difficulty,
        questionCount,
        sourceType,
        topics,
        materialIds: materials.map((material) => material.id),
      },
      questions,
    });

  // Mapped through the taking shape even though these rows carry the key: this
  // is the CREATE response, the learner has not sat the exam, and §4's rule is
  // about the moment rather than the endpoint.
  return toExamShape(exam, persisted.map(toQuestionShape));
}

/**
 * One exam and its questions, without the answer key (§9).
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function getExam({ username, examId }) {
  const userId = await requireUserId(username);

  const exam = await examRepository.findOwnedExamById(examId, userId);
  if (exam === undefined) throw notFoundExam();

  const questions = await examRepository.findQuestionsForTaking(exam.id);
  return toExamShape(exam, questions.map(toQuestionShape));
}

/**
 * Start an attempt (§9).
 *
 * @param {object} input
 * @returns {Promise<object>} the attempt, and the questions to answer
 */
export async function startAttempt({ username, examId }) {
  const userId = await requireUserId(username);

  const exam = await examRepository.findOwnedExamById(examId, userId);
  if (exam === undefined) throw notFoundExam();

  // A cancelled exam cannot be sat. The only other status is 'ready', so this is
  // the whole of the exam-level state check — see the status discussion in
  // migrations/postgres/005_exams.sql for why there is no 'in_progress' here.
  if (exam.status !== "ready") {
    throw conflict("This exam is no longer available.");
  }

  const attempt = await examRepository.insertAttempt({
    examId: exam.id,
    userId,
  });
  const questions = await examRepository.findQuestionsForTaking(exam.id);

  return {
    ...toAttemptShape(attempt),
    // Always null here — a just-started attempt is ungraded by definition — but
    // present for the same reason as in getAttempt: one attempt shape.
    ...toResultFields(attempt),
    exam: toExamShape(exam, questions.map(toQuestionShape)),
  };
}

/**
 * Submit an attempt and grade it (§9, §10, §11, §13).
 *
 * THE SEQUENCE IS §9'S, IN ORDER: verify ownership → verify the attempt belongs
 * to the exam → verify it is active → validate the question ids → validate the
 * answer formats → load the key → grade → persist → complete → return.
 *
 * The first three are one repository call; the shape of the answers has already
 * been checked by the middleware. What is left here is the part that needs the
 * exam's own questions to judge: that every submitted id is a question of THIS
 * exam, and that every answer is one of THAT question's option ids.
 *
 * @param {object} input
 * @returns {Promise<object>} the graded result, answers and explanations now
 *   included — §9 permits them after submission
 */
export async function submitAttempt({ username, examId, attemptId, answers }) {
  const userId = await requireUserId(username);

  const attempt = await examRepository.findOwnedAttempt({
    attemptId,
    examId,
    userId,
  });
  if (attempt === undefined) throw notFoundAttempt();

  // §11: a submitted attempt is immutable. Checked here for the clean 409, and
  // again as a compare-and-set inside completeAttempt, which is what makes it
  // hold when two submissions race rather than merely when they queue.
  if (attempt.status !== "in_progress") {
    throw conflict("This attempt has already been submitted.");
  }

  // Loaded WITHOUT the key: this is the validation pass, and it needs the option
  // ids, not the correct ones. The key is read inside the transaction below.
  const questions = await examRepository.findQuestionsForTaking(examId);
  const submitted = validateAnswers(answers, questions);

  const graded = await withTransaction(async (client) => {
    const key = await examRepository.findAnswerKey(client, examId);

    // §10, and the only call to it. Every number in the response comes from
    // here; nothing in `answers` reaches the database except the selected option
    // id, which is why §5's "never accept is_correct from a client" needs no
    // filtering step — there is no field for it to arrive in.
    const result = gradeAttempt(key, submitted);

    return examRepository.completeAttempt(client, {
      attemptId,
      userId,
      result,
    });
  });

  // The compare-and-set matched no rows, so another submission completed this
  // attempt between the check above and the UPDATE. §11's controlled conflict:
  // the original result stands and nothing of this submission was written.
  if (graded === undefined) {
    throw conflict("This attempt has already been submitted.");
  }

  const withAnswers = await examRepository.findQuestionsWithAnswers(examId);
  return toResultShape(graded.attempt, withAnswers, graded.answers);
}

/**
 * One attempt's result (§9).
 *
 * An in-progress attempt returns its questions WITHOUT the key; a completed one
 * returns the key, the explanations and what the learner chose. The branch is
 * the whole of §4's "the client MUST NOT receive the correct answer while taking
 * the exam" at this endpoint, and it is a choice between two repository
 * functions rather than a field filter.
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function getAttempt({ username, examId, attemptId }) {
  const userId = await requireUserId(username);

  const attempt = await examRepository.findOwnedAttempt({
    attemptId,
    examId,
    userId,
  });
  if (attempt === undefined) throw notFoundAttempt();

  if (attempt.status !== "completed") {
    const questions = await examRepository.findQuestionsForTaking(examId);
    return {
      ...toAttemptShape(attempt),
      // Null, not absent. The five result fields are present in every attempt
      // shape this API returns — here, in the history listing and in a graded
      // result — so a client reads `score === null` to mean "not yet graded"
      // rather than having to distinguish a missing key from a null one.
      ...toResultFields(attempt),
      questions: questions.map(toQuestionShape),
    };
  }

  const [questions, answers] = await Promise.all([
    examRepository.findQuestionsWithAnswers(examId),
    examRepository.findAnswersByAttemptId(attemptId),
  ]);

  return toResultShape(attempt, questions, answers);
}

/**
 * A learner's attempt history (§9).
 *
 * A BARE ARRAY, like every other list this API returns — GET /api/history,
 * GET /api/materials and GET /api/study-plans all do. §20: "Follow the existing
 * StudyPal response envelope. Do not create a second response style." Object
 * envelopes here carry an aggregate (`/api/progress` is `{total_questions,
 * topics}`, which is a summary, not a collection); a collection of resources is
 * an array. A `{attempts: […]}` wrapper would have been a second style worn by
 * exactly one endpoint.
 *
 * @param {object} input
 * @returns {Promise<Array<object>>}
 */
export async function listAttempts({ username }) {
  const userId = await requireUserId(username);

  const rows = await examRepository.findAttemptsByUserId(
    userId,
    ATTEMPT_LIST_LIMIT,
  );

  return rows.map(toAttemptSummaryShape);
}

/**
 * Check a submission against the exam's own questions, and turn it into the
 * grader's input.
 *
 * Three rejections, all 400, all before the transaction opens:
 *
 *   an id that is not a question of this exam — §9's "validate question IDs".
 *   Answering question 91 of someone else's exam is a malformed request, not a
 *   wrong answer, and grading it as wrong would tell the caller the id exists.
 *
 *   a duplicate id in one payload — two answers to one question have no defined
 *   winner, and silently taking the last would make the result depend on JSON
 *   ordering. attempt_answers_attempt_question_key refuses it at the database
 *   too; this is the controlled version.
 *
 *   an answer that is not one of that question's option ids — §9's "validate
 *   answer formats". Marking "Z" wrong would be a defensible alternative, but it
 *   conceals a broken client: every option id the learner can see came from this
 *   API in the first place.
 *
 * @param {Array<{questionId: number, answer: string}>} answers
 * @param {Array<object>} questions the exam's questions, WITHOUT the key
 * @returns {Map<number, string>} questionId → selected option id
 */
function validateAnswers(answers, questions) {
  const optionIds = new Map(
    questions.map((question) => [
      question.id,
      new Set(question.options.map((option) => String(option.id))),
    ]),
  );

  const submitted = new Map();

  for (const { questionId, answer } of answers) {
    const allowed = optionIds.get(questionId);
    if (allowed === undefined) {
      throw badRequest("One or more answers refer to an unknown question.");
    }
    if (submitted.has(questionId)) {
      throw badRequest("A question was answered more than once.");
    }
    if (!allowed.has(answer)) {
      throw badRequest("One or more answers are not a valid option.");
    }
    submitted.set(questionId, answer);
  }

  return submitted;
}

/**
 * Turn the model's 1-based source number into the ids §14 stores.
 *
 * `sources[n - 1]` because buildContext numbers its blocks by array position.
 * The validator has already dropped any number outside the range, so an absent
 * or unusable reference arrives here as null and both columns stay null — which
 * is the normal case for a topic-only exam and not a gap.
 *
 * Both ids come from rows the retrieval service returned for this user, so
 * exam_questions_material_user_fkey cannot be violated by a question the model
 * attributed to a document someone else owns: there was no such document in the
 * list to attribute it to.
 */
function resolveSource(sourceNumber, sources) {
  const source =
    sourceNumber === null || sourceNumber === undefined
      ? undefined
      : sources[sourceNumber - 1];

  if (source === undefined) {
    return { sourceMaterialId: null, sourceChunkId: null };
  }

  return { sourceMaterialId: source.materialId, sourceChunkId: source.chunkId };
}

/**
 * Resolve a username to a user id, or 404.
 *
 * Exam endpoints do not create users, matching the study-plan endpoints and
 * differing from POST /api/ask and POST /api/materials, which upsert. The
 * difference is deliberate: those endpoints are how a username comes into
 * existence, and an exam is generated from a learner's subject and materials
 * rather than being someone's first interaction with the service.
 */
async function requireUserId(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) throw notFoundExam();
  return userId;
}

/**
 * The 404 every exam-level ownership failure produces.
 *
 * One message for three situations — no such user, no such exam, someone else's
 * exam — because distinguishing them would tell an unauthenticated caller which
 * ids exist (§12, §15).
 */
function notFoundExam() {
  return notFound("Exam not found.");
}

/** The same, for an attempt: absent, another exam's, or another learner's. */
function notFoundAttempt() {
  return notFound("Exam attempt not found.");
}

/**
 * An exam row and its questions in the API's vocabulary (§20).
 *
 * camelCase, matching the material and study-plan endpoints. Field by field
 * rather than a spread of the row: `user_id` is on the row and must not be in
 * the response — it is an internal surrogate key the client has no use for, and
 * a spread would ship it the moment someone added a column.
 */
function toExamShape(exam, questions) {
  return {
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    difficulty: exam.difficulty,
    questionCount: exam.question_count,
    status: exam.status,
    sourceType: exam.source_type,
    topics: exam.topics,
    materialIds: exam.material_ids,
    createdAt: exam.created_at,
    updatedAt: exam.updated_at,
    questions,
  };
}

/**
 * One question as a learner taking the exam sees it.
 *
 * There is no `correctAnswer` and no `explanation` branch in this function. The
 * rows it maps come from findQuestionsForTaking, which does not select those
 * columns, so a mistake here could not expose them — the fields are absent from
 * the input, not filtered out of the output.
 */
function toQuestionShape(question) {
  return {
    id: question.id,
    order: question.question_order,
    type: question.question_type,
    question: question.question_text,
    options: question.options,
    sourceMaterialId: question.source_material_id ?? null,
  };
}

/** An attempt without its result — the in-progress shape. */
function toAttemptShape(attempt) {
  return {
    id: attempt.id,
    examId: attempt.exam_id,
    status: attempt.status,
    startedAt: attempt.started_at,
    submittedAt: attempt.submitted_at ?? null,
  };
}

/** A row from the history listing: the attempt, plus enough exam to read it. */
function toAttemptSummaryShape(row) {
  return {
    ...toAttemptShape(row),
    examTitle: row.exam_title,
    examSubject: row.exam_subject,
    examDifficulty: row.exam_difficulty,
    // Null for an attempt still in progress, which the listing includes — see
    // findAttemptsByUserId. A client rendering a history shows a resume link for
    // those rather than a score.
    ...toResultFields(row),
  };
}

/**
 * A graded attempt: the result, and every question with its answer (§9).
 *
 * This is the one shape that carries the key, and it is reachable only from a
 * `completed` attempt — submitAttempt after the transaction commits, and
 * getAttempt down its completed branch.
 */
function toResultShape(attempt, questions, answers) {
  const byQuestionId = new Map(
    answers.map((answer) => [answer.exam_question_id, answer]),
  );

  return {
    ...toAttemptShape(attempt),
    ...toResultFields(attempt),
    questions: questions.map((question) => {
      const answer = byQuestionId.get(question.id);

      return {
        ...toQuestionShape(question),
        correctAnswer: question.correct_answer,
        explanation: question.explanation,
        // Null rather than absent for a question the learner skipped: the
        // client renders "not answered" from it, and an absent key is
        // indistinguishable from a client-side bug.
        selectedAnswer: answer?.selected_answer ?? null,
        // Explicitly false for a skipped question — it scored nothing, and the
        // grader's total already counted it that way. `?? null` here would make
        // the response disagree with the percentage.
        isCorrect: answer?.is_correct ?? false,
      };
    }),
  };
}

/** The five result columns, null together while an attempt is in progress. */
function toResultFields(row) {
  return {
    score: row.score ?? null,
    totalQuestions: row.total_questions ?? null,
    correctAnswers: row.correct_answers ?? null,
    percentage: row.percentage ?? null,
    passed: row.passed ?? null,
  };
}
