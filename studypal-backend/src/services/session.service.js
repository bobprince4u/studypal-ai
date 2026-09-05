/**
 * Session use cases.
 *
 * Login in StudyPal is "claim a username": there is no password and no token.
 * That is the pre-refactor behaviour and it is preserved here — introducing
 * authentication is explicitly out of scope for this iteration. It is recorded
 * as A18 in docs/current-architecture.md and as the top item in
 * docs/security-baseline.md, because any client can read any student's history
 * by guessing a name.
 *
 * SP-V2-002 moved the storage from a `sessions` table to `users`, which is where
 * authentication will eventually attach. The response is unchanged.
 */

import * as users from "../repositories/user.repository.js";

/**
 * Create the user if needed and return the session view of them.
 *
 * Idempotent: logging in twice returns the original `created_at` rather than
 * resetting it, because the upsert leaves an existing row's timestamps alone.
 *
 * Returns only `username` and `created_at`. `users.id` is deliberately not
 * exposed: the frontend never reads it, and the response key set is asserted
 * exactly by the contract tests.
 *
 * @param {string} username already validated and trimmed
 * @returns {Promise<{username: string, created_at: string}>}
 */
export async function startSession(username) {
  const user = await users.upsert(username);
  return { username: user.username, created_at: user.created_at };
}
