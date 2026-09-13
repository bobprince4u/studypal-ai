/**
 * The deterministic exam modules — SP-V2-006 §16's "Grading logic" group, and
 * the half of "Exam generation" that needs no server.
 *
 * src/exams/grader.js and src/exams/exam-output.validator.js are pure functions
 * over plain data: no database, no request, no clock, no provider. So they are
 * tested directly, exhaustively, and in milliseconds — which is the reason they
 * were separated from the service in the first place.
 *
 * WHY THE GRADER IS TESTED HERE AND NOT ONLY THROUGH HTTP
 * ------------------------------------------------------
 * §10 fixes two formulas: `correct = count(selected === correctAnswer)` and
 * `percentage = Math.round((correct / total) * 100)`. Through HTTP each case
 * costs a generation, an attempt and a submission, and a wrong percentage would
 * be indistinguishable from a wrong answer key. Here the key is an argument, so
 * a failure names the arithmetic.
 *
 * The rounding cases below are the point of this file. Math.round is specified
 * rather than floor or ceil, and the three thirds — 1/3, 2/3, 1/6 — are where
 * the three differ. A grader written with floor passes every whole-number test
 * and fails only these.
 *
 * WHAT THIS FILE CANNOT SHOW
 * --------------------------
 * That the key the grader marked against came from the database, that the result
 * was persisted, or that a client cannot supply `isCorrect`. Those are
 * properties of the integrated path and live in tests/exams/api.test.js.
 *
 *   node --test tests/exams/grading.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gradeAttempt } from "../../src/exams/grader.js";
import { validateExamOutput } from "../../src/exams/exam-output.validator.js";

/** An answer key in the shape findAnswerKey returns. */
function key(...correctAnswers) {
  return correctAnswers.map((correctAnswer, index) => ({
    id: index + 1,
    correctAnswer,
  }));
}

/** A submission in the shape the service builds from the request body. */
function submission(entries) {
  return new Map(Object.entries(entries).map(([id, answer]) => [Number(id), answer]));
}

describe("§10 the score", () => {
  it("counts an answer correct only when it equals the key exactly", () => {
    const result = gradeAttempt(key("A", "B", "C"), submission({ 1: "A", 2: "X", 3: "C" }));

    assert.equal(result.correctAnswers, 2);
    assert.equal(result.score, 2);
    assert.equal(result.totalQuestions, 3);
    assert.deepEqual(
      result.results.map((r) => [r.questionId, r.isCorrect]),
      [
        [1, true],
        [2, false],
        [3, true],
      ],
    );
  });

  it("reports score and correctAnswers as the same number", () => {
    // exam_attempts_score_matches_correct enforces this in the database. If the
    // two are ever computed separately, this is where it shows up first.
    for (const answers of [{}, { 1: "A" }, { 1: "A", 2: "B" }, { 1: "X", 2: "B" }]) {
      const result = gradeAttempt(key("A", "B"), submission(answers));
      assert.equal(result.score, result.correctAnswers, JSON.stringify(answers));
    }
  });

  it("is case-sensitive, and does not trim", () => {
    // Both sides are option ids the backend issued, so any difference is real.
    // The middleware trims whitespace before this point; nothing lowercases.
    const lower = gradeAttempt(key("B"), submission({ 1: "b" }));
    assert.equal(lower.correctAnswers, 0);

    const exact = gradeAttempt(key("B"), submission({ 1: "B" }));
    assert.equal(exact.correctAnswers, 1);
  });

  it("marks true_false ids the same way", () => {
    const result = gradeAttempt(key("true", "false"), submission({ 1: "true", 2: "true" }));
    assert.equal(result.correctAnswers, 1);
    assert.equal(result.percentage, 50);
  });
});

describe("§10 the percentage", () => {
  it("is a whole percentage of the exam, not of the answered questions", () => {
    // The heart of the grader's documented choice: 1 of 10 with nine blanks is
    // 10%, not 100%. Scoring it the other way would make skipping optimal.
    const result = gradeAttempt(key(..."ABCDEFGHIJ".split("")), submission({ 1: "A" }));

    assert.equal(result.correctAnswers, 1);
    assert.equal(result.totalQuestions, 10);
    assert.equal(result.percentage, 10);
  });

  it("rounds half up, as Math.round specifies", () => {
    // 1/3 → 33.33 → 33 (floor and round agree, ceil does not)
    const third = gradeAttempt(key("A", "B", "C"), submission({ 1: "A" }));
    assert.equal(third.percentage, 33);

    // 2/3 → 66.67 → 67. A floor implementation gives 66 and fails here.
    const twoThirds = gradeAttempt(key("A", "B", "C"), submission({ 1: "A", 2: "B" }));
    assert.equal(twoThirds.percentage, 67);

    // 1/6 → 16.67 → 17. Same discriminator, different denominator.
    const sixth = gradeAttempt(key("A", "B", "C", "D", "E", "F"), submission({ 1: "A" }));
    assert.equal(sixth.percentage, 17);

    // 1/8 → 12.5 → 13. Exactly .5, which is where round's tie-break shows.
    const eighth = gradeAttempt(
      key("A", "B", "C", "D", "E", "F", "G", "H"),
      submission({ 1: "A" }),
    );
    assert.equal(eighth.percentage, 13);
  });

  it("is 0 for a blank paper and 100 for a perfect one", () => {
    const blank = gradeAttempt(key("A", "B"), submission({}));
    assert.equal(blank.percentage, 0);
    assert.equal(blank.correctAnswers, 0);
    assert.deepEqual(blank.results, []);

    const perfect = gradeAttempt(key("A", "B"), submission({ 1: "A", 2: "B" }));
    assert.equal(perfect.percentage, 100);
  });

  it("is 0 rather than NaN for an exam with no questions", () => {
    // Unrepresentable in the database (exams_question_count_positive), but a
    // division by zero here would be a NaN that fails the percentage CHECK as a
    // 500 from inside the transaction rather than as the obvious 0.
    const result = gradeAttempt([], submission({}));
    assert.equal(result.percentage, 0);
    assert.equal(result.totalQuestions, 0);
    assert.equal(result.passed, false);
  });
});

describe("§10 the pass threshold", () => {
  it("passes at exactly the threshold, not only above it", () => {
    // 70% with a threshold of 70 passes. `>` rather than `>=` fails here.
    const ten = key(..."ABCDEFGHIJ".split(""));
    const seven = gradeAttempt(
      ten,
      submission({ 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F", 7: "G" }),
      { passingPercentage: 70 },
    );

    assert.equal(seven.percentage, 70);
    assert.equal(seven.passed, true);
  });

  it("fails one mark below the threshold", () => {
    const ten = key(..."ABCDEFGHIJ".split(""));
    const six = gradeAttempt(
      ten,
      submission({ 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F" }),
      { passingPercentage: 70 },
    );

    assert.equal(six.percentage, 60);
    assert.equal(six.passed, false);
  });

  it("reads the threshold from config when none is given", () => {
    // §10 requires the threshold to be configurable and stated once. The
    // default is 70, so 70% must pass without the option being passed in.
    const ten = key(..."ABCDEFGHIJ".split(""));
    const seven = gradeAttempt(ten, submission({
      1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F", 7: "G",
    }));

    assert.equal(seven.percentage, 70);
    assert.equal(seven.passed, true);
  });
});

describe("§10 unanswered questions", () => {
  it("counts them wrong without inventing a row for them", () => {
    // attempt_answers holds what the learner actually selected. A row saying
    // they chose nothing would be the grader putting made-up data in their
    // history, and selected_answer is NOT NULL precisely to prevent it.
    const result = gradeAttempt(key("A", "B", "C"), submission({ 2: "B" }));

    assert.equal(result.totalQuestions, 3);
    assert.equal(result.correctAnswers, 1);
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0], {
      questionId: 2,
      selectedAnswer: "B",
      isCorrect: true,
    });
  });

  it("ignores a submission entry for a question not on the paper", () => {
    // The loop runs over the KEY, not the submission, so a stray entry cannot
    // add a question or inflate the total. The service rejects unknown ids with
    // a 400 before this — this asserts a bug there could not corrupt a grade.
    const result = gradeAttempt(key("A"), submission({ 1: "A", 99: "B" }));

    assert.equal(result.totalQuestions, 1);
    assert.equal(result.correctAnswers, 1);
    assert.equal(result.percentage, 100);
    assert.deepEqual(result.results.map((r) => r.questionId), [1]);
  });
});

// ── the validator (§7, §8) ──────────────────────────────────────────────────

/** The options a valid multiple-choice question carries. */
const MCQ_OPTIONS = [
  { id: "A", text: "First" },
  { id: "B", text: "Second" },
  { id: "C", text: "Third" },
  { id: "D", text: "Fourth" },
];

function mcq(overrides = {}) {
  return {
    type: "multiple_choice",
    question: "Which statement is correct?",
    options: MCQ_OPTIONS,
    correctAnswer: "B",
    explanation: "Because B is consistent with the material.",
    ...overrides,
  };
}

function boolq(overrides = {}) {
  return {
    type: "true_false",
    question: "Photosynthesis releases oxygen.",
    options: [
      { id: "true", text: "True" },
      { id: "false", text: "False" },
    ],
    correctAnswer: "true",
    explanation: "Oxygen comes from splitting water.",
    ...overrides,
  };
}

/** Validate a response object with sensible defaults for the options. */
function validate(response, options = {}) {
  return validateExamOutput(
    typeof response === "string" ? response : JSON.stringify(response),
    {
      questionCount: 1,
      allowedTypes: new Set(["multiple_choice", "true_false"]),
      maxTextChars: 200,
      maxQuestionChars: 2000,
      sourceCount: 0,
      ...options,
    },
  );
}

describe("§7 the validator accepts well-formed output", () => {
  it("accepts a multiple-choice question", () => {
    const result = validate({ title: "Exam", questions: [mcq()] });

    assert.notEqual(result, null);
    assert.equal(result.title, "Exam");
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].correctAnswer, "B");
    assert.equal(result.questions[0].type, "multiple_choice");
  });

  it("accepts a true/false question and normalises its option ids", () => {
    // §7's own example shows `[{id:"true"},{id:"false"}]` with no text, so the
    // display strings are the backend's to supply — and "True" decides nothing,
    // whereas the IDS are what grading compares.
    const result = validate({
      title: "Exam",
      questions: [
        boolq({
          options: [
            { id: "FALSE", text: "nope" },
            { id: "True", text: "yep" },
          ],
          correctAnswer: "TRUE",
        }),
      ],
    });

    assert.notEqual(result, null);
    assert.deepEqual(result.questions[0].options, [
      { id: "true", text: "True" },
      { id: "false", text: "False" },
    ]);
    // Emitted true-then-false whatever order the model used, and the key
    // normalised to match.
    assert.equal(result.questions[0].correctAnswer, "true");
  });

  it("clamps text that is merely too long rather than rejecting it", () => {
    // A 5000-character explanation is a good explanation with a long tail.
    // Rejecting it would cost the learner a second generation for a cosmetic
    // problem, and the bounds match the CHECK constraints so nothing that
    // leaves here can fail on INSERT.
    const result = validate({
      title: "T".repeat(600),
      questions: [mcq({ question: "Q".repeat(5000), explanation: "E".repeat(5000) })],
    });

    assert.notEqual(result, null);
    assert.ok(result.title.length <= 200, `title was ${result.title.length}`);
    assert.ok(result.questions[0].questionText.length <= 2000);
    assert.ok(result.questions[0].explanation.length <= 2000);
  });
});

describe("§8 the validator rejects structurally wrong output", () => {
  // Each case is a rejection §7 or §8 names. null is the generator's signal to
  // retry or fail — never to persist.
  const rejections = {
    "unparseable JSON": "this is prose, not JSON",
    "a JSON array rather than an object": "[]",
    "a JSON scalar": "42",
    "null": "null",
  };

  for (const [what, raw] of Object.entries(rejections)) {
    it(`rejects ${what}`, () => {
      assert.equal(validate(raw), null);
    });
  }

  it("rejects a missing or blank title", () => {
    assert.equal(validate({ questions: [mcq()] }), null);
    assert.equal(validate({ title: "   ", questions: [mcq()] }), null);
    assert.equal(validate({ title: 42, questions: [mcq()] }), null);
  });

  it("rejects an empty or missing question list", () => {
    // An exam with no questions is not a short exam; it is a response that
    // failed to answer.
    assert.equal(validate({ title: "Exam", questions: [] }), null);
    assert.equal(validate({ title: "Exam" }), null);
    assert.equal(validate({ title: "Exam", questions: "two" }), null);
  });

  it("rejects the wrong number of questions in either direction", () => {
    // §8's count rule. Not trimmed to the requested count and not accepted
    // as-is: §8 forbids both.
    assert.equal(
      validate({ title: "Exam", questions: [mcq()] }, { questionCount: 2 }),
      null,
    );
    assert.equal(
      validate({ title: "Exam", questions: [mcq(), mcq()] }, { questionCount: 1 }),
      null,
    );
  });

  it("rejects a question type outside the two supported", () => {
    for (const type of ["essay", "coding", "short_answer", "", 7]) {
      assert.equal(
        validate({ title: "Exam", questions: [mcq({ type })] }),
        null,
        `type ${JSON.stringify(type)} was accepted`,
      );
    }
  });

  it("rejects a supported type the REQUEST did not ask for", () => {
    // A true/false paper that comes back multiple-choice is output that does
    // not match what was ordered.
    assert.equal(
      validate(
        { title: "Exam", questions: [mcq()] },
        { allowedTypes: new Set(["true_false"]) },
      ),
      null,
    );
    assert.equal(
      validate(
        { title: "Exam", questions: [boolq()] },
        { allowedTypes: new Set(["multiple_choice"]) },
      ),
      null,
    );
  });

  it("rejects a multiple-choice question without exactly four options", () => {
    // Exact rather than a minimum: a three-option question is a 33% guess where
    // a four-option one is 25%, so a mixed paper has no single meaning for 50%.
    assert.equal(validate({ title: "Exam", questions: [mcq({ options: MCQ_OPTIONS.slice(0, 3) })] }), null);
    assert.equal(
      validate({
        title: "Exam",
        questions: [mcq({ options: [...MCQ_OPTIONS, { id: "E", text: "Fifth" }] })],
      }),
      null,
    );
    assert.equal(validate({ title: "Exam", questions: [mcq({ options: [] })] }), null);
    assert.equal(validate({ title: "Exam", questions: [mcq({ options: "four" })] }), null);
  });

  it("rejects duplicate option ids", () => {
    // Two options labelled "B" make the key ambiguous — "B" would identify two
    // different answers — so the response is refused rather than de-duplicated
    // down to three options.
    assert.equal(
      validate({
        title: "Exam",
        questions: [
          mcq({
            options: [
              { id: "A", text: "First" },
              { id: "A", text: "Duplicate" },
              { id: "C", text: "Third" },
              { id: "D", text: "Fourth" },
            ],
          }),
        ],
      }),
      null,
    );
  });

  it("rejects a correct answer that matches no option", () => {
    assert.equal(validate({ title: "Exam", questions: [mcq({ correctAnswer: "Z" })] }), null);
    assert.equal(validate({ title: "Exam", questions: [mcq({ correctAnswer: "" })] }), null);
    assert.equal(validate({ title: "Exam", questions: [mcq({ correctAnswer: 2 })] }), null);
    // Case matters for multiple choice, because the grader compares strictly.
    assert.equal(validate({ title: "Exam", questions: [mcq({ correctAnswer: "b" })] }), null);
  });

  it("rejects a true/false question without exactly two valid options", () => {
    assert.equal(
      validate({ title: "Exam", questions: [boolq({ options: [{ id: "true", text: "T" }] })] }),
      null,
    );
    assert.equal(
      validate({
        title: "Exam",
        questions: [
          boolq({
            options: [
              { id: "true", text: "T" },
              { id: "maybe", text: "M" },
            ],
          }),
        ],
      }),
      null,
    );
    assert.equal(
      validate({
        title: "Exam",
        questions: [
          boolq({
            options: [
              { id: "true", text: "T" },
              { id: "true", text: "again" },
            ],
            correctAnswer: "true",
          }),
        ],
      }),
      null,
    );
  });

  it("rejects blank question text and blank explanations", () => {
    // An explanation is the only thing a wrong answer leaves the learner with,
    // and exam_questions stores it NOT NULL so there is no silent placeholder.
    assert.equal(validate({ title: "Exam", questions: [mcq({ question: "  " })] }), null);
    assert.equal(validate({ title: "Exam", questions: [mcq({ explanation: "  " })] }), null);
    assert.equal(validate({ title: "Exam", questions: [mcq({ explanation: undefined })] }), null);
  });

  it("rejects an option id longer than the column allows", () => {
    // Rejected rather than clamped, unlike the prose fields: a clamped id would
    // no longer match the option it came from, turning a cosmetic problem into
    // an unanswerable question.
    assert.equal(
      validate({
        title: "Exam",
        questions: [
          mcq({
            options: [
              { id: "A".repeat(101), text: "Long" },
              { id: "B", text: "Second" },
              { id: "C", text: "Third" },
              { id: "D", text: "Fourth" },
            ],
            correctAnswer: "B",
          }),
        ],
      }),
      null,
    );
  });

  it("rejects a non-object question entry", () => {
    for (const entry of [null, "a question", 7, ["A"]]) {
      assert.equal(
        validate({ title: "Exam", questions: [entry] }),
        null,
        `entry ${JSON.stringify(entry)} was accepted`,
      );
    }
  });
});

describe("§14 the validator drops fabricated source references", () => {
  it("keeps the question and drops a source number past the source count", () => {
    // A sourceNumber of 7 in an exam shown three sources is a fabricated
    // attribution. The question itself is still the model's honest work — it is
    // the citation that was invented.
    const result = validate(
      { title: "Exam", questions: [mcq({ sourceNumber: 7 })] },
      { sourceCount: 3 },
    );

    assert.notEqual(result, null);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].sourceNumber, null);
    assert.equal(result.droppedSourceRefs, 1);
  });

  it("keeps a source number the prompt actually contained", () => {
    const result = validate(
      { title: "Exam", questions: [mcq({ sourceNumber: 2 })] },
      { sourceCount: 3 },
    );

    assert.equal(result.questions[0].sourceNumber, 2);
    assert.equal(result.droppedSourceRefs, 0);
  });

  it("treats an absent source number as the normal topic-only case", () => {
    const result = validate({ title: "Exam", questions: [mcq()] }, { sourceCount: 0 });

    assert.equal(result.questions[0].sourceNumber, null);
    assert.equal(result.droppedSourceRefs, 0);
  });

  it("drops a source number that is not a usable index", () => {
    for (const sourceNumber of [0, -1, 1.5, "1", true]) {
      const result = validate(
        { title: "Exam", questions: [mcq({ sourceNumber })] },
        { sourceCount: 3 },
      );
      assert.notEqual(result, null, `sourceNumber ${sourceNumber} rejected the response`);
      assert.equal(
        result.questions[0].sourceNumber,
        null,
        `sourceNumber ${sourceNumber} was kept`,
      );
    }
  });
});

describe("§5 the validator never decides correctness", () => {
  it("does not mark, score or grade anything it returns", () => {
    // The validator's job is that the model named one of its OWN options as the
    // key. Marking happens in the grader, against the stored key, long after.
    const result = validate({ title: "Exam", questions: [mcq(), mcq()] }, { questionCount: 2 });

    assert.notEqual(result, null);
    for (const question of result.questions) {
      assert.equal(question.isCorrect, undefined);
      assert.equal(question.score, undefined);
      assert.equal(question.percentage, undefined);
      assert.equal(question.passed, undefined);
    }
    assert.equal(result.score, undefined);
    assert.equal(result.percentage, undefined);
    assert.equal(result.passed, undefined);
  });

  it("assigns no ids and no ordering", () => {
    // The response has neither, and question_order comes from array position in
    // the repository — so a model cannot choose a question's position or id.
    const result = validate({ title: "Exam", questions: [mcq()] });

    assert.equal(result.questions[0].id, undefined);
    assert.equal(result.questions[0].questionOrder, undefined);
    assert.equal(result.questions[0].question_order, undefined);
  });
});
