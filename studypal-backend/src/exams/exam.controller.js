/**
 * HTTP boundary for /api/exams and /api/exam-attempts.
 *
 * Thin, like the material and study-plan controllers and for the same reasons
 * (§23): read the validated input, call one service function, send JSON. No
 * SQL, no prompt construction, no Gemini call, and no grading — §23 names three
 * of those outright ("Controllers must not contain SQL, directly call Gemini, or
 * perform complex grading"), and tests/exams/architecture.test.js asserts them
 * by reading this file.
 *
 * Every value comes from `req.validated`, set by
 * exam-validation.middleware.js. Nothing here re-reads `req.body`, re-parses an
 * id, or decides what an absent field means — which is also why no handler below
 * can accidentally forward a client-supplied `score` (§5): it would have to read
 * `req.body` to find one.
 */

import * as examService from "./exam.service.js";

/**
 * POST /api/exams — generate and persist an exam (§9).
 *
 * 201 with the exam and its questions, WITHOUT the answer key. 201 rather than
 * 200 because a resource was created, and rather than 202 because it was
 * created before the response was sent: generation is synchronous here,
 * matching the study-plan and upload paths and §19's exclusion of queues.
 *
 * The questions are in the body because the client needs them to render the
 * exam, and a 201 with only an id would make every generation two round trips.
 */
export async function create(req, res) {
  const exam = await examService.createExam({
    userId: req.user.id,
    subject: req.validated.subject,
    topics: req.validated.topics,
    difficulty: req.validated.difficulty,
    questionCount: req.validated.questionCount,
    questionTypes: req.validated.questionTypes,
    materialIds: req.validated.materialIds,
  });

  res.status(201).json(exam);
}

/** GET /api/exams/:id?username=… — one exam, questions without answers (§9). */
export async function get(req, res) {
  res.json(
    await examService.getExam({
      userId: req.user.id,
      examId: req.validated.examId,
    }),
  );
}

/**
 * POST /api/exams/:id/attempts — start an attempt (§9).
 *
 * 201: an attempt is a resource, and this is the only way one comes into
 * existence. The questions ride along so that starting an exam is one round
 * trip rather than two.
 */
export async function startAttempt(req, res) {
  const attempt = await examService.startAttempt({
    userId: req.user.id,
    examId: req.validated.examId,
  });

  res.status(201).json(attempt);
}

/**
 * POST /api/exams/:id/attempts/:attemptId/submit — grade it (§9, §10).
 *
 * 200 rather than 201: this completes the attempt that already exists rather
 * than creating anything. The response is the full result — score, pass/fail,
 * and every question with its correct answer and explanation, which §9 permits
 * only from here onwards.
 */
export async function submitAttempt(req, res) {
  res.json(
    await examService.submitAttempt({
      userId: req.user.id,
      examId: req.validated.examId,
      attemptId: req.validated.attemptId,
      answers: req.validated.answers,
    }),
  );
}

/** GET /api/exams/:id/attempts/:attemptId?username=… — one attempt (§9). */
export async function getAttempt(req, res) {
  res.json(
    await examService.getAttempt({
      userId: req.user.id,
      examId: req.validated.examId,
      attemptId: req.validated.attemptId,
    }),
  );
}

/** GET /api/exam-attempts?username=… — that learner's history (§9). */
export async function listAttempts(req, res) {
  res.json(
    await examService.listAttempts({ userId: req.user.id }),
  );
}
