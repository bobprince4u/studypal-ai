/**
 * The six material endpoints (§10, plus SP-V2-004's chat endpoint).
 *
 *   POST   /api/materials                 multipart: username, file
 *   POST   /api/materials/chat            JSON: username, question, materialId?
 *   GET    /api/materials?username=…
 *   GET    /api/materials/:id?username=…
 *   GET    /api/materials/:id/status?username=…
 *   DELETE /api/materials/:id?username=…
 *
 * MIDDLEWARE ORDER
 * ----------------
 * On the upload route, `acceptMaterialFile` must precede `validateUploadBody`:
 * until multer has parsed the multipart body there is no `req.body.username` and
 * no `req.file` to check. The same constraint governs POST /api/ask in
 * questions.routes.js.
 *
 * On the per-material routes, the id is validated before the username only so the
 * more specific error wins when both are wrong; either order is correct.
 *
 * ROUTE ORDER
 * -----------
 * `/:id/status` is registered before `/:id`, which reads as if it mattered and
 * does not — Express matches on the full path, and `/:id` cannot match a
 * two-segment URL. It is written this way because the reverse order invites the
 * reader to wonder whether `:id` swallows "status", and answering that question in
 * the file is cheaper than answering it in review.
 *
 * `/materials/chat` DOES depend on order, and on a different route than it looks:
 * it is a POST, and the only other POST here is `/materials`, which cannot match a
 * two-segment path — so there is no conflict with it. The route it could have
 * collided with is `GET /materials/:id`, and it does not, because that is a GET and
 * this is a POST. It is registered next to the upload route anyway, so the two POSTs
 * are read together.
 *
 * The chat route takes NO multer middleware. It is a JSON endpoint, parsed by the
 * app-level `express.json()` under config.limits.jsonBody, so an oversized body is
 * the same 413 every other JSON endpoint gives. Running the multipart parser over
 * it would accept file uploads on an endpoint that has no use for one.
 *
 * Every handler is wrapped in `asyncHandler` so a rejected promise becomes a JSON
 * error from the central handler rather than an unhandled rejection.
 */

import { Router } from "express";

import { asyncHandler } from "../middleware/error-handler.js";
import { acceptMaterialFile } from "./material-upload.middleware.js";
import {
  validateChatBody,
  validateMaterialId,
  validateUploadBody,
  validateUsernameQuery,
} from "./material-validation.middleware.js";
import { get, list, remove, status, upload } from "./material.controller.js";
import { chat } from "./material-chat.controller.js";

export const materialRoutes = Router();

materialRoutes.post(
  "/materials",
  acceptMaterialFile,
  validateUploadBody,
  asyncHandler(upload),
);

materialRoutes.post(
  "/materials/chat",
  validateChatBody,
  asyncHandler(chat),
);

materialRoutes.get(
  "/materials",
  validateUsernameQuery,
  asyncHandler(list),
);

materialRoutes.get(
  "/materials/:id/status",
  validateMaterialId,
  validateUsernameQuery,
  asyncHandler(status),
);

materialRoutes.get(
  "/materials/:id",
  validateMaterialId,
  validateUsernameQuery,
  asyncHandler(get),
);

materialRoutes.delete(
  "/materials/:id",
  validateMaterialId,
  validateUsernameQuery,
  asyncHandler(remove),
);
