/**
 * Calendar arithmetic for study plans. Pure functions, no I/O, no model.
 *
 * Every date in this module is a `YYYY-MM-DD` STRING and stays one. Nothing here
 * returns a JS `Date`, and that is the whole design:
 *
 *   new Date("2026-09-14")           → 2026-09-14T00:00:00Z  (parsed as UTC)
 *   new Date(2026, 8, 14)            → local midnight
 *   new Date("2026-09-14").getDay()  → the weekday IN THE LOCAL ZONE
 *
 * Those three lines disagree with each other west of Greenwich, which is how a
 * scheduler ends up putting a task on Sunday for a learner who excluded Sundays,
 * on a server whose timezone nobody thought about. A string has no zone to get
 * wrong, so the only place a real Date exists below is inside a single expression
 * built from Date.UTC, where both the construction and the read are UTC.
 *
 * src/config/pg-types.js is the other half of this: it parses PostgreSQL DATE
 * columns as raw strings, so a date that goes into the database in this form
 * comes back in the same form rather than as a Date at local midnight.
 */

/**
 * Weekday names, indexed by `Date.prototype.getUTCDay()` — Sunday is 0.
 *
 * The same seven lowercase strings the API accepts, the study_plans.study_days
 * column stores, and the study_plans_study_days_valid CHECK enforces. One array,
 * so the index-to-name mapping cannot drift from the validator's allowed set.
 */
export const WEEKDAYS = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

/** The same names as a Set, for membership checks in validation. */
export const WEEKDAY_SET = new Set(WEEKDAYS);

/** Milliseconds in a day. Safe as a constant because every date here is UTC. */
const DAY_MS = 86_400_000;

/**
 * Whether `value` is a real calendar date written exactly as `YYYY-MM-DD`.
 *
 * Both halves are needed. The regex alone accepts 2026-02-31 and 2026-13-01,
 * which `Date.UTC` silently rolls over into March and January of the next year
 * — so the parsed date is formatted back and compared, and anything that moved
 * was not the date it claimed to be. `new Date(value)` alone is worse still: it
 * accepts "2026-9-4", "Sep 4 2026" and, in some engines, very nearly anything.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const millis = Date.UTC(year, month - 1, day);
  return Number.isFinite(millis) && toIsoDate(millis) === value;
}

/** Format a UTC timestamp as `YYYY-MM-DD`. */
function toIsoDate(millis) {
  return new Date(millis).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → UTC milliseconds. Caller must have validated the string. */
function toMillis(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Today's date, in UTC, as `YYYY-MM-DD`.
 *
 * §12: the backend decides when a plan starts. A client-supplied "today" is a
 * value from a device whose clock and timezone are both unknown and both
 * trivially changeable, and accepting one would let a request schedule a plan
 * into the past or across an exam date that has already passed.
 *
 * UTC rather than the server's local zone, matching everything else in this
 * service — src/config/database.js pins the session TimeZone to UTC precisely so
 * that two deployments of this code agree about what day it is.
 *
 * @returns {string}
 */
export function todayIso() {
  return toIsoDate(Date.now());
}

/**
 * The weekday name of a date.
 *
 * @param {string} dateStr validated `YYYY-MM-DD`
 * @returns {string} one of WEEKDAYS
 */
export function weekdayOf(dateStr) {
  return WEEKDAYS[new Date(toMillis(dateStr)).getUTCDay()];
}

/**
 * `dateStr` shifted by `days`, which may be negative.
 *
 * @param {string} dateStr validated `YYYY-MM-DD`
 * @param {number} days
 * @returns {string}
 */
export function addDays(dateStr, days) {
  return toIsoDate(toMillis(dateStr) + days * DAY_MS);
}

/**
 * Whole days from `from` to `to`; negative when `to` is earlier.
 *
 * Exact, not approximate: both operands are UTC midnights, so there is no
 * daylight-saving hour to make the division land on 0.958 of a day.
 *
 * @param {string} from validated `YYYY-MM-DD`
 * @param {string} to validated `YYYY-MM-DD`
 * @returns {number}
 */
export function daysBetween(from, to) {
  return (toMillis(to) - toMillis(from)) / DAY_MS;
}

/**
 * Every date from `from` to `to` inclusive that falls on a day the learner
 * agreed to study.
 *
 * THE FUNCTION §13 IS ABOUT. The set of dates a task may legally occupy is
 * computed here, from the learner's own `studyDays`, before the model is called
 * and without reference to anything it returns. A task cannot land on an excluded
 * weekday because the scheduler only ever assigns dates drawn from this list.
 *
 * `maxDates` bounds the walk. An exam date far in the future would otherwise
 * enumerate every Tuesday for a century; validation rejects such a request first
 * (config.plan.maxHorizonDays), and this is the backstop that keeps a code path
 * which skipped validation from building an unbounded array.
 *
 * Returns ascending, which is what makes the packing in plan-normalizer.js a
 * single forward pass.
 *
 * @param {object} range
 * @param {string} range.from first candidate date, inclusive
 * @param {string} range.to last candidate date, inclusive
 * @param {Array<string>|Set<string>} range.studyDays allowed weekday names
 * @param {number} range.maxDates hard ceiling on the returned length
 * @returns {Array<string>} ascending `YYYY-MM-DD`, possibly empty
 */
export function availableStudyDates({ from, to, studyDays, maxDates }) {
  const allowed = studyDays instanceof Set ? studyDays : new Set(studyDays);
  const dates = [];

  // Iterating by day rather than jumping weekday to weekday: the arithmetic is
  // the same cost at this scale (at most maxHorizonDays iterations) and it has
  // no edge cases around which weekday the range starts on.
  for (
    let millis = toMillis(from), end = toMillis(to);
    millis <= end && dates.length < maxDates;
    millis += DAY_MS
  ) {
    const date = toIsoDate(millis);
    if (allowed.has(WEEKDAYS[new Date(millis).getUTCDay()])) dates.push(date);
  }

  return dates;
}
