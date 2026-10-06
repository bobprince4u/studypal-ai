/**
 * The six analytics endpoints (§13).
 *
 *   GET /api/analytics?username=…
 *   GET /api/analytics/exams?username=…&limit=…
 *   GET /api/analytics/topics?username=…
 *   GET /api/analytics/weak-areas?username=…
 *   GET /api/analytics/materials?username=…
 *   GET /api/analytics/study-plans/:id?username=…
 *
 * §13's five suggested routes, plus /materials. The addition is §8's: it asks
 * for material-level attribution, §13's list gives it nowhere to go, and §13
 * offers its routes as "Suggested" and says to use existing routing conventions
 * where they fit better. A sibling bare-array collection is that convention —
 * the alternative was a material array nested inside the overview object, which
 * would make one endpoint return both a summary and a collection.
 *
 * ALL SIX ARE GET, AND THERE IS NO SEVENTH
 * ----------------------------------------
 * There is no POST, PUT, PATCH or DELETE under /api/analytics, and there must
 * not be: §1 makes analytics a read-only consumer, and a router with only GETs
 * is the routing-level statement of that. tests/analytics/architecture.test.js
 * asserts it by reading this file.
 *
 * There is also no recommendation endpoint, no "what should I study next", and
 * no /api/analytics/suggestions. §1: "SP-V2-007 implements ONLY the analytics
 * layer. It must NOT decide what the student should study next." The weak-area
 * endpoint reports a measurement; turning that into advice is a later phase.
 *
 * ROUTE ORDER
 * -----------
 * The four static sub-paths are registered before the parameterised
 * /study-plans/:id, and the bare /analytics last. Express matches full paths, so
 * none of these can actually shadow another — /analytics/topics and
 * /analytics/study-plans/:id have different segment counts. They are written
 * specific-first anyway, so that adding /analytics/:something later would be
 * visibly wrong rather than silently swallowing /analytics/topics.
 *
 * MIDDLEWARE ORDER
 * ----------------
 * The path id is validated before the query, so the more specific error wins
 * when both are wrong — matching src/exams/exam.routes.js. On the history
 * route the username is validated before the limit, because a caller who
 * omitted both is most likely to have forgotten the username.
 *
 * Every handler is wrapped in `asyncHandler`, so a rejected promise — a
 * connection failure, an ownership 404 — becomes a JSON error from the central
 * handler rather than an unhandled rejection.
 */

import { Router } from "express";

import { asyncHandler } from "../middleware/error-handler.js";
import {
  getExamHistory,
  getMaterialBreakdown,
  getOverview,
  getPlanProgress,
  getTopicBreakdown,
  getWeakAreas,
} from "./analytics.controller.js";
import {
  validateHistoryLimit,
  validatePlanId,
  validateUsernameQuery,
} from "./analytics-validation.middleware.js";

export const analyticsRoutes = Router();

analyticsRoutes.get(
  "/analytics/exams",
  validateUsernameQuery,
  validateHistoryLimit,
  asyncHandler(getExamHistory),
);

analyticsRoutes.get(
  "/analytics/topics",
  validateUsernameQuery,
  asyncHandler(getTopicBreakdown),
);

analyticsRoutes.get(
  "/analytics/weak-areas",
  validateUsernameQuery,
  asyncHandler(getWeakAreas),
);

analyticsRoutes.get(
  "/analytics/materials",
  validateUsernameQuery,
  asyncHandler(getMaterialBreakdown),
);

analyticsRoutes.get(
  "/analytics/study-plans/:id",
  validatePlanId,
  validateUsernameQuery,
  asyncHandler(getPlanProgress),
);

analyticsRoutes.get(
  "/analytics",
  validateUsernameQuery,
  asyncHandler(getOverview),
);
