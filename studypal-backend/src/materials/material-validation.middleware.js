/**
 * Request validation for /api/materials.
 *
 * Hand-written, matching src/middleware/validation.js — the API has few inputs
 * and a schema framework would add a dependency and a DSL for three checks.
 *
 * Lives under src/materials/ rather than in src/middleware/ because it is part of
 * this feature's boundary and nothing else uses it. src/middleware/validation.js
 * holds the validators for the pre-existing endpoints, whose 400 messages are a
 * frozen part of that contract (§19); keeping the new ones here means they can be
 * worded freely without anyone editing the file those strings live in.
 *
 * Two rules for everything below:
 *
 *   • Validated values are written to `req.validated`, and handlers read only
 *     that. So a controller never re-parses an id or re-trims a username, and
 *     there is one place to look for what the endpoint accepts.
 *   • Every rejection is an AppError with a client-safe message; none of them
 *     echoes the offending value back. `?username=<script>` produces "Username is
 *     required." and nothing else.
 */

import { config } from "../config/env.js";
import { badRequest } from "../utils/app-error.js";

/**
 * The username, from the query string.
 *
 * §10 puts it there for all four read/delete endpoints: `?username=<username>`.
 * Being in a URL is exactly why this identity model is not authentication — query
 * strings land in access logs, browser history and `Referer` headers — which is
 * S1 in docs/security-baseline.md, unchanged here.
 *
 * @returns {string | null} the trimmed username, or null if absent/blank
 */
function queryUsername(req) {
  const raw = req.query?.username;
  // Express parses `?username=a&username=b` into an ARRAY. Rejected rather than
  // taking the first: a repeated parameter is an ambiguous request, and quietly
  // picking one is how filter-bypass bugs start.
  if (typeof raw !== "string") return null;
  const username = raw.trim();
  return username ? username : null;
}

/**
 * Require a `username` query parameter.
 *
 * Used by list, get, status and delete. Trimmed, unlike POST /api/ask's
 * deliberately-untrimmed username — the material endpoints are new, so they get
 * the sane behaviour rather than inheriting that inconsistency. The upload path
 * trims too (see below), so a username is treated the same way throughout
 * /api/materials.
 */
export function validateUsernameQuery(req, _res, next) {
  const username = queryUsername(req);
  if (!username) {
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
 * Require a `username` field in the multipart body.
 *
 * Must run AFTER the multer middleware: until the multipart body is parsed there
 * is no `req.body` to read. Same ordering constraint as /api/ask, noted in
 * material.routes.js.
 */
export function validateUploadBody(req, _res, next) {
  // `?? {}` because multer leaves `req.body` undefined when there is no multipart
  // body at all. Destructuring it directly would throw a TypeError and surface as
  // a 500 for what is plainly a 400 — the bug the existing validator's `body()`
  // helper exists to avoid.
  const raw = (req.body ?? {}).username;

  if (typeof raw !== "string" || !raw.trim()) {
    return next(badRequest("Username is required."));
  }
  const username = raw.trim();
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  // Checked here so "no file" is a 400 from the same layer, in the same JSON
  // shape, as "no username" — rather than the service throwing for one and the
  // middleware for the other.
  if (!req.file) {
    return next(badRequest('A file is required, in a field named "file".'));
  }

  req.validated = { ...req.validated, username };
  next();
}

/**
 * Parse and bound `:id`.
 *
 * `materials.id` is a BIGINT identity, so a valid id is a positive integer. The
 * checks below reject everything else BEFORE it reaches SQL, which matters for
 * more than tidiness: passing "abc" to a bigint parameter makes PostgreSQL raise
 * `invalid input syntax for type bigint`, and a 500 carrying a database error
 * message is exactly what §20 forbids. A 400 here is both the honest status and
 * the safe one.
 */
export function validateMaterialId(req, _res, next) {
  const raw = req.params.id;

  // Number() would accept "1e3", " 12 ", "0x10" and "Infinity"; parseInt would
  // accept "12abc". An explicit digits-only pattern accepts exactly what an id
  // looks like. The length bound stops a caller sending a thousand digits to be
  // parsed.
  if (!/^\d{1,19}$/.test(raw)) {
    return next(badRequest("Material id must be a positive integer."));
  }

  const id = Number(raw);
  // 19 digits fits inside PostgreSQL's BIGINT but overflows the range JavaScript
  // can represent exactly, so a value above 2^53-1 could not be compared
  // reliably. No such id can exist in practice; rejecting it is still the right
  // answer, because the alternative is a silently rounded lookup.
  if (!Number.isSafeInteger(id) || id < 1) {
    return next(badRequest("Material id must be a positive integer."));
  }

  req.validated = { ...req.validated, id };
  next();
}
