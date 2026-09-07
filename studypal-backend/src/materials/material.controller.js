/**
 * HTTP boundary for /api/materials.
 *
 * Deliberately thin — read the validated input, call one service function, send
 * its result as JSON. No SQL, no `fs`, no extraction, no validation logic (§12:
 * "Do NOT put document extraction logic in controllers", §27's layering checks).
 * If a handler here grows past four lines, something belongs in the service.
 *
 * The validated values come from `req.validated`, set by
 * material-validation.middleware.js — the same convention the existing
 * controllers follow, so nothing here re-reads `req.query` or re-parses an id.
 */

import * as materialService from "./material.service.js";

/**
 * POST /api/materials — multipart upload, processed synchronously.
 *
 * 201 with the finished material. 201 even when processing ended in `failed`,
 * because the MATERIAL was created either way and the response says so in its
 * `status` and `error` fields. A 4xx would imply nothing had been stored, which
 * would be wrong: the row exists, it is in the student's list, and they can
 * delete it. §11's lifecycle is reported through `status`, not through the HTTP
 * code.
 */
export async function upload(req, res) {
  const material = await materialService.uploadMaterial({
    username: req.validated.username,
    file: req.file,
  });
  res.status(201).json(material);
}

/** GET /api/materials?username=… — that user's materials, newest first. */
export async function list(req, res) {
  res.json(await materialService.listMaterials(req.validated.username));
}

/** GET /api/materials/:id?username=… — one material's metadata. */
export async function get(req, res) {
  res.json(
    await materialService.getMaterial({
      id: req.validated.id,
      username: req.validated.username,
    }),
  );
}

/** GET /api/materials/:id/status?username=… — processing state only. */
export async function status(req, res) {
  res.json(
    await materialService.getMaterialStatus({
      id: req.validated.id,
      username: req.validated.username,
    }),
  );
}

/**
 * DELETE /api/materials/:id?username=… — removes chunks, row and stored file.
 *
 * 200 with a body rather than 204, matching the rest of this API: every other
 * endpoint returns JSON, and the frontend's fetch wrapper parses the body
 * unconditionally. A 204 would give it nothing to parse.
 *
 * Not idempotent in the strict sense — a second DELETE returns 404, because the
 * service cannot distinguish "you already deleted this" from "this was never
 * yours" without keeping tombstones, and answering 200 to the latter would tell a
 * caller that someone else's material used to exist.
 */
export async function remove(req, res) {
  res.json(
    await materialService.deleteMaterial({
      id: req.validated.id,
      username: req.validated.username,
    }),
  );
}
