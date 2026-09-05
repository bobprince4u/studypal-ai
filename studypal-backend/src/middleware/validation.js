/**
 * Request validation.
 *
 * Hand-written on purpose: the API has three inputs worth checking and pulling
 * in a schema framework for them would add a dependency and a DSL without
 * buying anything this iteration needs.
 *
 * The 400 messages are reproduced exactly as the pre-refactor server worded
 * them ("Username required", "Username and question required"). The frontend
 * displays `data.error` verbatim on the login screen, so these strings are part
 * of the API contract.
 */

import { config } from "../config/env.js";
import { badRequest } from "../utils/app-error.js";

/**
 * A body can legitimately be absent here: express.json() leaves `req.body`
 * undefined when there is no JSON content-type, and multer leaves it undefined
 * when there is no multipart body. The pre-refactor server destructured it
 * unconditionally and crashed with a 500 on such requests; treating it as an
 * empty object turns those into the 400 they always should have been.
 */
function body(req) {
  return req.body ?? {};
}

/** POST /api/session — requires a non-blank username. */
export function validateSessionRequest(req, _res, next) {
  const { username } = body(req);

  if (typeof username !== "string" || !username.trim()) {
    return next(badRequest("Username required"));
  }
  if (username.trim().length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer`,
      ),
    );
  }

  // Hand the trimmed value downstream so services never re-trim.
  req.validated = { username: username.trim() };
  next();
}

/**
 * POST /api/ask — requires a username and a non-blank question.
 *
 * Note the asymmetry, preserved from the original: `username` only has to be
 * present and truthy, while `question` must be non-blank once trimmed.
 */
export function validateAskRequest(req, _res, next) {
  const { username, question } = body(req);

  if (
    typeof username !== "string" ||
    !username ||
    typeof question !== "string" ||
    !question.trim()
  ) {
    return next(badRequest("Username and question required"));
  }
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer`,
      ),
    );
  }

  // Deliberately un-trimmed: these values are persisted and echoed back by
  // GET /api/history, and the previous server stored them raw.
  req.validated = { username, question };
  next();
}

/** GET /api/history/:username and /api/progress/:username. */
export function validateUsernameParam(req, _res, next) {
  const username = req.params.username;

  if (!username) {
    return next(badRequest("Username required"));
  }

  req.validated = { username };
  next();
}
