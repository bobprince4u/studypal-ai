import { expensiveOperationLimit } from "../auth/rate-limit.middleware.js";
/**
 * The six exam endpoints (§9).
 *
 *   POST   /api/exams                                        JSON: what to test
 *   GET    /api/exams/:id?username=…
 *   POST   /api/exams/:id/attempts                           JSON: username
 *   POST   /api/exams/:id/attempts/:attemptId/submit         JSON: username, answers
 *   GET    /api/exams/:id/attempts/:attemptId?username=…
 *   GET    /api/exam-attempts?username=…
 *
 * Exactly §9's suggested set, with no additions.
 *
 * SIX, AND WHAT IS NOT HERE
 * -------------------------
 * There is no GET /api/exams list, no DELETE, and no cancel endpoint. §9 lists
 * six and this is those six; §29's closing rule — "SP-V2-006 is an exam
 * simulator, not a general StudyPal rewrite" — is the reason not to add a
 * seventh that nothing asked for. `cancelled` is a status the schema accepts
 * and nothing writes, which is a deliberate seam documented in
 * migrations/postgres/005_exams.sql: adding the endpoint would mean settling
 * what happens to a cancelled exam's in-progress attempts, and that is a
 * product question this ticket does not pose.
 *
 * The history endpoint is /api/exam-attempts rather than
 * /api/exams/attempts, exactly as §9 writes it. It is a listing of attempts
 * ACROSS exams, so nesting it under a single exam's path would misdescribe it.
 *
 * ROUTE ORDER
 * -----------
 * The submit POST is registered before the attempts POST, and that is a real
 * constraint rather than a readability choice: both are POSTs on the same
 * prefix. Express matches full paths, so the shorter cannot swallow the longer
 * — but they are written in this order so the more specific one is read first,
 * and so nobody later adds a broader POST above it and changes what matches.
 *
 * MIDDLEWARE ORDER
 * ----------------
 * Path ids are validated before the body or query, so the more specific error
 * wins when both are wrong. On the two attempt-scoped routes,
 * `validateAttemptParams` covers both ids in one pass — the route has two and
 * neither is meaningful alone.
 *
 * On submit, the username is validated before the answers: a request with no
 * username and a malformed answer list is told about the username, because it
 * is the one the caller is most likely to have simply forgotten.
 *
 * There is no multer anywhere here. Every one of these endpoints is JSON,
 * parsed by the app-level `express.json()` under config.limits.jsonBody, so an
 * oversized body is the same 413 the rest of the API gives.
 *
 * Every handler is wrapped in `asyncHandler`, so a rejected promise — a provider
 * failure, a constraint violation, an ownership 404, a double-submit 409 —
 * becomes a JSON error from the central handler rather than an unhandled
 * rejection.
 */

import { Router } from "express";

import { asyncHandler } from "../middleware/error-handler.js";
import {
  create,
  get,
  getAttempt,
  listAttempts,
  startAttempt,
  submitAttempt,
} from "./exam.controller.js";
import {
  validateAttemptParams,
  validateCreateExamBody,
  validateExamId,
  validateSubmitBody,
  validateUsernameBody,
  validateUsernameQuery,
} from "./exam-validation.middleware.js";

export const examRoutes = Router();

examRoutes.post(
  "/exams/:id/attempts/:attemptId/submit",
  validateAttemptParams,
  validateUsernameBody,
  validateSubmitBody,
  asyncHandler(submitAttempt),
);

examRoutes.post(
  "/exams/:id/attempts",
  validateExamId,
  validateUsernameBody,
  asyncHandler(startAttempt),
);

examRoutes.post("/exams", expensiveOperationLimit("exam"), validateCreateExamBody, asyncHandler(create));

examRoutes.get(
  "/exams/:id/attempts/:attemptId",
  validateAttemptParams,
  validateUsernameQuery,
  asyncHandler(getAttempt),
);

examRoutes.get(
  "/exams/:id",
  validateExamId,
  validateUsernameQuery,
  asyncHandler(get),
);

examRoutes.get(
  "/exam-attempts",
  validateUsernameQuery,
  asyncHandler(listAttempts),
);
