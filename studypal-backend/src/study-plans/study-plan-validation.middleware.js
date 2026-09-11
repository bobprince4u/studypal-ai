/**
 * Request validation for /api/study-plans.
 *
 * Hand-written, like src/materials/material-validation.middleware.js, and here
 * for the same reason: this feature's accepted inputs are part of its boundary,
 * and keeping them beside it means the 400 messages can be worded freely without
 * touching the file where the older endpoints' frozen strings live.
 *
 * The two rules from the material validator hold here too:
 *
 *   • Validated values are written to `req.validated`, and handlers read only
 *     that. A controller never re-parses an id, re-trims a username, or decides
 *     what an absent `topics` means.
 *   • No rejection echoes the offending value. `?username=<script>` produces
 *     "Username is required." and nothing more.
 *
 * WHY THIS FILE IS LONG (§10)
 * ---------------------------
 * §10 requires every field to be validated server-side, and names three inputs
 * that must be refused outright: a `dailyMinutes` of -100, of 0, and of 999999.
 * All three are rejected below, by three different checks — a negative and a
 * zero fail the positive-integer test, and 999999 fails the configured ceiling.
 * They are not the same bug and they do not get the same message.
 *
 * BOUNDS COME FROM CONFIG, WHICH IS CHECKED AGAINST THE DATABASE
 * --------------------------------------------------------------
 * Every limit below is a `config.plan.*` value rather than a literal. Those
 * values are bounded at startup against the CHECK constraints in
 * migrations/postgres/004_study_plans.sql (see configWarnings in
 * src/config/env.js), so validation cannot be configured looser than the
 * database and produce a 500 where a 400 was owed. §48's "do not scatter magic
 * numbers" is the same rule seen from the other side.
 */

import { config } from "../config/env.js";
import { badRequest } from "../utils/app-error.js";
import { WEEKDAY_SET, daysBetween, isIsoDate, todayIso } from "./study-calendar.js";

/** The three values study_plans_difficulty_valid accepts. */
const DIFFICULTY_LEVELS = new Set(["beginner", "intermediate", "advanced"]);

/** The four values study_plan_tasks_status_valid accepts. */
const TASK_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "skipped",
]);

/**
 * Validate the JSON body of POST /api/study-plans (§9, §10).
 *
 * Field order is the order that produces the most useful first message:
 * identity, then what is being studied, then when, then how much, then the
 * optional scoping. A request with several problems is told about the first one
 * rather than being handed a list, matching every other validator in the service.
 */
export function validateCreatePlanBody(req, _res, next) {
  // `?? {}` for the reason the material validators do it: with no body at all,
  // `req.body` is undefined and destructuring would turn a plain 400 into a 500.
  const body = req.body ?? {};

  const username = readUsername(body.username);
  if (username === null) {
    return next(badRequest("Username is required."));
  }
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  if (typeof body.subject !== "string" || !body.subject.trim()) {
    return next(badRequest("Subject is required."));
  }
  const subject = body.subject.trim();
  // Measured after trimming, and against the same ceiling as the
  // study_plans_subject_bounded CHECK.
  if (subject.length > config.plan.maxTextChars) {
    return next(
      badRequest(
        `Subject must be ${config.plan.maxTextChars} characters or fewer.`,
      ),
    );
  }

  const topics = readTopics(body.topics);
  if (topics instanceof Error) return next(topics);

  const examDate = readExamDate(body.examDate);
  if (examDate instanceof Error) return next(examDate);

  const dailyMinutes = readDailyMinutes(body.dailyMinutes);
  if (dailyMinutes instanceof Error) return next(dailyMinutes);

  if (
    typeof body.difficultyLevel !== "string" ||
    !DIFFICULTY_LEVELS.has(body.difficultyLevel)
  ) {
    // The allowed values are listed because they are a closed set the caller
    // cannot guess, and naming them leaks nothing — they are in the public API
    // contract. Contrast the ownership 404s, which say as little as possible.
    return next(
      badRequest(
        "Difficulty level must be one of: beginner, intermediate, advanced.",
      ),
    );
  }

  const studyDays = readStudyDays(body.studyDays);
  if (studyDays instanceof Error) return next(studyDays);

  const materialIds = readMaterialIds(body.materialIds);
  if (materialIds instanceof Error) return next(materialIds);

  req.validated = {
    ...req.validated,
    username,
    subject,
    topics,
    examDate,
    dailyMinutes,
    difficultyLevel: body.difficultyLevel,
    studyDays,
    materialIds,
  };
  next();
}

/**
 * Require a `username` query parameter (§26, §27).
 *
 * Identical in behaviour to the material endpoints' validator, including the
 * array rejection — Express parses `?username=a&username=b` into an array, and
 * quietly taking the first is how filter-bypass bugs start.
 */
export function validateUsernameQuery(req, _res, next) {
  const username = readUsername(req.query?.username);
  if (username === null) {
    return next(badRequest("Username is required."));
  }
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  req.validated = { ...req.validated, username };
  next();
}

/**
 * Require a `username` in the JSON body (§28, §30).
 *
 * PATCH and the regenerate POST carry it in the body rather than the query
 * string, because both are writes with a body already. Same rules either way.
 */
export function validateUsernameBody(req, _res, next) {
  const username = readUsername((req.body ?? {}).username);
  if (username === null) {
    return next(badRequest("Username is required."));
  }
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  req.validated = { ...req.validated, username };
  next();
}

/** Parse and bound `:id` — the plan id on GET one and regenerate. */
export function validatePlanId(req, _res, next) {
  const id = readId(req.params.id);
  if (id === null) {
    return next(badRequest("Study plan id must be a positive integer."));
  }

  req.validated = { ...req.validated, id };
  next();
}

/**
 * Parse and bound `:planId` and `:taskId` — the two ids on PATCH (§28).
 *
 * Both in one middleware because the route has both and neither is useful alone.
 * The messages name which id was wrong, since the caller supplied two and a
 * single "id must be a positive integer" would not say which to fix.
 */
export function validateTaskParams(req, _res, next) {
  const planId = readId(req.params.planId);
  if (planId === null) {
    return next(badRequest("Study plan id must be a positive integer."));
  }

  const taskId = readId(req.params.taskId);
  if (taskId === null) {
    return next(badRequest("Task id must be a positive integer."));
  }

  req.validated = { ...req.validated, planId, taskId };
  next();
}

/**
 * Validate the `status` field of PATCH …/tasks/:taskId (§28).
 *
 * The learner may set any of the four, including back to `pending` — undoing a
 * completion is a normal thing to do, and a one-way transition would leave a
 * mis-tap permanent. §29's plan status is derived from whatever the tasks say
 * afterwards, so nothing downstream depends on the direction of travel.
 */
export function validateTaskStatusBody(req, _res, next) {
  const status = (req.body ?? {}).status;

  if (typeof status !== "string" || !TASK_STATUSES.has(status)) {
    return next(
      badRequest(
        "Status must be one of: pending, in_progress, completed, skipped.",
      ),
    );
  }

  req.validated = { ...req.validated, status };
  next();
}

/**
 * A trimmed non-empty username from an unknown value, or null.
 *
 * The `typeof` check is what rejects a repeated query parameter (an array) and a
 * JSON body sending `{"username": {"$ne": null}}` (an object) — both become null
 * and get the plain "Username is required."
 */
function readUsername(raw) {
  if (typeof raw !== "string") return null;
  const username = raw.trim();
  return username ? username : null;
}

/**
 * A positive integer id from a path segment, or null.
 *
 * Same reasoning as validateMaterialId: `Number()` would accept "1e3", " 12 ",
 * "0x10" and "Infinity", and `parseInt` would accept "12abc". A digits-only
 * pattern accepts exactly what an id looks like, the length bound stops a
 * thousand-digit string being parsed, and the safe-integer check refuses a value
 * that fits BIGINT but not a JavaScript number — no such id exists in practice,
 * and the alternative to rejecting it is a silently rounded lookup.
 *
 * Rejecting here rather than in SQL is also what keeps "abc" a 400: passing it to
 * a bigint parameter makes PostgreSQL raise `invalid input syntax for type
 * bigint`, and a 500 carrying a database error is what §32 forbids.
 */
function readId(raw) {
  if (!/^\d{1,19}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

/**
 * The topics array (§9).
 *
 * OPTIONAL, and absent means an empty array rather than an error. §37 requires a
 * plan to work with no materials; the same applies to topics, because "revise
 * Organic Chemistry" is a complete request and a learner who has not decomposed
 * their subject yet is precisely the one who needs a plan generated for them.
 *
 * Each entry is trimmed and blanks are dropped, so `["Kinetics", "", "  "]` is
 * one topic rather than a validation error — trailing empty inputs are a form
 * artefact, not a malformed request. A non-array, or an entry that is not a
 * string, IS an error: those indicate a client sending something other than what
 * the endpoint documents.
 *
 * @returns {Array<string> | Error}
 */
function readTopics(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("Topics must be an array.");

  const topics = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return badRequest("Each topic must be a string.");
    }
    const topic = entry.trim();
    if (topic === "") continue;
    if (topic.length > config.plan.maxTextChars) {
      return badRequest(
        `Each topic must be ${config.plan.maxTextChars} characters or fewer.`,
      );
    }
    topics.push(topic);
  }

  // Checked after filtering, against the configured cap rather than the
  // database's 100 — the cap exists because every topic goes into the prompt,
  // and a plan scoped to 100 topics is not a plan.
  if (topics.length > config.plan.maxTopics) {
    return badRequest(`A plan may have at most ${config.plan.maxTopics} topics.`);
  }

  return topics;
}

/**
 * The exam date (§9, §12).
 *
 * A `YYYY-MM-DD` calendar date, not a timestamp: an exam is on a day, and
 * accepting an instant would mean deciding whose midnight it was.
 * `isIsoDate` round-trips the value through `Date.UTC`, so 2026-02-31 and
 * 2026-13-01 are rejected rather than silently rolling over into March and
 * January — which is what `new Date("2026-02-31")` does.
 *
 * Compared against the SERVER's today (§12: "do not use the client-provided
 * local clock blindly"). Today itself is allowed: a learner cramming the night
 * before is a real user, and the calendar will simply give them at most one
 * study date — or none, which the service answers with its own message.
 *
 * @returns {string | Error}
 */
function readExamDate(raw) {
  if (typeof raw !== "string" || !isIsoDate(raw)) {
    return badRequest("Exam date must be a valid date in YYYY-MM-DD format.");
  }

  const today = todayIso();
  if (raw < today) {
    // String comparison is correct for ISO dates, and correct here for the same
    // reason the column is a DATE: both sides are zero-padded `YYYY-MM-DD`, so
    // lexical order is chronological order.
    return badRequest("Exam date must not be in the past.");
  }

  // The horizon bound. Not arbitrary tidiness: the number of study dates is what
  // sizes the schedule the model is asked to fill, and a date in 2140 would
  // produce a request for a plan spanning forty thousand study days.
  if (daysBetween(today, raw) > config.plan.maxHorizonDays) {
    return badRequest(
      `Exam date must be within ${config.plan.maxHorizonDays} days.`,
    );
  }

  return raw;
}

/**
 * Daily study minutes (§10).
 *
 * The field §10 singles out. Three rejections, three distinct reasons:
 *
 *   -100  — not a positive integer. Nonsense rather than an extreme.
 *      0  — also not positive, and the degenerate case: a plan with a zero
 *           budget has no schedule, and every task would be dropped by the
 *           normalizer for not fitting.
 * 999999  — a positive integer, and refused by the ceiling below. It is 694
 *           days of continuous study per calendar day; accepting it would let
 *           one request ask the model for an unbounded amount of content.
 *
 * The floor is separate from the positivity check because a 1-minute daily
 * budget is arithmetically fine and pedagogically useless — the model would be
 * asked for a plan whose every task is a minute long.
 *
 * @returns {number | Error}
 */
function readDailyMinutes(raw) {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return badRequest("Daily minutes must be a positive integer.");
  }
  if (raw < config.plan.minDailyMinutes) {
    return badRequest(
      `Daily minutes must be at least ${config.plan.minDailyMinutes}.`,
    );
  }
  if (raw > config.plan.maxDailyMinutes) {
    return badRequest(
      `Daily minutes must be ${config.plan.maxDailyMinutes} or fewer.`,
    );
  }
  return raw;
}

/**
 * The days of the week the learner will study (§13).
 *
 * REQUIRED, and required to be non-empty — unlike topics and materials, there is
 * no sensible default. Defaulting to all seven would schedule a learner onto days
 * they did not choose, and defaulting to none would make every request fail
 * later with a less clear message.
 *
 * Lowercased before the membership check, so "Monday" and "monday" are the same
 * day. Duplicates are rejected rather than de-duplicated: `["monday", "monday"]`
 * most likely means a client bug or a double-tapped checkbox, and silently
 * halving the list is a worse answer than saying so. This is also the invariant
 * 004_study_plans.sql notes it cannot enforce — a CHECK constraint cannot hold
 * the subquery that distinctness needs — so the application boundary is the only
 * place it can be enforced, and this is that place.
 *
 * §13's "Gemini should not be allowed to invent Saturday/Sunday tasks when those
 * days are excluded" is not enforced here but by construction: the list validated
 * below is what availableStudyDates filters on, and the model is never told a
 * weekday at all.
 *
 * @returns {Array<string> | Error}
 */
function readStudyDays(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return badRequest("At least one study day is required.");
  }
  if (raw.length > 7) {
    return badRequest("Study days must not contain more than seven days.");
  }

  const studyDays = [];
  const seen = new Set();

  for (const entry of raw) {
    if (typeof entry !== "string") {
      return badRequest(
        "Study days must be day names, for example: monday, wednesday, friday.",
      );
    }
    const day = entry.trim().toLowerCase();
    if (!WEEKDAY_SET.has(day)) {
      return badRequest(
        "Study days must be day names, for example: monday, wednesday, friday.",
      );
    }
    if (seen.has(day)) {
      return badRequest("Study days must not contain duplicates.");
    }
    seen.add(day);
    studyDays.push(day);
  }

  return studyDays;
}

/**
 * The material ids to ground the plan in (§9, §10).
 *
 * OPTIONAL — §37 requires the feature to work with no uploaded materials, so an
 * absent list is an empty one rather than an error.
 *
 * Nothing here checks OWNERSHIP, and that is the point of §10's "do not trust
 * client-provided material ownership": ownership is not a property of the
 * request, so it cannot be validated from the request. These ids are checked for
 * SHAPE here and resolved against `WHERE user_id = $2` in
 * src/study-plans/material-brief.js, which is the only place that can answer the
 * question. Duplicates are rejected because they would produce two aliases for
 * one document and two identical retrievals.
 *
 * @returns {Array<number> | Error}
 */
function readMaterialIds(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("Material ids must be an array.");

  if (raw.length > config.plan.maxMaterials) {
    return badRequest(
      `A plan may reference at most ${config.plan.maxMaterials} materials.`,
    );
  }

  const materialIds = [];
  const seen = new Set();

  for (const entry of raw) {
    // A number here, not a numeric string — these come from a JSON body rather
    // than a path segment, so the client can send the right type and there is no
    // reason to accept a looser one.
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1) {
      return badRequest("Each material id must be a positive integer.");
    }
    if (seen.has(entry)) {
      return badRequest("Material ids must not contain duplicates.");
    }
    seen.add(entry);
    materialIds.push(entry);
  }

  return materialIds;
}
