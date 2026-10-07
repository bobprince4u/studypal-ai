/**
 * POST /api/ask, GET /api/history/:username, GET /api/progress/:username
 *
 * These controllers never touch Gemini or SQL. `ask` in particular is now four
 * lines: the prompt, the provider call, the parse and the insert all live below
 * the service boundary, where they can be tested without an HTTP server.
 */

import * as questionService from "../services/question.service.js";

export async function ask(req, res) {
  const { question } = req.validated;

  const answer = await questionService.askQuestion({
    userId: req.user.id,
    question,
    file: req.file,
  });

  // Returned verbatim. The frontend renders this object directly and reads
  // explanation / topic / practice_questions / encouragement off it, so no
  // wrapping envelope may be introduced here.
  res.json(answer);
}

export async function history(req, res) {
  res.json(await questionService.getHistory(req.user.id));
}

export async function progress(req, res) {
  res.json(await questionService.getProgress(req.user.id));
}
