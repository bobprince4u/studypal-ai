/**
 * The study-plan generator: prompt in, validated plan content out.
 *
 * The one module in this directory that talks to Gemini, and it talks to nothing
 * else — no database, no request, no response. It receives a finished learner
 * brief, calls the provider, validates what comes back, and returns it. That
 * boundary is §4's, and it is what lets the service be tested against a fake
 * generator and this be tested against a fake provider.
 *
 * WHAT COMES OUT HAS NO DATES AND NO IDS. The tasks are ordered and nothing
 * more; plan-normalizer.js turns them into a schedule.
 *
 * THE ONE RETRY (§33)
 * -------------------
 * Exactly one, and only for output the validator refused — not for a provider
 * error, and never twice.
 *
 * The distinction is the whole design. A malformed response is a sampling
 * outcome: the same prompt, sent again, very often produces a well-formed plan,
 * and one extra call is a much better outcome for the learner than an error page
 * after a generation they waited for. A provider FAILURE is not that — a 503, a
 * timeout or an auth rejection will be a 503, a timeout or an auth rejection the
 * second time as well, and retrying turns one outage into two calls per request
 * at exactly the moment the provider is least able to serve them. §33 also
 * requires no infinite loop and no double-write: the loop below is a `for` over
 * two attempts with no recursion, and nothing here writes anything at all.
 */

import {
  STUDY_PLAN_RESPONSE_SCHEMA,
  buildStudyPlanPrompt,
} from "../ai/prompts/study-plan.prompt.js";
import { config } from "../config/env.js";
import { generateJsonContent } from "../ai/gemini.client.js";
import { internal } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";
import { validatePlanOutput } from "./plan-output.validator.js";

/** One retry, per §33. Two attempts total. */
const MAX_ATTEMPTS = 2;

/**
 * Generate a plan's content.
 *
 * @param {object} input
 * @param {object} input.learner validated goals, shaped for the prompt
 * @param {string} input.materialContext `[Source N]` blocks, or "" for none
 * @param {Set<string>} input.aliases the MATERIAL_n labels the prompt contains
 * @returns {Promise<{title: string, goal: string, tasks: Array<object>,
 *   inventedMaterialRefs: number}>}
 * @throws {AppError} 500 AI_UNAVAILABLE — the provider failed, or both attempts
 *   produced output the validator refused
 */
export async function generateStudyPlan({ learner, materialContext, aliases }) {
  const prompt = buildStudyPlanPrompt({ learner, materialContext });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let raw;

    try {
      raw = await generateJsonContent(
        [{ role: "user", parts: [{ text: prompt }] }],
        { responseJsonSchema: STUDY_PLAN_RESPONSE_SCHEMA },
      );
    } catch (err) {
      // Not retried. See the header — and note what is NOT logged: `prompt`
      // contains retrieved passages of the learner's documents, which §32
      // forbids putting in a log. The message is the provider's and may name a
      // model or a quota, so it goes in `cause`, which is logged here and never
      // serialised, rather than into the client-facing message.
      logger.error(
        `study plan: generation failed on attempt ${attempt}: ${err.message}`,
      );
      throw internal("AI request failed", { cause: err, code: "AI_UNAVAILABLE" });
    }

    const validated = validatePlanOutput(raw, {
      maxTasks: config.plan.maxTasks,
      maxTextChars: config.plan.maxTextChars,
      aliases,
    });

    if (validated !== null) return validated;

    // §33's "log safely": what happened and which attempt, never the response
    // body. A malformed response can contain anything the model was fed,
    // including document text, so logging it to help debugging would be the
    // leak §32 is about.
    logger.warn(
      `study plan: model output failed validation on attempt ${attempt} of ${MAX_ATTEMPTS}`,
    );
  }

  throw internal("AI study plan generation failed", {
    code: "AI_INVALID_OUTPUT",
  });
}
