/**
 * GET /health
 *
 * Checks only what this process owns: is the SQLite file readable? It does NOT
 * contact Gemini. A liveness probe that depends on a third-party API would take
 * the service out of rotation whenever that API had a bad minute, and would
 * spend quota on every poll.
 */

import { checkDatabaseHealth } from "../config/database.js";
import { logger } from "../utils/logger.js";
import { version } from "../utils/version.js";

export function health(_req, res) {
  const database = checkDatabaseHealth();

  if (!database.ok) {
    // Logged with detail; the response says only that the check failed.
    logger.error(`health check failed: ${database.error}`);
  }

  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? "ok" : "degraded",
    uptime_seconds: Math.round(process.uptime()),
    version,
    database: database.ok ? "ok" : "unavailable",
  });
}
