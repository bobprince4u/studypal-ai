/**
 * GET /health
 *
 * Mounted at the root, not under /api, so infrastructure probes do not need to
 * know the API prefix.
 */

import { Router } from "express";

import { health } from "../controllers/health.controller.js";
import { asyncHandler } from "../middleware/error-handler.js";

export const healthRoutes = Router();

// Async since the PostgreSQL port. The handler catches its own database error
// and reports 503, so this is for anything unexpected around it.
healthRoutes.get("/health", asyncHandler(health));
