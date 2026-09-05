/**
 * One-line request logging.
 *
 * The pre-refactor server logged nothing, which made the deployed service
 * effectively unobservable (A16). Silent under NODE_ENV=test.
 */

import { logger } from "../utils/logger.js";

/**
 * URLs contain user input — `/api/history/:username` is whatever the caller
 * sent. Existing rows in the database have usernames thousands of characters
 * long, and echoing one whole into a log line makes the log unreadable.
 */
const MAX_LOGGED_URL = 120;

function truncate(url) {
  return url.length <= MAX_LOGGED_URL
    ? url
    : `${url.slice(0, MAX_LOGGED_URL)}…[+${url.length - MAX_LOGGED_URL}]`;
}

export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      `${req.method} ${truncate(req.originalUrl)} ${res.statusCode} ${ms.toFixed(1)}ms`,
    );
  });

  next();
}
