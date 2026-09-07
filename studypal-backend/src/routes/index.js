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
// Mounted from src/materials/ rather than from this directory: SP-V2-003 keeps
// the whole feature — routes, controller, service, repository and the processing
// modules — behind one boundary, so the table below is the only place the rest of
// the app touches it.
import { materialRoutes } from "../materials/material.routes.js";

export const routes = Router();

routes.use("/", healthRoutes);
routes.use("/api", sessionRoutes);
routes.use("/api", questionRoutes);
routes.use("/api", materialRoutes);
