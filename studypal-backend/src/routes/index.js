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
// Same arrangement, one ticket later: SP-V2-005 keeps routes, controller,
// service, repository, generator, validator, normalizer and calendar behind
// src/study-plans/, and this line is the only place the rest of the app reaches
// into it.
import { studyPlanRoutes } from "../study-plans/study-plan.routes.js";
// And again: SP-V2-006 keeps routes, controller, service, repository, generator,
// validator, grader and material brief behind src/exams/. The grader in
// particular is reachable from nowhere else, which is what makes "Gemini does
// not calculate scores" checkable rather than merely intended.
import { examRoutes } from "../exams/exam.routes.js";
// And again, read-only this time: SP-V2-007 keeps routes, controller, service,
// repository, metrics, serializers and validation behind src/analytics/. That
// folder contains no write of any kind, which is what makes "analytics never
// modifies learning data" checkable rather than merely intended.
import { analyticsRoutes } from "../analytics/analytics.routes.js";

export const routes = Router();

routes.use("/", healthRoutes);
routes.use("/api", sessionRoutes);
routes.use("/api", questionRoutes);
routes.use("/api", materialRoutes);
routes.use("/api", studyPlanRoutes);
routes.use("/api", examRoutes);
// Mounted last, and the order matters for once: analytics reads what every
// feature above it wrote, so a route collision would mean analytics had claimed
// a path one of them owns. There is none — every path here begins /api/analytics
// — and mounting it last makes that the easy thing to keep true.
routes.use("/api", analyticsRoutes);
