// SP-V2-008: ownership is scoped by the authenticated immutable users.id.
/**
 * Read-only analytics for the authenticated immutable user ID.
 * Repositories enforce owner filters; calculations and serializers retain the
 * existing metrics and response shapes. Authenticated learners without evidence
 * receive empty aggregates. A missing or foreign named plan receives 404.
 * This service performs no user lookup, account creation or provider call.
 */

import { config } from "../config/env.js";
import { notFound } from "../utils/app-error.js";
import { assertUserId } from "../auth/identity.js";
import * as analyticsRepository from "./analytics.repository.js";
import {
  byWeakness,
  compareRecentPerformance,
  isWeak,
} from "./analytics.metrics.js";
import {
  toHistoryShape,
  toMaterialShape,
  toOverviewShape,
  toPlanProgressShape,
  toPlanTopicShape,
  toTopicShape,
  toWeakAreaShape,
} from "./analytics.serializers.js";

/** Zero-valued rows, in the repository's own column names. See the header. */
const NO_PLANS = Object.freeze({
  total: 0,
  active: 0,
  completed: 0,
  cancelled: 0,
  archived: 0,
});

const NO_TASKS = Object.freeze({
  total: 0,
  completed: 0,
  pending: 0,
  in_progress: 0,
  skipped: 0,
});

const NO_EXAMS = Object.freeze({ total: 0 });

const NO_ATTEMPTS = Object.freeze({
  attempts: 0,
  completed_attempts: 0,
  in_progress_attempts: 0,
  passed_attempts: 0,
  failed_attempts: 0,
  // Null, not 0. No attempt has been completed, so there is no average to
  // report — and 0 would be a claim that every attempt scored nothing.
  average_percentage: null,
  highest_percentage: null,
  lowest_percentage: null,
});

/**
 * GET /api/analytics — the overall learning summary (§2, §4, §6).
 *
 * Five reads, issued together. They are independent aggregates over different
 * tables, so serialising them would add four round trips for nothing; §15's
 * "Avoid N+1 queries" is about a query per row, and this is a fixed five
 * regardless of how much data the learner has.
 *
 * The trend and the most-recent percentage come from ONE list rather than two
 * reads: `findRecentCompletedPercentages` returns the newest `2 × trendWindow`
 * percentages, `[0]` is the most recent (§4) and the whole list is what §6's
 * comparison needs. The limit is derived from config, not from the request, so
 * a caller cannot change what the trend is computed over.
 *
 * @param {{userId: number}} input
 * @returns {Promise<object>}
 */
export async function getOverview({ userId }) {
  assertUserId(userId);

  if (userId === undefined) {
    return toOverviewShape({
      plans: NO_PLANS,
      tasks: NO_TASKS,
      exams: NO_EXAMS,
      attempts: NO_ATTEMPTS,
      // The same shape compareRecentPerformance returns when there is too
      // little history — obtained by asking it, so there is one definition of
      // "no trend" rather than a literal here that could drift from it.
      trend: compareRecentPerformance([]),
      mostRecentPercentage: null,
    });
  }

  const [plans, tasks, exams, attempts, percentages] = await Promise.all([
    analyticsRepository.findStudyPlanTotals(userId),
    analyticsRepository.findTaskTotals(userId),
    analyticsRepository.findExamTotals(userId),
    analyticsRepository.findAttemptTotals(userId),
    analyticsRepository.findRecentCompletedPercentages(
      userId,
      config.analytics.trendWindow * 2,
    ),
  ]);

  return toOverviewShape({
    plans,
    tasks,
    exams,
    attempts,
    trend: compareRecentPerformance(percentages),
    mostRecentPercentage: percentages[0] ?? null,
  });
}

/**
 * GET /api/analytics/exams — recent completed attempts, newest first (§5).
 *
 * A BARE ARRAY, matching GET /api/exam-attempts, GET /api/materials,
 * GET /api/study-plans and GET /api/history. §12: follow the existing envelope
 * and do not create a second response style. An unknown userId returns `[]`
 * rather than 404 — see the header.
 *
 * `limit` arrives already validated and clamped by the middleware; this layer
 * neither re-clamps nor defaults it, so a route that forgot the middleware
 * fails a test rather than quietly working.
 *
 * @param {{userId: number, limit: number}} input
 * @returns {Promise<Array<object>>}
 */
export async function getExamHistory({ userId, limit }) {
  assertUserId(userId);

  const rows = await analyticsRepository.findRecentCompletedAttempts(
    userId,
    limit,
  );

  return rows.map(toHistoryShape);
}

/**
 * GET /api/analytics/topics — accuracy per topic (§7).
 *
 * Ordered by topic name, which the repository's ORDER BY already applies. No
 * re-sorting here: two sort definitions for one endpoint is how an ordering
 * becomes non-deterministic.
 *
 * @param {{userId: number}} input
 * @returns {Promise<Array<object>>}
 */
export async function getTopicBreakdown({ userId }) {
  assertUserId(userId);

  const rows = await analyticsRepository.findTopicBreakdown(userId);
  return rows.map(toTopicShape);
}

/**
 * GET /api/analytics/weak-areas — topics below the threshold (§9, §10).
 *
 * THE WHOLE PIPELINE IS DETERMINISTIC AND VISIBLE IN FOUR LINES: read the same
 * rows the topics endpoint reads, shape them, keep the ones `isWeak` accepts,
 * order them by `byWeakness`. No AI, no model call, no ranking heuristic — §9
 * requires exactly this, and building it from the topic breakdown rather than
 * from a second SQL query means a weak area is by construction a row the topics
 * endpoint also reports, with the same counts and the same accuracy.
 *
 * The threshold and the evidence floor are not read here. They live in
 * analytics.metrics.js against `config.analytics`, so this file cannot apply a
 * different 60 than the one the tests pin.
 *
 * @param {{userId: number}} input
 * @returns {Promise<Array<object>>}
 */
export async function getWeakAreas({ userId }) {
  assertUserId(userId);

  const rows = await analyticsRepository.findTopicBreakdown(userId);
  const topics = rows.map(toTopicShape);

  return byWeakness(topics.filter((topic) => isWeak(topic))).map(
    toWeakAreaShape,
  );
}

/**
 * GET /api/analytics/materials — accuracy per source material (§8).
 *
 * §8 asks for material-level attribution; §13's suggested route list has no
 * home for it. A sibling collection route is the smaller of the two ways to
 * resolve that — the alternative was nesting a material array inside the
 * overview object, which would make one endpoint return both a summary and a
 * collection and would be a shape no other StudyPal endpoint has. §13 offers
 * its routes as "Suggested" and says to use existing routing conventions where
 * they fit better; a bare-array collection under /api/analytics is that
 * convention.
 *
 * @param {{userId: number}} input
 * @returns {Promise<Array<object>>}
 */
export async function getMaterialBreakdown({ userId }) {
  assertUserId(userId);

  const rows = await analyticsRepository.findMaterialBreakdown(userId);
  return rows.map(toMaterialShape);
}

/**
 * GET /api/analytics/study-plans/:id — one plan's progress (§3, §11).
 *
 * The only analytics endpoint that can 404, and the only one scoped to a named
 * resource. Ownership is the repository's `WHERE p.id = $1 AND p.user_id = $2`;
 * this function cannot ask for a plan without an owner, because
 * findPlanProgress has no id-only form.
 *
 * The plan is fetched BEFORE the topic rows rather than alongside them, which
 * costs one round trip and buys a real property: a request for another
 * learner's plan issues exactly one query and reads none of that plan's tasks.
 * Running both in parallel would read the tasks of a plan the caller does not
 * own and then discard them — the response would be identical, but the database
 * work would not, and "we looked and then threw it away" is a weaker ownership
 * story than "we never looked".
 *
 * @param {{userId: number, planId: number}} input
 * @returns {Promise<object>}
 */
export async function getPlanProgress({ userId, planId }) {
  assertUserId(userId);
  // Unknown userId and unknown plan give the same 404 as someone else's
  // plan. §11: do not leak whether another user's resource exists.

  const plan = await analyticsRepository.findPlanProgress(planId, userId);
  if (plan === undefined) throw notFoundPlan();

  const topics = await analyticsRepository.findPlanTopicProgress(
    planId,
    userId,
  );

  return toPlanProgressShape(plan, topics.map(toPlanTopicShape));
}

/**
 * Resolve a userId to a user id, or `undefined`.
 *
 * Deliberately NOT `requireUserId`. The exam and study-plan services throw 404
 * here; analytics does not, because four of its five endpoints are aggregates
 * for which "unknown user" and "no data" are the same answer — see the header.
 * The one endpoint that needs the 404 raises it itself, where the decision is
 * visible.
 *
 * It also does not create a user. §1 makes analytics read-only, and
 * `users.upsert` — which POST /api/ask and POST /api/materials use — would be a
 * write performed by a GET.
 */


/**
 * The 404 the per-plan endpoint produces.
 *
 * One message for three situations — no such user, no such plan, someone
 * else's plan — for the reason src/exams/exam.service.js records about its own:
 * distinguishing them tells a caller which ids exist.
 */
function notFoundPlan() {
  return notFound("Study plan not found.");
}
