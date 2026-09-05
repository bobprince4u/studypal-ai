/**
 * Question / answer persistence.
 *
 * SQL is lifted verbatim from server.js:137-147, 158-162 and 184-191 — same
 * columns, same ORDER BY, same LIMITs (now sourced from config so they are
 * visible and tunable, with defaults equal to the previous hardcoded 30 and 6).
 *
 * Every statement is parameterised; no value is ever concatenated into SQL.
 */

import { getDatabase } from "../config/database.js";

const cache = new Map();

function stmt(sql) {
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = getDatabase().prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

/**
 * Persist one answered question.
 *
 * NOTE: `username` and `question` are stored exactly as the client sent them,
 * untrimmed. That is what the pre-refactor server did, and history responses
 * echo these values back, so trimming here would be a visible API change.
 *
 * @param {object} record
 * @param {string} record.username
 * @param {string} record.question
 * @param {string} record.answer serialised answer JSON
 * @param {string} record.topic
 * @param {boolean} record.hasFile
 * @param {string|null} record.filename
 * @param {string} record.createdAt ISO-8601 timestamp
 */
export function insert({
  username,
  question,
  answer,
  topic,
  hasFile,
  filename,
  createdAt,
}) {
  stmt(
    `INSERT INTO questions (username, question, answer, topic, has_file, filename, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    username,
    question,
    answer,
    topic,
    hasFile ? 1 : 0,
    filename,
    createdAt,
  );
}

/**
 * Most recent questions first.
 * @param {string} username
 * @param {number} limit
 * @returns {Array<{question: string, answer: string, topic: string, has_file: number, filename: string|null, created_at: string}>}
 */
export function findRecentByUsername(username, limit) {
  return stmt(
    `SELECT question, answer, topic, has_file, filename, created_at FROM questions WHERE username = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(username, limit);
}

/**
 * @param {string} username
 * @returns {number}
 */
export function countByUsername(username) {
  return stmt("SELECT COUNT(*) as c FROM questions WHERE username = ?").get(
    username,
  ).c;
}

/**
 * Topic frequency, most asked first.
 * @param {string} username
 * @param {number} limit
 * @returns {Array<{topic: string, count: number}>}
 */
export function countTopicsByUsername(username, limit) {
  return stmt(
    `SELECT topic, COUNT(*) as count FROM questions WHERE username = ? GROUP BY topic ORDER BY count DESC LIMIT ?`,
  ).all(username, limit);
}

/** Drop cached statements — required after the connection is closed. */
export function resetStatementCache() {
  cache.clear();
}
