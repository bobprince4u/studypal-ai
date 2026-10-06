/**
 * The deterministic arithmetic of SP-V2-007.
 *
 * Pure functions over plain data: no database, no request, no clock, no
 * provider. The same separation src/exams/grader.js makes, for the same reason
 * — every rule that decides an OUTCOME (what rounds to what, what counts as
 * weak, which direction a trend points) is stated exactly once, in a module
 * that can be tested exhaustively in milliseconds without a server.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is not a second grader. Nothing here compares an answer to a key or
 * decides whether a response was correct — SP-V2-006 did that at submission
 * time and wrote the verdict to `attempt_answers.is_correct` and the score to
 * `exam_attempts`. The functions below COUNT rows that were already judged.
 * §4 and §7 both forbid re-deriving correctness here, and the absence of any
 * comparison against `correct_answer` in this file is that rule's
 * implementation: the column is never selected by the analytics repository, so
 * there is nothing here to compare against even by mistake.
 *
 * THE ONE ROUNDING RULE
 * ---------------------
 * `round2` is the only rounding in the feature, and every percentage and
 * average the API returns has passed through it. §3 asks for one rule and for
 * it to be documented: it is `Math.round(value * 100) / 100` — two decimal
 * places, ties toward positive infinity.
 *
 * Exam percentages arrive already whole (SP-V2-006's grader stores an INTEGER
 * percentage), so the decimals only ever appear in AVERAGES of them and in
 * accuracy computed here. Rounding the average of already-rounded integers
 * loses nothing further; it is not compounding a rounding error, because the
 * underlying percentages are themselves the stored, authoritative values.
 *
 * EMPTINESS IS NULL, NEVER ZERO
 * -----------------------------
 * A percentage or average over an empty set is `null`. Not 0, and never NaN.
 * Zero is a real measurement — 0% accuracy means every answer was wrong — so
 * using it for "no data" would make a student who has done nothing
 * indistinguishable from one who got everything wrong. §18 forbids NaN,
 * Infinity and undefined; this module additionally forbids a false zero, and
 * the guards below are why a division by zero can never be reached.
 */

import { config } from "../config/env.js";

/**
 * The one rounding rule: two decimal places.
 *
 * Guards non-finite input rather than propagating it. Every caller below
 * divides by a count it has already checked is positive, so a NaN reaching
 * here would be a bug in this file — returning null makes it visible in the
 * response as an absent value instead of serialising as `null` from
 * JSON.stringify(NaN) and looking identical to "no data" anyway.
 *
 * @param {number} value
 * @returns {number | null}
 */
export function round2(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * `part / whole` as a rounded percentage, or null when there is no whole.
 *
 * The single division in the feature. Every percentage the API returns —
 * task completion, topic accuracy, material accuracy — comes through here, so
 * "what does StudyPal mean by a percentage" has one answer.
 *
 * @param {number} part
 * @param {number} whole
 * @returns {number | null} null when `whole` is 0 — see the header
 */
export function percentageOf(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return null;
  }
  return round2((part / whole) * 100);
}

/**
 * The mean of a list of numbers, or null when the list is empty.
 *
 * @param {Array<number>} values
 * @returns {number | null}
 */
export function averageOf(values) {
  if (!Array.isArray(values) || values.length === 0) return null;

  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
    total += value;
  }

  return round2(total / values.length);
}

/**
 * Turn one topic's answered-question counts into a breakdown row.
 *
 * `correct` and `attempted` are both counted from `attempt_answers` rows —
 * that is, from questions the learner actually ANSWERED. `incorrect` is
 * derived rather than counted separately so that
 * `correct + incorrect === questionsAttempted` holds by construction and
 * cannot drift.
 *
 * NOTE ON THE DENOMINATOR, because it differs from the exam score on purpose.
 * An exam percentage is over every question ON THE PAPER (SP-V2-006 counts an
 * unanswered question as wrong). Accuracy here is over every question
 * ATTEMPTED, because the field is called `questionsAttempted` and an
 * unanswered question leaves no `attempt_answers` row to attribute to a topic.
 * A learner who answers three of ten questions correctly and skips the rest
 * scores 30% on the exam and 100% accuracy on its topics. Both numbers are
 * right; they measure different things, and
 * docs/learning-analytics-architecture.md says so where a reader will meet it.
 *
 * @param {{key: string|number, attempted: number, correct: number}} counts
 * @returns {{questionsAttempted: number, correct: number, incorrect: number,
 *   accuracyPercentage: number | null}}
 */
export function accuracyBreakdown({ attempted, correct }) {
  const questionsAttempted = Number(attempted) || 0;
  const correctAnswers = Number(correct) || 0;

  return {
    questionsAttempted,
    correct: correctAnswers,
    incorrect: questionsAttempted - correctAnswers,
    accuracyPercentage: percentageOf(correctAnswers, questionsAttempted),
  };
}

/**
 * §9's weak-area rule, and the only place it is stated.
 *
 * A topic is weak when it has ENOUGH EVIDENCE and accuracy BELOW the
 * threshold:
 *
 *     questionsAttempted >= minTopicAttempts   (default 3)
 *     AND accuracyPercentage < weakThreshold   (default 60)
 *
 * The comparison is strict, which §9 spells out case by case and §22 pins as a
 * test matrix:
 *
 *     3 attempts at 59.99%  → weak
 *     3 attempts at 60%     → NOT weak
 *     3 attempts at 60.01%  → NOT weak
 *     2 attempts at 0%      → NOT weak (insufficient evidence, not strength)
 *     0 attempts            → NOT weak, and never even reaches this function
 *
 * "Not weak" is deliberately not the same claim as "strong". A topic with two
 * wrong answers out of two is not reported as a weakness because two questions
 * are not evidence — not because the learner is fine at it. §10's wording is
 * followed here: this is a measurable performance breakdown, not a ranking of
 * ability.
 *
 * @param {{questionsAttempted: number, accuracyPercentage: number | null}} row
 * @param {object} [options] thresholds; injectable so a test can state its own
 * @returns {boolean}
 */
export function isWeak(
  { questionsAttempted, accuracyPercentage },
  {
    minTopicAttempts = config.analytics.minTopicAttempts,
    weakThreshold = config.analytics.weakTopicAccuracyThreshold,
  } = {},
) {
  // An accuracy of null means no attempted questions, which the evidence floor
  // would reject anyway. Checked first so the comparison below is never
  // `null < 60`, which JavaScript would happily evaluate as true.
  if (accuracyPercentage === null || accuracyPercentage === undefined) {
    return false;
  }
  if (questionsAttempted < minTopicAttempts) return false;

  return accuracyPercentage < weakThreshold;
}

/**
 * §10's deterministic ordering for the weak-area list.
 *
 * Three keys, applied in order:
 *
 *   1. lowest accuracy first     — the largest measured gap leads
 *   2. most questions first      — at equal accuracy, the better-evidenced one
 *   3. topic name, A-Z           — the stable tie-break
 *
 * The third key is what makes this DETERMINISTIC rather than merely sorted.
 * Array.prototype.sort is stable in modern V8, but stability only preserves
 * the order rows arrived in — and rows arrive from PostgreSQL, whose own
 * ordering for equal keys is not guaranteed. Without a total order on the data
 * itself, two runs against identical data could differ. `localeCompare` is
 * avoided deliberately: it is locale-sensitive, so the same data could sort
 * differently on two machines, which is exactly the property this key exists to
 * remove.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>} a new array; the input is not mutated
 */
export function byWeakness(rows) {
  return [...rows].sort((a, b) => {
    if (a.accuracyPercentage !== b.accuracyPercentage) {
      return a.accuracyPercentage - b.accuracyPercentage;
    }
    if (a.questionsAttempted !== b.questionsAttempted) {
      return b.questionsAttempted - a.questionsAttempted;
    }
    return String(a.topic) < String(b.topic) ? -1 : String(a.topic) > String(b.topic) ? 1 : 0;
  });
}

/**
 * §6's recent-performance comparison.
 *
 * THIS IS HISTORY, NOT PREDICTION. It compares two windows of completed
 * attempts that have already happened and reports the difference between their
 * averages. It does not forecast, and the DTO deliberately carries no word that
 * suggests it does — `direction` describes the two windows, not the next
 * attempt.
 *
 * THE ALGORITHM, EXACTLY
 * ----------------------
 * Given completed attempts ordered most-recent-first:
 *
 *     window = min(trendWindow, floor(attempts.length / 2))   default cap 5
 *     if window < minTrendWindow (default 2) → {null, null, null}
 *     recent   = attempts[0 .. window)
 *     previous = attempts[window .. 2 * window)
 *     difference = round2(average(recent) - average(previous))
 *     direction  = difference > 0 ? "up" : difference < 0 ? "down" : "flat"
 *
 * THE WINDOWS ARE ALWAYS THE SAME SIZE, which is the one design decision worth
 * defending. §6 suggests "latest 5 vs preceding 5"; taken literally with six
 * attempts that compares a five-attempt average against a one-attempt average,
 * and a single unlucky exam then dominates a number presented as a trend.
 * Halving instead means both sides always carry equal weight, and the cost is
 * only that a user needs four completed attempts rather than six before a
 * direction appears.
 *
 * "flat" rather than null for a zero difference: the comparison was made and
 * its answer was "no change", which is a finding. null is reserved for "not
 * enough data to compare", and conflating the two would lose that distinction.
 *
 * @param {Array<number>} percentages completed attempts, most recent first
 * @param {object} [options]
 * @returns {{recentAveragePercentage: number|null,
 *   previousAveragePercentage: number|null, difference: number|null,
 *   direction: "up"|"down"|"flat"|null}}
 */
export function compareRecentPerformance(
  percentages,
  {
    trendWindow = config.analytics.trendWindow,
    minTrendWindow = config.analytics.minTrendWindow,
  } = {},
) {
  const values = Array.isArray(percentages) ? percentages : [];
  const window = Math.min(trendWindow, Math.floor(values.length / 2));

  if (window < minTrendWindow) return NO_TREND;

  const recent = values.slice(0, window);
  const previous = values.slice(window, window * 2);

  const recentAveragePercentage = averageOf(recent);
  const previousAveragePercentage = averageOf(previous);

  if (recentAveragePercentage === null || previousAveragePercentage === null) {
    return NO_TREND;
  }

  const difference = round2(
    recentAveragePercentage - previousAveragePercentage,
  );

  return {
    recentAveragePercentage,
    previousAveragePercentage,
    difference,
    direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat",
  };
}

/**
 * The shape returned when there is not enough history to compare.
 *
 * Every field is present and null rather than the object being absent, so a
 * consumer reads `trend.direction` without first checking that `trend` exists
 * — the same reasoning that makes `progress.topics` always an array in
 * src/services/question.service.js.
 *
 * Frozen and shared: it is returned from two branches above and must not be
 * mutable by a caller who receives it.
 */
const NO_TREND = Object.freeze({
  recentAveragePercentage: null,
  previousAveragePercentage: null,
  difference: null,
  direction: null,
});
