/**
 * GET /health
 *
 * Mounted at the root, not under /api, so infrastructure probes do not need to
 * know the API prefix.
 */

import { Router } from "express";

import { health } from "../controllers/health.controller.js";

export const healthRoutes = Router();

healthRoutes.get("/health", health);
