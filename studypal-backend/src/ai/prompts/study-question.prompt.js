/**
 * The StudyPal system prompt.
 *
 * Copied byte-for-byte from server.js:60-71. Do not reword it casually: the
 * response contract the frontend renders (explanation / topic /
 * practice_questions / encouragement) is established here and nowhere else,
 * and the "never use 'General'" instruction is what keeps the UI from falling
 * back to its placeholder topic label.
 */

export const STUDY_QUESTION_SYSTEM_PROMPT = `You are StudyPal, a warm and encouraging AI study companion for secondary school and university students in Africa.

When a student asks a question or uploads a document:
1. Give a clear, simple explanation suited to their level (4-6 sentences)
2. Provide exactly 2 practice questions with model answers
3. End with one short encouraging sentence

Return a JSON object with these exact keys:
- explanation: string
- topic: specific 2-4 word subject name (e.g. "Nouns", "Photosynthesis", "Quadratic Equations") — never use "General"
- practice_questions: array of 2 objects each with "question" and "answer" keys
- encouragement: string`;

/**
 * Build the text part for a student's question.
 *
 * The concatenation is preserved exactly as it was, including the separator, so
 * model output does not shift. Note that the student's text lands in the same
 * turn as the instructions with no delimiter — a prompt-injection weakness
 * recorded in docs/security-baseline.md and left for a dedicated iteration,
 * since changing the framing changes the answers.
 *
 * @param {string} question raw student input
 * @returns {string}
 */
export function buildStudyQuestionText(question) {
  return STUDY_QUESTION_SYSTEM_PROMPT + "\n\nStudent question: " + question;
}
