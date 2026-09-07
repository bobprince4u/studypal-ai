/**
 * The five material endpoints (§10).
 *
 *   POST   /api/materials                 multipart: username, file
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
 * Every handler is wrapped in `asyncHandler` so a rejected promise becomes a JSON
 * error from the central handler rather than an unhandled rejection.
 */

import { Router } from "express";

import { asyncHandler } from "../middleware/error-handler.js";
import { acceptMaterialFile } from "./material-upload.middleware.js";
import {
  validateMaterialId,
  validateUploadBody,
  validateUsernameQuery,
} from "./material-validation.middleware.js";
import { get, list, remove, status, upload } from "./material.controller.js";

export const materialRoutes = Router();

materialRoutes.post(
  "/materials",
  acceptMaterialFile,
  validateUploadBody,
  asyncHandler(upload),
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
