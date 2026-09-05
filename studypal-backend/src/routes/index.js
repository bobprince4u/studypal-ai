/**
 * Route table.
 *
 * The single place that decides which URL prefixes exist. `/api` is preserved
 * exactly — the frontend builds every request as `${API}/api/...`.
 */

import { Router } from "express";

import { healthRoutes } from "./health.routes.js";
import { questionRoutes } from "./questions.routes.js";
import { sessionRoutes } from "./session.routes.js";

export const routes = Router();

routes.use("/", healthRoutes);
routes.use("/api", sessionRoutes);
routes.use("/api", questionRoutes);
