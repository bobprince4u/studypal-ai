/**
 * CORS policy.
 *
 * The pre-refactor server called bare `cors()`, which answers every origin with
 * `Access-Control-Allow-Origin: *`. For a deployed API that is too open, but
 * silently locking it down would break whichever frontend is currently live and
 * every developer running the UI on a port nobody wrote down.
 *
 * So the policy is explicit and opt-in:
 *
 *   FRONTEND_URL / CORS_ORIGINS set  →  only those origins are allowed
 *   neither set                      →  previous behaviour, plus a startup
 *                                       warning telling you to configure it
 *
 * Local development keeps working either way: the unconfigured default is
 * permissive, and DEV_ORIGINS below are always allowed outside production so
 * that setting FRONTEND_URL for a deployment does not lock a developer out of
 * their own machine.
 */

import cors from "cors";

import { config } from "../config/env.js";

/** Loopback origins allowed outside production regardless of configuration. */
const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isAllowed(origin) {
  if (config.cors.origins.includes(origin)) return true;
  if (!config.isProduction && DEV_ORIGIN_PATTERN.test(origin)) return true;
  return false;
}

export function corsMiddleware() {
  if (config.cors.allowAll) {
    // Identical headers to the previous `cors()` call.
    return cors({ origin: "*" });
  }

  return cors({
    origin(origin, callback) {
      // No Origin header at all: curl, server-to-server, health probes. These
      // are not browser cross-origin requests and there is nothing to allow.
      if (!origin) return callback(null, true);

      // Disallowed origins get a normal response with no CORS header, which is
      // what the browser expects. Erroring here would turn a policy decision
      // into a 500 and hide the real cause from the developer.
      callback(null, isAllowed(origin));
    },
  });
}
