// SP-V2-008: existing authenticated users only; no implicit account creation.
/**
 * Question use cases: ask, history, progress.
 *
 * This is where the /api/ask flow is coordinated — attachment → model → store →
 * respond. It owns the ordering guarantee that matters most: nothing is written
 * to the database unless the model actually answered, which is why a failed
 * generation leaves no orphan row.
 */

import * as questions from "../repositories/question.repository.js";
import { assertUserId } from "../auth/identity.js";
import { config } from "../config/env.js";
import { answerStudyQuestion } from "./ai.service.js";
import { buildAttachmentParts } from "./upload.service.js";

/** Answer for an authenticated user; persist only after successful generation. */
export async function askQuestion({ userId, question, file }) {
  assertUserId(userId);
  const attachmentParts = file ? await buildAttachmentParts(file) : [];

  // Before any write: a failed generation must leave the database untouched,
  // including leaving no empty user behind.
  const answer = await answerStudyQuestion({ question, attachmentParts });

  await questions.insert({
    userId,
    question,
    answer,
    topic: answer.topic || "Study Topic",
    hasFile: Boolean(file),
    filename: file ? file.originalname : null,
  });

  return answer;
}

/**
 * Recent questions for a student, newest first.
 *
 * An authenticated learner without questions receives an empty array.
 * Reading history never creates a user.
 *
 * @param {number} userId trusted immutable identity
 * @returns {Promise<Array<object>>} always an array; the frontend maps over it
 *   unguarded
 */
export async function getHistory(userId) {
  assertUserId(userId);

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
 * A learner without evidence receives zero and an empty list. The
 * frontend reads `progress.topics.length` without a guard, so `topics` must
 * always be an array.
 *
 * @param {number} userId trusted immutable identity
 * @returns {Promise<{total_questions: number, topics: Array<{topic: string, count: number}>}>}
 */
export async function getProgress(userId) {
  assertUserId(userId);

  // Two independent reads on the same user; issued together rather than in
  // sequence so the endpoint costs one round trip's latency, not two.
  const [total_questions, topics] = await Promise.all([
    questions.countByUserId(userId),
    questions.countTopicsByUserId(userId, config.limits.progressTopics),
  ]);

  return { total_questions, topics };
}
