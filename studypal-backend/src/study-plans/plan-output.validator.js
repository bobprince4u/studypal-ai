/**
 * The AI output validator (§19): what Gemini returned, or nothing at all.
 *
 * The model's response is constrained by STUDY_PLAN_RESPONSE_SCHEMA, so
 * everything below should already hold — which is exactly why it is checked.
 * Constrained decoding is a provider enforcing a shape, and a provider is a
 * remote service that can change, degrade, or return an error envelope where an
 * object was expected. §19 is blunt about the consequence of trusting it:
 * "Reject malformed model output. Do not silently persist partial garbage."
 *
 * REJECT, CLAMP, OR DROP — AND WHY EACH
 * -------------------------------------
 * Three outcomes, chosen per field rather than by a blanket policy, because the
 * three failures are not the same kind of thing:
 *
 *   REJECT the whole response when something STRUCTURAL is wrong — unparseable
 *   JSON, no tasks, a task with no title, a task type outside the four allowed,
 *   a duration that is not a positive integer, more tasks than the configured
 *   cap. Each means the model did not do the job asked of it, and there is no
 *   correct plan hiding inside the broken one. This is the outcome §33's single
 *   controlled retry exists for.
 *
 *   CLAMP text that is merely too LONG. A 240-character title is a good title
 *   with a long tail; throwing away an otherwise sound plan over it would cost
 *   the learner a second generation to fix a cosmetic problem. Clamping happens
 *   at a word boundary where one is available, and the bounds match the CHECK
 *   constraints in migrations/postgres/004_study_plans.sql, so nothing that
 *   leaves here can fail on INSERT.
 *
 *   DROP a material reference the prompt never contained. §16 and §36: the model
 *   must not claim a material covers something, and an alias like MATERIAL_7 in
 *   a plan that was shown two materials is exactly that claim. The task survives
 *   with no material rather than being discarded, because the pedagogy in it is
 *   still the model's honest answer — it is the *attribution* that was invented,
 *   and the same treatment mapSources gives a fabricated source index.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * No dates (the response has none — see src/ai/prompts/study-plan.prompt.js), no
 * scheduling, no per-day budget arithmetic, no database ids. Those belong to
 * plan-normalizer.js, which runs after this and can assume every field below is
 * present, typed, bounded and within the allowed sets.
 */

import { logger } from "../utils/logger.js";

/** The four values study_plan_tasks_type_valid accepts. */
const TASK_TYPES = new Set(["study", "review", "practice", "recap"]);

/**
 * Physical ceiling on a single task, in minutes — the same 1440 the
 * study_plan_tasks_duration_bounded CHECK enforces.
 *
 * Anything above it is rejected rather than clamped, and the distinction from
 * the per-plan budget matters: a 90-minute task for a learner with 60 minutes a
 * day is a reasonable suggestion that is simply too big for this schedule, and
 * the normalizer trims it. A 99999-minute task is not a suggestion about
 * anything. The first is arithmetic; the second is a broken response.
 */
const MAX_TASK_MINUTES = 1440;

/**
 * Validate one raw model response.
 *
 * @param {string} raw the trimmed text from gemini.client.js
 * @param {object} options
 * @param {number} options.maxTasks config.plan.maxTasks
 * @param {number} options.maxTextChars config.plan.maxTextChars
 * @param {Set<string>} options.aliases the MATERIAL_n labels the prompt actually
 *   contained; an empty set for a plan with no materials
 * @returns {{title: string, goal: string, tasks: Array<object>,
 *   inventedMaterialRefs: number} | null} null when the response is unusable
 */
export function validatePlanOutput(raw, { maxTasks, maxTextChars, aliases }) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const title = nonEmptyString(parsed.title);
  const goal = nonEmptyString(parsed.goal);
  if (title === null || goal === null) return null;

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    // §19's "empty task list rejected". A plan with no tasks is not a small
    // plan; it is a response that failed to answer, and persisting it would
    // give the learner a schedule page with nothing on it and no error.
    return null;
  }

  // Checked BEFORE the per-task loop so a pathological response is refused
  // without validating 50,000 objects first.
  if (parsed.tasks.length > maxTasks) return null;

  const tasks = [];
  let inventedMaterialRefs = 0;

  for (const entry of parsed.tasks) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    const taskTitle = nonEmptyString(entry.title);
    if (taskTitle === null) return null;

    if (typeof entry.taskType !== "string" || !TASK_TYPES.has(entry.taskType)) {
      return null;
    }

    // `Number.isInteger` and not `parseInt`: "45 minutes" is not a duration the
    // model expressed badly, it is a response that ignored the schema, and
    // coercing it would mean quietly accepting output that no longer matches
    // what was asked for.
    const duration = entry.durationMinutes;
    if (
      !Number.isInteger(duration) ||
      duration <= 0 ||
      duration > MAX_TASK_MINUTES
    ) {
      return null;
    }

    // Optional fields. An absent, blank or wrong-typed description or topic
    // becomes NULL rather than failing the plan: both columns are nullable, and
    // neither carries meaning the schedule depends on.
    const description = optionalText(entry.description, 2000);
    const topic = optionalText(entry.topic, maxTextChars);

    // §20. An alias the prompt never contained is a fabricated attribution, so
    // it is dropped and the task keeps its pedagogy. The alias is NOT resolved
    // to a database id here — that happens in material-brief.js, which owns the
    // mapping; this module only decides whether the label was real.
    let material = null;
    if (typeof entry.material === "string" && entry.material.trim() !== "") {
      const claimed = entry.material.trim();
      if (aliases.has(claimed)) material = claimed;
      else inventedMaterialRefs += 1;
    }

    tasks.push({
      title: clampText(taskTitle, maxTextChars),
      description,
      topic,
      taskType: entry.taskType,
      durationMinutes: duration,
      material,
    });
  }

  if (inventedMaterialRefs > 0) {
    // Logged as a count, never with the invented label itself. A model that
    // regularly cites materials it was not shown is a prompt problem worth
    // seeing, and the count says so without putting model-generated text into
    // the log — the same discipline mapSources applies.
    logger.warn(
      `study plan: dropped ${inventedMaterialRefs} material reference(s) not present in the prompt`,
    );
  }

  return {
    title: clampText(title, maxTextChars),
    goal: clampText(goal, 2000),
    tasks,
    inventedMaterialRefs,
  };
}

/** A trimmed non-empty string, or null for anything else. */
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A trimmed, clamped string, or null when absent, blank or not a string. */
function optionalText(value, limit) {
  const text = nonEmptyString(value);
  return text === null ? null : clampText(text, limit);
}

/**
 * Shorten `text` to `limit` characters, preferring a word boundary.
 *
 * The boundary search only looks at the last 20% of the allowance, so a string
 * whose final space is near the beginning is cut hard rather than reduced to a
 * fragment — the fallback matters more than it looks, because a long
 * space-free string is exactly what an adversarial or malfunctioning response
 * produces.
 *
 * No ellipsis is appended. The result is stored as the plan's own text and read
 * by a learner, not as a preview of something they can expand.
 */
function clampText(text, limit) {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > limit * 0.8 ? cut.slice(0, lastSpace).trimEnd() : cut.trimEnd();
}
