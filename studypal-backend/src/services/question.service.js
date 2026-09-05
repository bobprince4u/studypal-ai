/**
 * Question use cases: ask, history, progress.
 *
 * This is where the /api/ask flow is coordinated — attachment → model → store →
 * respond. It owns the ordering guarantee that matters most: nothing is written
 * to the database unless the model actually answered, which is why a failed
 * generation leaves no orphan row.
 */

import * as questions from "../repositories/question.repository.js";
import * as users from "../repositories/user.repository.js";
import { config } from "../config/env.js";
import { withTransaction } from "../config/database.js";
import { answerStudyQuestion } from "./ai.service.js";
import { buildAttachmentParts } from "./upload.service.js";

/**
 * Answer a study question and record it.
 *
 * The user row is created on demand. /api/ask has never required a prior
 * /api/session call and still does not; under the old schema `questions` simply
 * carried a username string, and with a foreign key the user has to exist first.
 *
 * The username is used VERBATIM, untrimmed — see src/middleware/validation.js.
 * `/api/session` trims, `/api/ask` does not, so "ann" and "ann " are two
 * different users. That asymmetry predates this iteration and the history
 * responses depend on it; it is recorded as debt rather than changed here.
 *
 * @param {object} input
 * @param {string} input.username stored verbatim
 * @param {string} input.question stored verbatim
 * @param {{originalname: string, buffer: Buffer}} [input.file]
 * @returns {Promise<object>} the answer object, returned to the client as-is
 */
export async function askQuestion({ username, question, file }) {
  const attachmentParts = file ? await buildAttachmentParts(file) : [];

  // Before any write: a failed generation must leave the database untouched,
  // including leaving no empty user behind.
  const answer = await answerStudyQuestion({ question, attachmentParts });

  // One of the few places a transaction is warranted. The upsert and the insert
  // are two statements that must both land or neither: a committed user with no
  // question is harmless but wrong, and a question needs its user's id to exist.
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (username)
            VALUES ($1)
       ON CONFLICT (username)
       DO UPDATE SET username = EXCLUDED.username
         RETURNING id`,
      [username],
    );

    await questions.insert(
      {
        userId: rows[0].id,
        question,
        answer,
        // The prompt forbids "General", but a malformed response may omit
        // `topic` entirely; the column default is the same string.
        topic: answer.topic || "Study Topic",
        hasFile: Boolean(file),
        filename: file ? file.originalname : null,
      },
      client,
    );
  });

  return answer;
}

/**
 * Recent questions for a student, newest first.
 *
 * An unknown username yields an empty array rather than an error, and does not
 * create the user — reading a URL must not write a row.
 *
 * @param {string} username
 * @returns {Promise<Array<object>>} always an array; the frontend maps over it
 *   unguarded
 */
export async function getHistory(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) return [];

  const rows = await questions.findRecentByUserId(
    userId,
    config.limits.historyItems,
  );

  return rows.map((row) => ({
    question: row.question,
    // JSONB: already an object. The old code JSON.parsed a TEXT column here and
    // needed a try/catch for rows that were not valid JSON — a state the
    // questions_answer_is_object CHECK constraint now makes unrepresentable.
    answer: row.answer,
    topic: row.topic,
    has_file: row.has_file,
    filename: row.filename,
    created_at: row.created_at,
  }));
}

/**
 * Question count and top topics for a student.
 *
 * An unknown username is not an error: it yields zero and an empty list. The
 * frontend reads `progress.topics.length` without a guard, so `topics` must
 * always be an array.
 *
 * @param {string} username
 * @returns {Promise<{total_questions: number, topics: Array<{topic: string, count: number}>}>}
 */
export async function getProgress(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) return { total_questions: 0, topics: [] };

  // Two independent reads on the same user; issued together rather than in
  // sequence so the endpoint costs one round trip's latency, not two.
  const [total_questions, topics] = await Promise.all([
    questions.countByUserId(userId),
    questions.countTopicsByUserId(userId, config.limits.progressTopics),
  ]);

  return { total_questions, topics };
}
