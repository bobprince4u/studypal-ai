import { startSession } from "../services/session.service.js";
export async function createSession(req, res) {
  res.json(await startSession(req.auth));
}
