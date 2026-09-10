/**
 * HTTP boundary for POST /api/materials/chat.
 *
 * A separate controller from material.controller.js, not an extra handler on it,
 * because this endpoint's dependencies are entirely different: the CRUD
 * controller reaches storage and the material service, this one reaches
 * retrieval and the AI path. Keeping them apart means the architecture check for
 * "no AI in the material CRUD controller" stays meaningful, and a reader can see
 * from the import list which handlers can spend provider quota.
 *
 * As thin as the other one, and for the same reasons (§27): read the validated
 * input, call one service function, send JSON. No SQL, no vector arithmetic, no
 * prompt construction, no Google SDK — all of which the architecture tests assert
 * by reading this file.
 */

import * as materialChatService from "./material-chat.service.js";

/**
 * POST /api/materials/chat — answer a question from the student's own materials.
 *
 * Request:  `{username, question, materialId?, topK?}`
 * Response: `{answer, sources: [{materialId, filename, pageNumber, chunkIndex, similarity}]}`
 *
 * 200 with an empty `sources` array when nothing in the student's materials was
 * relevant. Not a 404 and not a 422: the request was well-formed, the search ran,
 * and "your materials do not cover this" is an ANSWER — the honest one — rather
 * than a failure. A 4xx would push a client into an error branch for what is a
 * normal, expected outcome, and would obscure the genuine 404 that a
 * `materialId` belonging to someone else produces.
 *
 * `grounded` is dropped rather than forwarded. It is how the service tells the
 * two 200s apart internally, and a client can tell them apart from `sources`
 * being empty; adding a second, redundant signal to the response contract would
 * be one more thing to keep consistent for no new information.
 */
export async function chat(req, res) {
  const { answer, sources } = await materialChatService.answerFromMaterials({
    username: req.validated.username,
    question: req.validated.question,
    materialId: req.validated.materialId,
    topK: req.validated.topK,
  });

  res.json({ answer, sources });
}
