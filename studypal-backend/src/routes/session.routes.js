/**
 * POST /api/session
 */

import { Router } from "express";

import { createSession } from "../controllers/session.controller.js";
import { asyncHandler } from "../middleware/error-handler.js";
import { validateSessionRequest } from "../middleware/validation.js";

export const sessionRoutes = Router();

sessionRoutes.post(
  "/session",
  validateSessionRequest,
  asyncHandler(createSession),
);
