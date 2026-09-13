/**
 * The exam generator: prompt in, validated questions out.
 *
 * The one module in this directory that talks to Gemini, and it talks to nothing
 * else — no database, no request, no response. It receives a finished exam
 * request and material context, calls the provider, validates what comes back,
 * and returns it. That boundary is §23's, and it is what lets the service be
 * tested against a fake generator and this be tested against a fake provider.
 *
 * WHAT COMES OUT HAS NO IDS, NO ORDERING AND NO SCORES. The questions are an
 * ordered list and nothing more; the repository assigns question_order from the
 * array position, and nothing is marked until a learner submits an attempt.
 *
 * THE RETRY (§8)
 * --------------
 * Only for output the validator refused — never for a provider error, and never
 * without a bound.
 *
 * The distinction is the whole design, and it is the one SP-V2-005's generator
 * documents. Unusable content is a sampling outcome: the same prompt, sent
 * again, very often produces a well-formed exam, and one extra call is a much
 * better outcome for the learner than an error page after a generation they
 * waited for. A provider FAILURE is not that — a 503, a timeout or an auth
 * rejection will be the same the second time, and retrying turns one outage into
 * two calls per request at exactly the moment the provider is least able to
 * serve them.
 *
 * §8 names the wrong question count specifically, and it is handled here rather
 * than as a special case: the validator refuses a miscount the same way it
 * refuses a malformed option list, so the retry covers it with no extra branch.
 * What §8 forbids — silently accepting it, or trimming to length — is not
 * reachable from here, because this module never sees the individual questions.
 *
 * NOTHING HERE WRITES ANYTHING. An exam is persisted by the repository, after
 * this returns, in one transaction (§13). So a retry cannot double-write and a
 * failure cannot leave a half-generated exam — there is nothing to leave.
 */

import {
  EXAM_RESPONSE_SCHEMA,
  buildExamPrompt,
} from "../ai/prompts/exam.prompt.js";
import { config } from "../config/env.js";
import { generateJsonContent } from "../ai/gemini.client.js";
import { internal } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";
import { validateExamOutput } from "./exam-output.validator.js";

/**
 * Generate an exam's questions.
 *
 * @param {object} input
 * @param {object} input.request the validated request, shaped for the prompt:
 *   {subject, topics, difficulty, questionCount, questionTypes, materials}
 * @param {string} input.materialContext `[Source N]` blocks, or "" for none
 * @param {number} input.sourceCount how many sources `materialContext` contains
 * @returns {Promise<{title: string, questions: Array<object>,
 *   droppedSourceRefs: number}>}
 * @throws {AppError} 500 AI_UNAVAILABLE — the provider failed
 * @throws {AppError} 500 AI_INVALID_OUTPUT — every attempt produced output the
 *   validator refused
 */
export async function generateExam({ request, materialContext, sourceCount }) {
  const prompt = buildExamPrompt({ request, materialContext });

  // Attempts, not retries: one more than the configured retry count, so a
  // configured 0 still makes the single call it was asked for.
  const maxAttempts = config.exam.generationRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw;

    try {
      raw = await generateJsonContent(
        [{ role: "user", parts: [{ text: prompt }] }],
        { responseJsonSchema: EXAM_RESPONSE_SCHEMA },
      );
    } catch (err) {
      // Not retried. See the header — and note what is NOT logged: `prompt`
      // contains retrieved passages of the learner's documents, which must never
      // reach a log. The provider's message may name a model or a quota, so it
      // goes in `cause`, which is logged server-side and never serialised,
      // rather than into the client-facing message (§15).
      logger.error(
        `exam: generation failed on attempt ${attempt}: ${err.message}`,
      );
      throw internal("AI request failed", { cause: err, code: "AI_UNAVAILABLE" });
    }

    const validated = validateExamOutput(raw, {
      questionCount: request.questionCount,
      allowedTypes: new Set(request.questionTypes),
      maxTextChars: config.exam.maxTextChars,
      maxQuestionChars: config.exam.maxQuestionChars,
      sourceCount,
    });

    if (validated !== null) return validated;

    // What happened and which attempt, never the response body. A malformed
    // response can contain anything the model was fed, including document text,
    // so logging it to help debugging would be exactly the leak §15 forbids.
    logger.warn(
      `exam: model output failed validation on attempt ${attempt} of ${maxAttempts}`,
    );
  }

  // §8's "controlled error", and §13's guarantee that nothing was persisted:
  // this throws before any transaction is opened.
  throw internal("AI exam generation failed", { code: "AI_INVALID_OUTPUT" });
}
