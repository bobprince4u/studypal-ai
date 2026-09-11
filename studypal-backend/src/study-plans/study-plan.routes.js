/**
 * The five study-plan endpoints (§26-§30).
 *
 *   POST   /api/study-plans                                  JSON: the learner's goals
 *   GET    /api/study-plans?username=…
 *   GET    /api/study-plans/:id?username=…
 *   PATCH  /api/study-plans/:planId/tasks/:taskId            JSON: username, status
 *   POST   /api/study-plans/:id/regenerate                   JSON: username
 *
 * FIVE, AND WHAT IS NOT HERE
 * --------------------------
 * There is no DELETE and no cancel endpoint. §2 lists "plan deletion or
 * cancellation" as in scope *if appropriate*, and it is not yet: `cancelled` is a
 * status the schema accepts and nothing writes, which is a deliberate seam rather
 * than an oversight. Adding the endpoint would mean answering what happens to a
 * cancelled plan's tasks, whether a cancelled plan can be regenerated, and
 * whether cancel and delete are the same act — three product questions this
 * ticket does not settle, and §56's "do not expand this task" is the reason not
 * to settle them by guessing. The status is documented as reserved in
 * migrations/postgres/004_study_plans.sql and in docs/study-plan-architecture.md.
 *
 * Archiving DOES happen, and only as a consequence of regeneration — see §30 and
 * insertPlanWithTasks. It is not an endpoint either.
 *
 * ROUTE ORDER
 * -----------
 * `/study-plans/:id/regenerate` is registered before `/study-plans`, and unlike
 * the material routes' `/status` case this is a real constraint rather than a
 * readability choice: both are POSTs on the same prefix. Express matches full
 * paths, so `POST /study-plans` cannot swallow a two-segment path — but the two
 * are written in this order so the more specific POST is read first, and so
 * nobody later adds `POST /study-plans/:id` above it and changes what matches.
 *
 * MIDDLEWARE ORDER
 * ----------------
 * Path ids are validated before the body or query, so the more specific error
 * wins when both are wrong. On PATCH, `validateTaskParams` covers both ids in one
 * pass — the route has two and neither is meaningful alone.
 *
 * There is no multer anywhere here. Every one of these endpoints is JSON, parsed
 * by the app-level `express.json()` under config.limits.jsonBody, so an oversized
 * body is the same 413 the rest of the API gives.
 *
 * Every handler is wrapped in `asyncHandler`, so a rejected promise — a provider
 * failure, a constraint violation, an ownership 404 — becomes a JSON error from
 * the central handler rather than an unhandled rejection. That matters more on
 * this feature than on most: every write path here is `async` several calls deep.
 */

import { Router } from "express";

import { asyncHandler } from "../middleware/error-handler.js";
import {
  validateCreatePlanBody,
  validatePlanId,
  validateTaskParams,
  validateTaskStatusBody,
  validateUsernameBody,
  validateUsernameQuery,
} from "./study-plan-validation.middleware.js";
import {
  create,
  get,
  list,
  regenerate,
  updateTaskStatus,
} from "./study-plan.controller.js";

export const studyPlanRoutes = Router();

studyPlanRoutes.post(
  "/study-plans/:id/regenerate",
  validatePlanId,
  validateUsernameBody,
  asyncHandler(regenerate),
);

studyPlanRoutes.post(
  "/study-plans",
  validateCreatePlanBody,
  asyncHandler(create),
);

studyPlanRoutes.get(
  "/study-plans",
  validateUsernameQuery,
  asyncHandler(list),
);

studyPlanRoutes.get(
  "/study-plans/:id",
  validatePlanId,
  validateUsernameQuery,
  asyncHandler(get),
);

studyPlanRoutes.patch(
  "/study-plans/:planId/tasks/:taskId",
  validateTaskParams,
  validateUsernameBody,
  validateTaskStatusBody,
  asyncHandler(updateTaskStatus),
);
