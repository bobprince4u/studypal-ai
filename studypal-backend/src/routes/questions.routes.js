/**
 * POST /api/ask, GET /api/history/:username, GET /api/progress/:username
 *
 * Middleware order on /ask matters: multer must run before validation, because
 * until the multipart body is parsed there is no `req.body` to validate.
 */

import { Router } from "express";

import { ask, history, progress } from "../controllers/questions.controller.js";
import { asyncHandler } from "../middleware/error-handler.js";
import { acceptOptionalFile } from "../middleware/upload.js";
import {
  validateAskRequest,
  validateUsernameParam,
} from "../middleware/validation.js";

export const questionRoutes = Router();

questionRoutes.post(
  "/ask",
  acceptOptionalFile,
  validateAskRequest,
  asyncHandler(ask),
);

// Both are async since the PostgreSQL port: a rejected query must reach the
// error handler as a JSON 500, not surface as an unhandled rejection.
questionRoutes.get(
  "/history/:username",
  validateUsernameParam,
  asyncHandler(history),
);
questionRoutes.get(
  "/progress/:username",
  validateUsernameParam,
  asyncHandler(progress),
);
