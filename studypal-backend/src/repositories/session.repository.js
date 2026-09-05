/**
 * Session persistence.
 *
 * The only place that knows how sessions are stored. SQL is lifted verbatim
 * from server.js:45-50 — same statements, same parameter binding, so results
 * are byte-identical to the pre-refactor server.
 *
 * Statements are prepared lazily and cached: better-sqlite3 requires an open
 * database to prepare against, and the connection is opened on first use.
 */

import { getDatabase } from "../config/database.js";

const cache = new Map();

/** Prepare once per process, then reuse. */
function stmt(sql) {
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = getDatabase().prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

/**
 * Create the session if it does not exist. Existing rows are left untouched,
 * so `created_at` reflects the FIRST login — the pre-refactor behaviour.
 * @param {string} username already trimmed by the caller
 * @param {string} createdAt ISO-8601 timestamp
 */
export function insertIfAbsent(username, createdAt) {
  stmt(
    "INSERT OR IGNORE INTO sessions (username, created_at) VALUES (?, ?)",
  ).run(username, createdAt);
}

/**
 * @param {string} username
 * @returns {{id: number, username: string, created_at: string} | undefined}
 */
export function findByUsername(username) {
  return stmt("SELECT * FROM sessions WHERE username = ?").get(username);
}

/** Drop cached statements — required after the connection is closed. */
export function resetStatementCache() {
  cache.clear();
}
