/**
 * The grader (§10): the one place a score is decided.
 *
 * A pure function over an exam's answer key and a learner's submission. No
 * database, no request, no response, no clock, no Gemini — the same inputs give
 * the same result every time, which is what §5's "all grading must be
 * deterministic" means in practice and what makes it testable without a server
 * or a provider.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * §1: "Gemini MUST NOT be trusted to calculate scores or determine whether an
 * answer is correct." That is easy to say and easy to drift away from — a
 * "explain how I did" feature that asks the model to summarise a result is one
 * short step from asking it to produce the result. Keeping the arithmetic in a
 * module that imports nothing but config means the boundary is checkable:
 * tests/exams/architecture.test.js asserts this file never imports an AI module,
 * and the score cannot be computed anywhere else because nothing else knows how.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not read the answer key, and it does not write the result. The key
 * arrives as an argument (loaded from exam_questions by the repository) and the
 * result is returned (persisted by the repository, inside the submission
 * transaction). So this module cannot be the reason a grade is wrong in the
 * database, only the reason it is wrong in arithmetic.
 *
 * It also does not decide which questions exist or whether a submitted question
 * id belongs to the exam. That validation happens before grading, in the
 * service, because an answer to a question from someone else's exam is a
 * rejected REQUEST rather than a wrong answer.
 */

import { config } from "../config/env.js";

/**
 * Grade a submission.
 *
 * UNANSWERED QUESTIONS COUNT AS WRONG, AND THAT IS A DELIBERATE CHOICE. The
 * percentage is over every question in the exam, not over the questions the
 * learner attempted — a 10-question paper with one correct answer and nine left
 * blank is 10%, not 100%. Scoring it the other way would make skipping the hard
 * questions the optimal strategy, and would make two attempts at the same exam
 * incomparable, which is the data SP-V2-007 is going to read.
 *
 * They are counted as wrong WITHOUT a row: attempt_answers holds what the
 * learner actually selected, and an invented row saying they chose nothing would
 * be this module putting data it made up into the learner's history.
 *
 * @param {Array<{id: number, correctAnswer: string}>} questions every question
 *   in the exam, as loaded from exam_questions — the answer key
 * @param {Map<number, string>} submitted questionId → the answer the learner
 *   selected, containing only questions they actually answered
 * @param {object} [options]
 * @param {number} [options.passingPercentage] defaults to
 *   config.exam.passingPercentage; injectable so a test can state a threshold
 *   rather than depend on the environment
 * @returns {{results: Array<{questionId: number, selectedAnswer: string,
 *   isCorrect: boolean}>, score: number, totalQuestions: number,
 *   correctAnswers: number, percentage: number, passed: boolean}}
 */
export function gradeAttempt(
  questions,
  submitted,
  { passingPercentage = config.exam.passingPercentage } = {},
) {
  const results = [];
  let correctAnswers = 0;

  // Iterated over the QUESTIONS, not over the submission. The answer key decides
  // what is on the paper; a submission carrying an extra entry cannot add a
  // question, and one missing an entry cannot remove one. (The service has
  // already rejected unknown question ids by this point — this loop means a bug
  // there could not inflate a total either.)
  for (const question of questions) {
    const selectedAnswer = submitted.get(question.id);
    if (selectedAnswer === undefined) continue;

    // §10, verbatim: `selectedAnswer === correctAnswer`. A strict comparison of
    // two strings, case-sensitively, with no trimming and no normalisation —
    // both sides are option ids the backend itself produced (the key from
    // exam_questions, the selection validated against that question's own
    // options), so any difference between them is a real difference and not a
    // formatting artefact. Anything looser would be this function deciding that
    // "b" means "B", which is a marking judgement, not arithmetic.
    const isCorrect = selectedAnswer === question.correctAnswer;
    if (isCorrect) correctAnswers += 1;

    results.push({ questionId: question.id, selectedAnswer, isCorrect });
  }

  const totalQuestions = questions.length;

  // Math.round, exactly as §10 specifies. Guarded against an empty exam even
  // though exams_question_count_positive makes one unrepresentable: a division
  // by zero here would produce NaN, which would fail the percentage CHECK as a
  // 500 from inside the transaction rather than as the 0 it should obviously be.
  const percentage =
    totalQuestions === 0
      ? 0
      : Math.round((correctAnswers / totalQuestions) * 100);

  return {
    results,
    // The same count under §9's two names. exam_attempts_score_matches_correct
    // asserts they stay equal; computing both here rather than letting two
    // layers each derive one is why they can.
    score: correctAnswers,
    totalQuestions,
    correctAnswers,
    // At or above, not above — 70% with a threshold of 70 passes. Stated here
    // once; every other layer reads this boolean.
    percentage,
    passed: percentage >= passingPercentage,
  };
}
