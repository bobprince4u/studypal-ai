/**
 * Minimal level-aware logger.
 *
 * The pre-refactor server had no logging beyond a bare `console.error(err)`
 * (recorded as A16). This adds just enough structure to see what the API is
 * doing, without pulling in a logging dependency for an iteration whose point
 * is architectural groundwork.
 *
 * `LOG_LEVEL=silent` (the default under NODE_ENV=test) keeps test output clean.
 */

import { config } from "../config/env.js";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, stream, args) {
  if (LEVELS[level] > threshold) return;
  stream(`[${new Date().toISOString()}] ${level.toUpperCase()}`, ...args);
}

export const logger = {
  error: (...args) => emit("error", console.error, args),
  warn: (...args) => emit("warn", console.warn, args),
  info: (...args) => emit("info", console.log, args),
  debug: (...args) => emit("debug", console.log, args),
};
