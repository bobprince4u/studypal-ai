/**
 * AI orchestration: prompt assembly, provider call, response parsing.
 *
 * Sits between the question service and the Gemini client. Controllers never
 * reach past this module, and this module never touches HTTP or the database.
 *
 * The three-tier parse below is copied from server.js:120-135 and must keep
 * behaving identically — the frontend renders whatever object comes out of it
 * and has no error branch on /api/ask, so "never throw a parse error at the
 * client" is a hard requirement, not a nicety.
 */

import { generateJsonContent } from "../ai/gemini.client.js";
import { buildStudyQuestionText } from "../ai/prompts/study-question.prompt.js";
import { internal } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";

/** Shape returned when the model's output cannot be parsed as JSON at all. */
function fallbackAnswer(raw) {
  return {
    explanation: raw,
    topic: "Study Topic",
    practice_questions: [],
    encouragement: "Keep going!",
  };
}

/**
 * Best-effort JSON extraction from model output.
 *
 * Tier 1: the response is already JSON (the normal case, since the request asks
 *         for `application/json`).
 * Tier 2: it is JSON wrapped in a ```json fence — strip the fences and retry.
 * Tier 3: it is prose. Surface it as `explanation` so the student still gets an
 *         answer rather than an error.
 *
 * @param {string} raw
 * @returns {object}
 */
export function parseAnswer(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
    try {
      return JSON.parse(clean);
    } catch {
      logger.warn("model output was not JSON; returning it as explanation");
      return fallbackAnswer(raw);
    }
  }
}

/**
 * Ask the model a study question, optionally with an attachment.
 *
 * @param {object} input
 * @param {string} input.question raw student question
 * @param {Array<object>} [input.attachmentParts] extra @google/genai parts
 * @returns {Promise<object>} parsed answer object
 * @throws {AppError} 500 with a client-safe message if the provider fails
 */
export async function answerStudyQuestion({ question, attachmentParts = [] }) {
  const contents = [
    {
      role: "user",
      parts: [{ text: buildStudyQuestionText(question) }, ...attachmentParts],
    },
  ];

  let raw;
  try {
    raw = await generateJsonContent(contents);
  } catch (err) {
    // The provider's message can carry request URLs, key fragments and quota
    // detail, so it is logged and deliberately not forwarded to the client.
    throw internal("AI request failed", { cause: err, code: "AI_UNAVAILABLE" });
  }

  return parseAnswer(raw);
}
