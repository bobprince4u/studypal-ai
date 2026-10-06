/**
 * Request validation for /api/analytics.
 *
 * Hand-written and feature-local, like exam-validation.middleware.js and the
 * study-plan and material validators before it. The two house rules hold here
 * unchanged:
 *
 *   • Validated values go to `req.validated`, and handlers read only that. No
 *     controller below re-parses an id or re-trims a username.
 *   • No rejection echoes the offending value. `?limit=<script>` produces
 *     "Limit must be a positive integer." and nothing more — §24's rule about
 *     not reflecting untrusted input into a response.
 *
 * WHY THIS FILE IS SHORT
 * ----------------------
 * Analytics has no request bodies. Every endpoint is a GET, every input is a
 * username, an optional limit and one path id, so there is no body reader here
 * at all — and therefore nothing a client could send that would reach a write.
 * That is not an accident of the route list: §1 makes analytics read-only, and
 * a validator with no body reader is the boundary-level statement of it.
 *
 * The username rules are deliberately IDENTICAL to the exam validator's — same
 * trim, same `config.limits.usernameLength` bound, same message. A username is
 * one concept across StudyPal, and an analytics endpoint that accepted a 300-
 * character name the exam endpoints refuse would be a second definition of it.
 */

import { badRequest } from "../utils/app-error.js";
import { config } from "../config/env.js";

/**
 * Require a `username` query parameter.
 *
 * Every analytics route has one, because every analytics query is scoped to a
 * user (§11) and this is where that user is named. There is no unscoped
 * variant and no "all users" mode — a request without a username is a 400
 * rather than a service-wide aggregate.
 */
export function validateUsernameQuery(req, _res, next) {
  const username = readUsername(req.query?.username);
  if (username === null) return next(badRequest("Username is required."));
  if (username.includes("\0")) return next(badRequest("Username contains an invalid character."));
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
 * Parse and bound the optional `limit` on GET /api/analytics/exams (§5).
 *
 * THE THREE OUTCOMES, AND WHY THEY DIFFER
 * ---------------------------------------
 *   absent          → config.analytics.historyLimit (10). §5's default.
 *   malformed, 0,
 *   or negative     → 400. "abc", "-1", "1.5" and "1e3" are not a caller asking
 *                     for a lot of rows; they are a caller with a bug, and
 *                     silently substituting 10 would hide it.
 *   above the cap   → CLAMPED to config.analytics.maxHistoryLimit (50), not
 *                     rejected. §5 says "clamp it" in as many words, and a 400
 *                     on `?limit=1000` would make a client that grew its page
 *                     size start failing rather than start getting 50.
 *
 * The clamp is the whole of §5's "Do not allow an unbounded client-controlled
 * limit", and it lives HERE rather than in the repository on purpose: the
 * repository binds whatever number it is handed, so a defensive `Math.min`
 * there would silently paper over a route that forgot this middleware instead of
 * letting a test catch it.
 *
 * `readId`'s digits-only pattern is reused rather than `Number()`, which would
 * accept "1e3", " 12 ", "0x10" and "Infinity" — the same reasoning
 * exam-validation.middleware.js records for path ids, applied to a query value
 * that also ends up as a bigint-adjacent SQL parameter.
 */
export function validateHistoryLimit(req, _res, next) {
  const raw = req.query?.limit;

  if (raw === undefined || raw === "") {
    req.validated = {
      ...req.validated,
      limit: Math.min(config.analytics.historyLimit, config.analytics.maxHistoryLimit),
    };
    return next();
  }

  const requested = readPositiveInt(raw);
  if (requested === null) {
    return next(badRequest("Limit must be a positive integer."));
  }

  req.validated = {
    ...req.validated,
    limit: Math.min(requested, config.analytics.maxHistoryLimit),
  };
  next();
}

/** Parse and bound `:id` — the study plan id on the per-plan endpoint. */
export function validatePlanId(req, _res, next) {
  const planId = readPositiveInt(req.params.id);
  if (planId === null) {
    return next(badRequest("Study plan id must be a positive integer."));
  }

  req.validated = { ...req.validated, planId };
  next();
}

/** A trimmed non-empty username, or null. Identical to the exam validator's. */
function readUsername(raw) {
  if (typeof raw !== "string") return null;
  const username = raw.trim();
  return username ? username : null;
}

/**
 * A positive integer from a path segment or query value, or null.
 *
 * The same reader the study-plan and exam validators use, for the same reason
 * exam-validation.middleware.js records: a digits-only pattern accepts exactly
 * what an id looks like, the length bound stops a thousand-digit string being
 * parsed, and the safe-integer check refuses a value that fits BIGINT but not a
 * JavaScript number.
 *
 * Rejecting here rather than in SQL is also what keeps "abc" a 400 — binding it
 * to a bigint parameter makes PostgreSQL raise `invalid input syntax for type
 * bigint`, and §24 forbids a response carrying a database error.
 *
 * An array is refused by the regex without a special case: Express gives
 * `?limit=1&limit=2` as `["1", "2"]`, and String(["1","2"]) is "1,2", which the
 * pattern rejects. A caller sending a parameter twice gets a 400 rather than
 * whichever one Express happened to keep.
 */
function readPositiveInt(raw) {
  if (typeof raw !== "string") return null;
  if (!/^\d{1,19}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}
