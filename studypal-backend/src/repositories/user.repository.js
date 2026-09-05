/**
 * User persistence.
 *
 * The only place that knows how users are stored. Renamed from
 * session.repository.js in SP-V2-002 along with the table: `sessions` held no
 * session state, only one immutable row per username, so it was a user registry
 * misnamed.
 *
 * Every value is a bind parameter — `$1`, `$2` — never string-interpolated.
 * `username` is user-controlled input and arrives here unsanitised by design.
 *
 * No prepared-statement cache. better-sqlite3 needed one because preparing was
 * an explicit, connection-bound step; pg parses per query on a pooled connection
 * and the cache would only add a way to hold stale handles after a reconnect.
 */

import { query } from "../config/database.js";

/**
 * Create the user if absent, and return the row either way.
 *
 * ON CONFLICT DO NOTHING would return no row when the user already exists,
 * forcing a second SELECT. `DO UPDATE SET username = EXCLUDED.username` — a
 * no-op write — makes the row come back from a single statement instead.
 *
 * `created_at` therefore always reflects the FIRST login: the update touches
 * nothing else, which is what makes POST /api/session idempotent.
 *
 * @param {string} username stored exactly as given
 * @returns {Promise<{id: number, username: string, created_at: string}>}
 */
export async function upsert(username) {
  const { rows } = await query(
    `INSERT INTO users (username)
          VALUES ($1)
     ON CONFLICT (username)
     DO UPDATE SET username = EXCLUDED.username
       RETURNING id, username, created_at`,
    [username],
  );
  return rows[0];
}

/**
 * @param {string} username
 * @returns {Promise<{id: number, username: string, created_at: string} | undefined>}
 */
export async function findByUsername(username) {
  const { rows } = await query(
    "SELECT id, username, created_at FROM users WHERE username = $1",
    [username],
  );
  return rows[0];
}

/**
 * The user's id, or undefined if there is no such user.
 *
 * Read-only lookup for GET /api/history and GET /api/progress, which must not
 * create a user as a side effect of someone reading a URL.
 *
 * @param {string} username
 * @returns {Promise<number | undefined>}
 */
export async function findIdByUsername(username) {
  const { rows } = await query("SELECT id FROM users WHERE username = $1", [
    username,
  ]);
  return rows[0]?.id;
}
