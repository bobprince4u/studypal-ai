/**
 * The AI output validator (§7, §8): what Gemini returned, or nothing at all.
 *
 * The model's response is constrained by EXAM_RESPONSE_SCHEMA, so everything
 * below should already hold — which is exactly why it is checked. §7 is blunt
 * about it: "Do NOT trust Gemini merely because it returned JSON. Use an
 * explicit schema validator." Constrained decoding is a provider enforcing a
 * shape, and a provider is a remote service that can change, degrade, or return
 * an error envelope where an object was expected.
 *
 * This module is the explicit validator. It is hand-written rather than a
 * dependency, per §24 — the checks §7 and §8 enumerate are a fixed list of
 * type, set-membership and cross-field comparisons, and a schema library would
 * be a new package to express them plus a second place to look for the rules.
 *
 * REJECT, CLAMP, OR DROP — AND WHY EACH
 * -------------------------------------
 * Three outcomes, chosen per field rather than by a blanket policy, because the
 * three failures are not the same kind of thing:
 *
 *   REJECT the whole response when something STRUCTURAL is wrong — unparseable
 *   JSON, no questions, the WRONG NUMBER of questions, a type outside the
 *   requested set, an option list of the wrong size, duplicate option ids, a
 *   correctAnswer matching no option, empty question text, empty explanation.
 *   Each means the model did not do the job asked of it, and there is no correct
 *   exam hiding inside the broken one. §8 is explicit that an incomplete exam
 *   must never be persisted, so this is the outcome the generator's retry exists
 *   for.
 *
 *   CLAMP text that is merely too LONG. A 2100-character explanation is a good
 *   explanation with a long tail; discarding an otherwise sound exam over it
 *   would cost the learner a whole second generation to fix a cosmetic problem.
 *   The bounds match the CHECK constraints in
 *   migrations/postgres/005_exams.sql, so nothing that leaves here can fail on
 *   INSERT and roll back an exam that was already paid for.
 *
 *   DROP a source reference the prompt never contained. A sourceNumber of 7 in
 *   an exam shown three sources is a fabricated attribution, and the question
 *   survives without one rather than being discarded — the question itself is
 *   still the model's honest work, it is the *citation* that was invented. Same
 *   treatment src/materials/source-mapper.js gives an out-of-range index.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It never decides whether an ANSWER is correct — it only checks that the model
 * named one of its own options as the key. Marking is src/exams/grader.js, and
 * it happens against the stored answer key, long after this.
 *
 * It also assigns no ids and no ordering: the response has neither (see
 * src/ai/prompts/exam.prompt.js), and question_order comes from array position
 * in the repository.
 */

import { logger } from "../utils/logger.js";

/** The two values exam_questions_type_valid accepts. */
const QUESTION_TYPES = new Set(["multiple_choice", "true_false"]);

/**
 * Options a multiple-choice question must have — §8's "exactly 4 options".
 *
 * Exact rather than a minimum, and the reason is the grade rather than the
 * layout: a three-option question is a 33% guess where a four-option question is
 * 25%, so a paper that mixes them does not have a single meaning for "scored
 * 50%". §8 permits a project convention to justify otherwise; this project has
 * no such convention, so the ticket's number stands.
 */
const MCQ_OPTION_COUNT = 4;

/** The two option ids a true/false question may use, and their display text. */
const BOOLEAN_OPTIONS = new Map([
  ["true", "True"],
  ["false", "False"],
]);

/**
 * The longest an option id may be — exam_questions_correct_answer_bounded, and
 * attempt_answers_selected_bounded, are both 100.
 *
 * Rejected rather than clamped, unlike the prose fields: a clamped id would no
 * longer match the option it came from, which would turn a cosmetic problem into
 * an unanswerable question.
 */
const MAX_OPTION_ID_CHARS = 100;

/**
 * Validate one raw model response.
 *
 * @param {string} raw the trimmed text from gemini.client.js
 * @param {object} options
 * @param {number} options.questionCount the count the learner requested; §8
 *   requires the response to match it exactly
 * @param {Set<string>} options.allowedTypes the question types this request asked
 *   for — a subset of QUESTION_TYPES, never empty
 * @param {number} options.maxTextChars config.exam.maxTextChars, for the title
 * @param {number} options.maxQuestionChars config.exam.maxQuestionChars
 * @param {number} options.sourceCount how many `[Source N]` blocks the prompt
 *   contained; 0 for a topic-only exam
 * @returns {{title: string, questions: Array<object>, droppedSourceRefs: number}
 *   | null} null when the response is unusable, which is the generator's signal
 *   to retry or fail — never to persist
 */
export function validateExamOutput(
  raw,
  { questionCount, allowedTypes, maxTextChars, maxQuestionChars, sourceCount },
) {
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
  if (title === null) return null;

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    // §7's "missing questions". An exam with no questions is not a short exam;
    // it is a response that failed to answer, and persisting it would give the
    // learner a paper with nothing on it and no error.
    return null;
  }

  // §8's count rule, checked BEFORE the per-question loop so a pathological
  // response is refused without validating 50,000 objects first. Not trimmed to
  // the requested count and not accepted as-is: §8 forbids both.
  if (parsed.questions.length !== questionCount) return null;

  const questions = [];
  let droppedSourceRefs = 0;

  for (const entry of parsed.questions) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    // The type must be one this REQUEST asked for, not merely one the schema
    // supports. A true/false paper that comes back with multiple-choice
    // questions is output that does not match what was ordered, and the learner
    // asked for a specific kind of practice.
    if (typeof entry.type !== "string" || !QUESTION_TYPES.has(entry.type)) {
      return null;
    }
    if (!allowedTypes.has(entry.type)) return null;

    const questionText = nonEmptyString(entry.question);
    if (questionText === null) return null;

    // §7's "empty explanation" — rejected, not defaulted. An explanation is the
    // only thing a wrong answer leaves the learner with, and exam_questions
    // stores it NOT NULL precisely so there is no silent placeholder.
    const explanation = nonEmptyString(entry.explanation);
    if (explanation === null) return null;

    const options = validateOptions(entry.options, entry.type);
    if (options === null) return null;

    const correctAnswer = nonEmptyString(entry.correctAnswer);
    if (correctAnswer === null) return null;

    // §8's "correct answer matches an option". The comparison is against the
    // ids this question actually carries, after normalisation, so a true/false
    // answer of "True" matches the "true" option it was normalised to.
    const normalizedAnswer =
      entry.type === "true_false" ? correctAnswer.toLowerCase() : correctAnswer;
    if (!options.some((option) => option.id === normalizedAnswer)) return null;

    questions.push({
      type: entry.type,
      questionText: clampText(questionText, maxQuestionChars),
      options,
      correctAnswer: normalizedAnswer,
      explanation: clampText(explanation, maxQuestionChars),
      // Dropped rather than rejected — see the header.
      sourceNumber: resolveSourceNumber(entry.sourceNumber, sourceCount, () => {
        droppedSourceRefs += 1;
      }),
    });
  }

  if (droppedSourceRefs > 0) {
    // A count, never the invented number alongside the source list. A model that
    // regularly cites sources it was not shown is a prompt problem worth seeing,
    // and the count says so without putting model-generated text in the log —
    // the same discipline mapSources and the plan validator apply.
    logger.warn(
      `exam: dropped ${droppedSourceRefs} source reference(s) that did not match ` +
        `any of the ${sourceCount} sources provided`,
    );
  }

  return { title: clampText(title, maxTextChars), questions, droppedSourceRefs };
}

/**
 * Bound on one option's display text.
 *
 * `options` is JSONB and so has no CHECK constraint of its own, which is the
 * reason this exists: without it a single question could carry a megabyte of
 * model output into a JSONB column, and nothing in the schema would object.
 */
const MAX_OPTION_TEXT_CHARS = 500;

/**
 * Validate and normalise one question's options.
 *
 * @param {unknown} raw the model's `options`
 * @param {"multiple_choice"|"true_false"} type
 * @returns {Array<{id: string, text: string}>|null} null rejects the response
 */
function validateOptions(raw, type) {
  if (!Array.isArray(raw)) return null;

  if (type === "true_false") {
    // §8's "exactly two valid options". Normalised rather than compared
    // verbatim: §7's own example shows `[{id:"true"},{id:"false"}]` with no
    // text at all, so the display strings are the backend's to supply. That is
    // safe because "True" is presentation — it decides nothing. The IDS are
    // what grading compares, and those must be exactly true and false.
    if (raw.length !== BOOLEAN_OPTIONS.size) return null;

    const seen = new Set();
    for (const option of raw) {
      if (option === null || typeof option !== "object") return null;
      const id = nonEmptyString(option.id)?.toLowerCase();
      if (!id || !BOOLEAN_OPTIONS.has(id) || seen.has(id)) return null;
      seen.add(id);
    }

    // Emitted in true-then-false order whatever order the model used, and with
    // the backend's display text: the learner should not see the two reversed on
    // some questions and not others. `seen` having both ids is what was just
    // checked, so this is a reordering of validated input, not a substitution.
    return [...BOOLEAN_OPTIONS].map(([id, text]) => ({ id, text }));
  }

  if (raw.length !== MCQ_OPTION_COUNT) return null;

  const seen = new Set();
  const options = [];

  for (const option of raw) {
    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      return null;
    }

    const id = nonEmptyString(option.id);
    if (id === null || id.length > MAX_OPTION_ID_CHARS) return null;

    // §7's "duplicate option IDs". Two options labelled "B" make the answer key
    // ambiguous — "B" would identify two different answers — so the response is
    // refused rather than de-duplicated down to three options.
    if (seen.has(id)) return null;
    seen.add(id);

    const text = nonEmptyString(option.text);
    if (text === null) return null;

    options.push({ id, text: clampText(text, MAX_OPTION_TEXT_CHARS) });
  }

  return options;
}

/**
 * Turn the model's claimed source number into a 1-based index, or null.
 *
 * Absent is the normal case for a topic-only exam and is not a fault. Present
 * but unusable — not an integer, zero, negative, or past the number of sources
 * the prompt contained — is a fabricated citation, and is dropped.
 *
 * @param {unknown} value the model's `sourceNumber`
 * @param {number} sourceCount how many sources the prompt contained
 * @param {() => void} onDropped called once per dropped reference
 * @returns {number|null} the 1-based source number, or null
 */
function resolveSourceNumber(value, sourceCount, onDropped) {
  if (value === undefined || value === null) return null;

  if (!Number.isInteger(value) || value < 1 || value > sourceCount) {
    onDropped();
    return null;
  }

  return value;
}

/** A trimmed non-empty string, or null for anything else. */
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Shorten `text` to `limit` characters, preferring a word boundary.
 *
 * Identical to the study-plan validator's, and deliberately duplicated rather
 * than shared: extracting it would mean a module imported by two feature folders
 * for one six-line function, and §23's warning about duplicated validation is
 * about the RULES being in two places, which they are not — the bounds live in
 * config and the CHECK constraints.
 *
 * No ellipsis is appended: the result is stored as the exam's own text and read
 * by a learner, not as a preview of something they can expand.
 */
function clampText(text, limit) {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > limit * 0.8 ? cut.slice(0, lastSpace).trimEnd() : cut.trimEnd();
}
