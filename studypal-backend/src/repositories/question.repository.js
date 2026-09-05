/**
 * Question / answer persistence.
 *
 * Ported to PostgreSQL in SP-V2-002. The queries mean the same things they did
 * under SQLite — same columns, same ORDER BY, same LIMITs from config — with two
 * changes the schema forced:
 *
 *   • rows are keyed by `user_id`, not by a repeated `username` string
 *   • `answer` is JSONB, so it goes in as an object and comes back as one; the
 *     service no longer JSON.parses on every read
 *
 * Every value is a bind parameter. `username`, `question`, `topic`, `filename`
 * and the model's output are all user- or model-controlled and none of them is
 * ever concatenated into SQL.
 */

import { query } from "../config/database.js";

/**
 * Persist one answered question.
 *
 * NOTE: `question` is stored exactly as the client sent it, untrimmed. That is
 * what the pre-refactor server did and GET /api/history echoes it back, so
 * trimming here would be a visible API change.
 *
 * @param {object} record
 * @param {number} record.userId FK into users.id
 * @param {string} record.question
 * @param {object} record.answer the answer OBJECT, not a JSON string
 * @param {string} record.topic
 * @param {boolean} record.hasFile
 * @param {string|null} record.filename
 * @param {import("pg").PoolClient} [client] run on this client, to join a
 *   transaction the caller already opened
 */
export async function insert(
  { userId, question, answer, topic, hasFile, filename },
  client,
) {
  const sql = `
    INSERT INTO questions (user_id, question, answer, topic, has_file, filename)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6)
  `;
  // JSON.stringify is how a JS object is sent as jsonb — pg has no object
  // encoder. Postgres parses it back into jsonb on receipt, so the column holds
  // an object, NOT a JSON-encoded string. The questions_answer_is_object CHECK
  // constraint fails loudly if that ever stops being true.
  const values = [
    userId,
    question,
    JSON.stringify(answer),
    topic,
    hasFile,
    filename,
  ];

  // `created_at` is left to the column's `DEFAULT now()` rather than being sent
  // from Node: the database's clock is the one consistent source of ordering
  // across processes.
  if (client) await client.query(sql, values);
  else await query(sql, values);
}

/**
 * Most recent questions first.
 *
 * Ordering is `created_at DESC, id DESC`. The tie-break is new: `now()` has
 * microsecond resolution but two inserts inside the same statement-level
 * timestamp would otherwise come back in an arbitrary order, and the contract
 * tests assert a strict newest-first sequence over three rapid inserts. `id` is
 * monotonic, so it settles ties by actual insertion order.
 *
 * Uses idx_questions_user_created.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<{question: string, answer: object, topic: string, has_file: boolean, filename: string|null, created_at: string}>>}
 */
export async function findRecentByUserId(userId, limit) {
  const { rows } = await query(
    `SELECT question, answer, topic, has_file, filename, created_at
       FROM questions
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * @param {number} userId
 * @returns {Promise<number>} a number, not pg's default bigint string — the
 *   INT8 parser in src/config/pg-types.js handles that process-wide
 */
export async function countByUserId(userId) {
  const { rows } = await query(
    "SELECT COUNT(*) AS c FROM questions WHERE user_id = $1",
    [userId],
  );
  return rows[0].c;
}

/**
 * Topic frequency, most asked first.
 *
 * `ORDER BY count DESC, topic ASC` — the alphabetical tie-break is new. Under
 * SQLite equally-frequent topics came back in whatever order the scan produced;
 * naming the second key makes the response deterministic instead of merely
 * stable-in-practice.
 *
 * Uses idx_questions_user_topic.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<{topic: string, count: number}>>}
 */
export async function countTopicsByUserId(userId, limit) {
  const { rows } = await query(
    `SELECT topic, COUNT(*) AS count
       FROM questions
      WHERE user_id = $1
      GROUP BY topic
      ORDER BY count DESC, topic ASC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
