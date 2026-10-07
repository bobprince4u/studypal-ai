/**
 * HTTP boundary for /api/analytics.
 *
 * Thin, like the exam, material and study-plan controllers, and bound by §14's
 * three rules for this layer: HTTP concerns only, no SQL, no analytics
 * calculations. Nothing below rounds a number, compares an accuracy to a
 * threshold, or decides what counts as weak — those are in
 * analytics.metrics.js, and tests/analytics/architecture.test.js asserts this
 * file contains neither SQL nor arithmetic.
 *
 * Every value comes from `req.validated`, set by
 * analytics-validation.middleware.js. No handler re-reads `req.query`, re-parses
 * an id or re-applies the history limit's clamp — which is also why no handler
 * can be the place a limit ceiling is forgotten.
 *
 * Every response is 200. Analytics creates nothing, so there is no 201; it
 * changes nothing, so there is no 204. The only non-200 outcomes are the 400s
 * the validators raise and the single 404 the per-plan endpoint's service
 * raises, both of which reach the client through the central error handler.
 */

import * as analyticsService from "./analytics.service.js";

/** GET /api/analytics?username=… — the overall learning summary (§2). */
export async function getOverview(req, res) {
  res.json(
    await analyticsService.getOverview({ userId: req.user.id }),
  );
}

/**
 * GET /api/analytics/exams?username=…&limit=… — recent completed attempts (§5).
 *
 * `limit` is always present on `req.validated` — the middleware defaults it when
 * the query omits it — so there is no `?? 10` here. The default belongs with the
 * validation, not duplicated at the point of use.
 */
export async function getExamHistory(req, res) {
  res.json(
    await analyticsService.getExamHistory({
      userId: req.user.id,
      limit: req.validated.limit,
    }),
  );
}

/** GET /api/analytics/topics?username=… — accuracy per topic (§7). */
export async function getTopicBreakdown(req, res) {
  res.json(
    await analyticsService.getTopicBreakdown({
      userId: req.user.id,
    }),
  );
}

/** GET /api/analytics/weak-areas?username=… — deterministic weak areas (§10). */
export async function getWeakAreas(req, res) {
  res.json(
    await analyticsService.getWeakAreas({ userId: req.user.id }),
  );
}

/** GET /api/analytics/materials?username=… — accuracy per material (§8). */
export async function getMaterialBreakdown(req, res) {
  res.json(
    await analyticsService.getMaterialBreakdown({
      userId: req.user.id,
    }),
  );
}

/** GET /api/analytics/study-plans/:id?username=… — one plan's progress (§3). */
export async function getPlanProgress(req, res) {
  res.json(
    await analyticsService.getPlanProgress({
      userId: req.user.id,
      planId: req.validated.planId,
    }),
  );
}
