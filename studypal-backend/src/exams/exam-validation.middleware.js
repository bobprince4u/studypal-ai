/**
 * Request validation for /api/exams and /api/exam-attempts.
 *
 * Hand-written, like the material and study-plan validators, and here for the
 * same reason: this feature's accepted inputs are part of its boundary, and
 * keeping them beside it means the 400 messages can be worded freely without
 * touching the file where the older endpoints' frozen strings live.
 *
 * The two rules from those validators hold here too:
 *
 *   • Validated values are written to `req.validated`, and handlers read only
 *     that. A controller never re-parses an id, re-trims a username, or decides
 *     what an absent `topics` means.
 *   • No rejection echoes the offending value. `?username=<script>` produces
 *     "Username is required." and nothing more.
 *
 * WHAT THIS FILE REFUSES TO ACCEPT AT ALL (§5)
 * --------------------------------------------
 * There is no reader below for `score`, `percentage`, `correctAnswers`,
 * `isCorrect`, `passed` or `correctAnswer`. §5 lists them as values a client
 * must never be trusted with, and the implementation of that is not a filter
 * that strips them — it is that nothing in this file looks for them, so they
 * cannot reach `req.validated`, and the service reads only `req.validated`. A
 * request body carrying `"score": 100` is accepted and the field is ignored,
 * exactly as a body carrying `"colour": "blue"` would be.
 *
 * The submit body is the sharp end of that: §5 specifies the client sends
 * `{"questionId": 123, "answer": "B"}`, and readAnswers reads those two fields
 * and no others.
 *
 * BOUNDS COME FROM CONFIG, WHICH IS CHECKED AGAINST THE DATABASE
 * --------------------------------------------------------------
 * Every limit below is a `config.exam.*` value rather than a literal. Those
 * values are bounded at startup against the CHECK constraints in
 * migrations/postgres/005_exams.sql (see configWarnings in src/config/env.js),
 * so validation cannot be configured looser than the database and produce a 500
 * where a 400 was owed.
 */

import { badRequest } from "../utils/app-error.js";
import { config } from "../config/env.js";

/** The three values exams_difficulty_valid accepts. */
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

/** The two values exam_questions_type_valid accepts (§2). */
const QUESTION_TYPES = new Set(["multiple_choice", "true_false"]);

/** Both types, for a request that does not narrow them. */
const DEFAULT_QUESTION_TYPES = ["multiple_choice", "true_false"];

/** attempt_answers_selected_bounded, and exam_questions_correct_answer_bounded. */
const MAX_ANSWER_CHARS = 100;

/**
 * Validate the JSON body of POST /api/exams (§6).
 *
 * Field order is the order that produces the most useful first message:
 * identity, then what is being tested, then how, then the optional scoping. A
 * request with several problems is told about the first one rather than being
 * handed a list, matching every other validator in the service.
 */
export function validateCreateExamBody(req, _res, next) {
  // `?? {}` for the reason the material validators do it: with no body at all,
  // `req.body` is undefined and destructuring would turn a plain 400 into a 500.
  const body = req.body ?? {};

  const username = readUsername(body.username);
  if (username === null) return next(badRequest("Username is required."));
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  const subject = readSubject(body.subject);
  if (subject instanceof Error) return next(subject);

  const topics = readTopics(body.topics);
  if (topics instanceof Error) return next(topics);

  const difficulty = readDifficulty(body.difficulty);
  if (difficulty instanceof Error) return next(difficulty);

  const questionCount = readQuestionCount(body.questionCount);
  if (questionCount instanceof Error) return next(questionCount);

  const questionTypes = readQuestionTypes(body.questionTypes);
  if (questionTypes instanceof Error) return next(questionTypes);

  const materialIds = readMaterialIds(body.materialIds);
  if (materialIds instanceof Error) return next(materialIds);

  req.validated = {
    ...req.validated,
    username,
    subject,
    topics,
    difficulty,
    questionCount,
    questionTypes,
    materialIds,
  };
  next();
}

/** Require a `username` query parameter — GET one exam, GET the history. */
export function validateUsernameQuery(req, _res, next) {
  const username = readUsername(req.query?.username);
  if (username === null) return next(badRequest("Username is required."));
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  req.validated = { ...req.validated, username };
  next();
}

/**
 * Require a `username` in the JSON body — starting and submitting an attempt.
 *
 * Both are writes with a body already, so the username travels in it rather
 * than in the query string, matching the study-plan writes.
 */
export function validateUsernameBody(req, _res, next) {
  const username = readUsername((req.body ?? {}).username);
  if (username === null) return next(badRequest("Username is required."));
  if (username.length > config.limits.usernameLength) {
    return next(
      badRequest(
        `Username must be ${config.limits.usernameLength} characters or fewer.`,
      ),
    );
  }

  req.validated = { ...req.validated, username };
  next();
}

/** Parse and bound `:id` — the exam id. */
export function validateExamId(req, _res, next) {
  const examId = readId(req.params.id);
  if (examId === null) {
    return next(badRequest("Exam id must be a positive integer."));
  }

  req.validated = { ...req.validated, examId };
  next();
}

/**
 * Parse and bound `:id` and `:attemptId` — the two ids on submit and on reading
 * a result.
 *
 * Both in one middleware because the routes have both and neither is useful
 * alone. The messages name which id was wrong, since the caller supplied two and
 * a single "id must be a positive integer" would not say which to fix.
 */
export function validateAttemptParams(req, _res, next) {
  const examId = readId(req.params.id);
  if (examId === null) {
    return next(badRequest("Exam id must be a positive integer."));
  }

  const attemptId = readId(req.params.attemptId);
  if (attemptId === null) {
    return next(badRequest("Attempt id must be a positive integer."));
  }

  req.validated = { ...req.validated, examId, attemptId };
  next();
}

/**
 * Validate the answers array on submit (§5, §9).
 *
 * SHAPE ONLY. Whether a question id belongs to this exam, and whether an answer
 * is one of that question's options, are checked in the service against the
 * exam's own rows — this layer has no database and cannot know either. §9 lists
 * them as separate steps for exactly that reason.
 *
 * An EMPTY array is accepted. A learner who starts an exam and submits without
 * answering has sat it and scored zero; refusing the submission would leave the
 * attempt in_progress forever, and §11's lifecycle has no third state for it.
 */
export function validateSubmitBody(req, _res, next) {
  const answers = readAnswers((req.body ?? {}).answers);
  if (answers instanceof Error) return next(answers);

  req.validated = { ...req.validated, answers };
  next();
}

/** A trimmed non-empty username, or null. */
function readUsername(raw) {
  if (typeof raw !== "string") return null;
  const username = raw.trim();
  return username ? username : null;
}

/**
 * A positive integer id from a path segment, or null.
 *
 * Identical reasoning to the study-plan validator's: `Number()` would accept
 * "1e3", " 12 ", "0x10" and "Infinity", and `parseInt` would accept "12abc". A
 * digits-only pattern accepts exactly what an id looks like, the length bound
 * stops a thousand-digit string being parsed, and the safe-integer check refuses
 * a value that fits BIGINT but not a JavaScript number.
 *
 * Rejecting here rather than in SQL is also what keeps "abc" a 400: passing it
 * to a bigint parameter makes PostgreSQL raise `invalid input syntax for type
 * bigint`, and a 500 carrying a database error is what §15 forbids.
 */
function readId(raw) {
  if (!/^\d{1,19}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

/**
 * The subject (§2). Required — it is the one field an exam cannot be generated
 * without, since topics and materials are both optional.
 *
 * @returns {string | Error}
 */
function readSubject(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return badRequest("Subject is required.");
  }
  const subject = raw.trim();
  if (subject.length > config.exam.maxTextChars) {
    return badRequest(
      `Subject must be ${config.exam.maxTextChars} characters or fewer.`,
    );
  }
  return subject;
}

/**
 * The topics array (§2).
 *
 * OPTIONAL, and absent means an empty array rather than an error: "test me on
 * Organic Chemistry" is a complete request, and §2 asks for generation from a
 * subject with topics optional.
 *
 * Each entry is trimmed and blanks are dropped, so `["Kinetics", "", "  "]` is
 * one topic rather than a validation error — trailing empty inputs are a form
 * artefact, not a malformed request. A non-array, or an entry that is not a
 * string, IS an error: those indicate a client sending something other than what
 * the endpoint documents.
 *
 * @returns {Array<string> | Error}
 */
function readTopics(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("Topics must be an array.");

  const topics = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return badRequest("Each topic must be a string.");
    }
    const topic = entry.trim();
    if (topic === "") continue;
    if (topic.length > config.exam.maxTextChars) {
      return badRequest(
        `Each topic must be ${config.exam.maxTextChars} characters or fewer.`,
      );
    }
    topics.push(topic);
  }

  // Checked after filtering, against the configured cap rather than the
  // database's 100 — the cap exists because every topic goes into the prompt,
  // and an exam scoped to 100 topics is not a focused exam.
  if (topics.length > config.exam.maxTopics) {
    return badRequest(
      `An exam may cover at most ${config.exam.maxTopics} topics.`,
    );
  }

  return topics;
}

/**
 * The difficulty (§2). Optional, defaulting to medium — the middle of the three,
 * and the right answer for a learner who has not expressed a preference.
 *
 * @returns {string | Error}
 */
function readDifficulty(raw) {
  if (raw === undefined || raw === null) return "medium";
  if (typeof raw !== "string" || !DIFFICULTIES.has(raw)) {
    return badRequest("Difficulty must be one of: easy, medium, hard.");
  }
  return raw;
}

/**
 * The question count (§2).
 *
 * Three distinct rejections rather than one, because they are three different
 * mistakes: a non-integer is a client sending the wrong type, a zero or negative
 * is a nonsensical request, and a number past the ceiling is a request that
 * would take minutes to generate and cost accordingly. The ceiling is
 * config.exam.maxQuestions, which is checked at startup against
 * exams_question_count_bounded.
 *
 * @returns {number | Error}
 */
function readQuestionCount(raw) {
  if (raw === undefined || raw === null) {
    return config.exam.defaultQuestionCount;
  }
  if (!Number.isInteger(raw)) {
    return badRequest("Question count must be an integer.");
  }
  if (raw < config.exam.minQuestions) {
    return badRequest(
      `An exam must have at least ${config.exam.minQuestions} question(s).`,
    );
  }
  if (raw > config.exam.maxQuestions) {
    return badRequest(
      `An exam may have at most ${config.exam.maxQuestions} questions.`,
    );
  }
  return raw;
}

/**
 * The question types (§2).
 *
 * Absent means both, which is what a learner who did not choose almost always
 * wants — a paper of nothing but true/false is a weaker test than a mixed one.
 *
 * De-duplicated so `["true_false", "true_false"]` is one type rather than a
 * rejection: a repeated value expresses the same intent as a single one, and the
 * request is unambiguous. An UNKNOWN type is rejected, including "essay" and
 * "short_answer" — §2 rules both out of scope, and silently dropping them would
 * hand back an exam of a kind the learner did not ask for.
 *
 * @returns {Array<string> | Error}
 */
function readQuestionTypes(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_QUESTION_TYPES];
  if (!Array.isArray(raw)) {
    return badRequest("Question types must be an array.");
  }

  const types = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string" || !QUESTION_TYPES.has(entry)) {
      return badRequest(
        "Question types must be one of: multiple_choice, true_false.",
      );
    }
    types.add(entry);
  }

  if (types.size === 0) {
    return badRequest("At least one question type is required.");
  }

  // Emitted in the canonical order rather than the caller's, so the prompt text
  // is identical for ["true_false","multiple_choice"] and the reverse.
  return DEFAULT_QUESTION_TYPES.filter((type) => types.has(type));
}

/**
 * The material ids (§6).
 *
 * OPTIONAL — §2 and §6 both make a topic-only exam a first-class case. Ids are
 * checked for SHAPE here and for OWNERSHIP in the service, against the database,
 * which is the only place ownership can be known.
 *
 * De-duplicated, preserving first-seen order: naming the same document twice is
 * not an error, and retrieving it twice would give it double weight in the
 * context budget.
 *
 * @returns {Array<number> | Error}
 */
function readMaterialIds(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("Material ids must be an array.");

  const ids = [];
  const seen = new Set();

  for (const entry of raw) {
    if (!Number.isSafeInteger(entry) || entry < 1) {
      return badRequest("Each material id must be a positive integer.");
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    ids.push(entry);
  }

  if (ids.length > config.exam.maxMaterials) {
    return badRequest(
      `An exam may use at most ${config.exam.maxMaterials} materials.`,
    );
  }

  return ids;
}

/**
 * The submitted answers (§5, §9).
 *
 * §5 specifies the client sends `{"questionId": 123, "answer": "B"}`, and this
 * reads those two fields and nothing else. An entry carrying `isCorrect: true`
 * is accepted and that field is discarded — not because it is filtered, but
 * because the object below is built from two named properties.
 *
 * The answer is bounded at the same 100 characters as
 * attempt_answers_selected_bounded, so an oversized selection is a 400 rather
 * than a constraint violation surfacing as a 500 from inside the transaction.
 *
 * @returns {Array<{questionId: number, answer: string}> | Error}
 */
function readAnswers(raw) {
  if (!Array.isArray(raw)) return badRequest("Answers must be an array.");

  if (raw.length > config.exam.maxQuestions) {
    return badRequest(
      `An attempt may have at most ${config.exam.maxQuestions} answers.`,
    );
  }

  const answers = [];

  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return badRequest("Each answer must be an object.");
    }

    const questionId = entry.questionId;
    if (!Number.isSafeInteger(questionId) || questionId < 1) {
      return badRequest("Each answer must name a question id.");
    }

    if (typeof entry.answer !== "string" || entry.answer.trim() === "") {
      return badRequest("Each answer must be a non-empty string.");
    }

    // Trimmed, but not case-folded. The grader compares strictly (§10), and
    // both sides are option ids this API issued — trimming absorbs a form's
    // stray whitespace, whereas lowercasing would be this layer deciding that
    // "b" means "B", which is a marking judgement.
    const answer = entry.answer.trim();
    if (answer.length > MAX_ANSWER_CHARS) {
      return badRequest(
        `Each answer must be ${MAX_ANSWER_CHARS} characters or fewer.`,
      );
    }

    answers.push({ questionId, answer });
  }

  return answers;
}
