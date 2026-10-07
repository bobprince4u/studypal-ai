/** Credentialed CORS: exact allowlist, plus development loopback origins. */

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
  return cors({
    credentials: true,
    allowedHeaders: ["Content-Type", "X-StudyPal-Request"],
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
