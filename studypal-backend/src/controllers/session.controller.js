/**
 * POST /api/session
 *
 * HTTP only: read the validated input, call the service, shape the response.
 * No SQL, no Gemini, no try/catch — failures propagate to the error handler.
 */

import * as sessionService from "../services/session.service.js";

export async function createSession(req, res) {
  const { username } = req.validated;
  res.json(await sessionService.startSession(username));
}
