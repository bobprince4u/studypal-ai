/**
 * Session use cases.
 *
 * Login in StudyPal is "claim a username": there is no password and no token.
 * That is the pre-refactor behaviour and it is preserved here — introducing
 * authentication is explicitly out of scope for this iteration. It is recorded
 * as A18 in docs/current-architecture.md and as the top item in
 * docs/security-baseline.md, because any client can read any student's history
 * by guessing a name.
 */

import * as sessions from "../repositories/session.repository.js";

/**
 * Create the session if needed and return it.
 *
 * Idempotent: logging in twice returns the original `created_at` rather than
 * resetting it, because the insert ignores conflicts on the unique username.
 *
 * @param {string} username already validated and trimmed
 * @returns {{username: string, created_at: string}}
 */
export function startSession(username) {
  sessions.insertIfAbsent(username, new Date().toISOString());
  const session = sessions.findByUsername(username);
  return { username: session.username, created_at: session.created_at };
}
