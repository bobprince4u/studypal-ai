/**
 * Question use cases: ask, history, progress.
 *
 * This is where the /api/ask flow is coordinated — attachment → model → store →
 * respond. It owns the ordering guarantee that matters most: nothing is written
 * to the database unless the model actually answered, which is why a failed
 * generation leaves no orphan row.
 */

import * as questions from "../repositories/question.repository.js";
import { config } from "../config/env.js";
import { answerStudyQuestion } from "./ai.service.js";
import { buildAttachmentParts } from "./upload.service.js";

/**
 * Answer a study question and record it.
 *
 * @param {object} input
 * @param {string} input.username stored verbatim
 * @param {string} input.question stored verbatim
 * @param {{originalname: string, buffer: Buffer}} [input.file]
 * @returns {Promise<object>} the answer object, returned to the client as-is
 */
export async function askQuestion({ username, question, file }) {
  const attachmentParts = file ? await buildAttachmentParts(file) : [];

  const answer = await answerStudyQuestion({ question, attachmentParts });

  questions.insert({
    username,
    question,
    answer: JSON.stringify(answer),
    // The prompt forbids "General", but a malformed response may omit `topic`
    // entirely; the column default is the same string.
    topic: answer.topic || "Study Topic",
    hasFile: Boolean(file),
    filename: file ? file.originalname : null,
    createdAt: new Date().toISOString(),
  });

  return answer;
}

/**
 * Recent questions for a student, newest first.
 *
 * Answers are stored as JSON text. Rows written before that convention — or
 * corrupted by hand — are wrapped as `{explanation: <raw text>}` so the client
 * always receives the same shape and never has to parse anything itself.
 *
 * @param {string} username
 * @returns {Array<object>} always an array; the frontend maps over it unguarded
 */
export function getHistory(username) {
  return questions
    .findRecentByUsername(username, config.limits.historyItems)
    .map((row) => ({
      question: row.question,
      answer: parseStoredAnswer(row.answer),
      topic: row.topic,
      has_file: Boolean(row.has_file),
      filename: row.filename,
      created_at: row.created_at,
    }));
}

function parseStoredAnswer(stored) {
  try {
    return JSON.parse(stored);
  } catch {
    return { explanation: stored };
  }
}

/**
 * Question count and top topics for a student.
 *
 * An unknown username is not an error: it yields zero and an empty list. The
 * frontend reads `progress.topics.length` without a guard, so `topics` must
 * always be an array.
 *
 * @param {string} username
 * @returns {{total_questions: number, topics: Array<{topic: string, count: number}>}}
 */
export function getProgress(username) {
  return {
    total_questions: questions.countByUsername(username),
    topics: questions.countTopicsByUsername(
      username,
      config.limits.progressTopics,
    ),
  };
}
