/**
 * HTTP boundary for /api/study-plans.
 *
 * Thin, like the material controllers and for the same reasons (§4): read the
 * validated input, call one service function, send JSON. No SQL, no prompt
 * construction, no Gemini call, no scheduling arithmetic — §4 names three of
 * those outright ("Do not put Gemini calls in controllers. Do not put SQL in
 * controllers/services"), and the architecture tests assert them by reading this
 * file.
 *
 * Every value comes from `req.validated`, set by
 * study-plan-validation.middleware.js. Nothing here re-reads `req.body`,
 * re-parses an id, or decides what an absent field means.
 */

import * as studyPlanService from "./study-plan.service.js";

/**
 * POST /api/study-plans — generate and persist a plan (§9, §39).
 *
 * 201 with the full plan and its tasks. 201 rather than 200 because a resource
 * was created, and rather than 202 because it was created before the response
 * was sent: generation is synchronous here, matching the material upload path
 * and §2's exclusion of background workers.
 *
 * The response body is the §39 contract in full — the client needs the tasks to
 * render the plan, and a 201 with only an id would make every creation two
 * round trips.
 */
export async function create(req, res) {
  const plan = await studyPlanService.createStudyPlan({
    username: req.validated.username,
    subject: req.validated.subject,
    topics: req.validated.topics,
    examDate: req.validated.examDate,
    dailyMinutes: req.validated.dailyMinutes,
    difficultyLevel: req.validated.difficultyLevel,
    studyDays: req.validated.studyDays,
    materialIds: req.validated.materialIds,
  });

  res.status(201).json(plan);
}

/** GET /api/study-plans?username=… — that user's plans, newest first (§26). */
export async function list(req, res) {
  res.json(await studyPlanService.listStudyPlans(req.validated.username));
}

/** GET /api/study-plans/:id?username=… — one plan, with its tasks (§27). */
export async function get(req, res) {
  res.json(
    await studyPlanService.getStudyPlan({
      id: req.validated.id,
      username: req.validated.username,
    }),
  );
}

/**
 * PATCH /api/study-plans/:planId/tasks/:taskId — move one task (§28).
 *
 * Returns the updated task and the plan's recomputed status (§29). Both, because
 * completing a task can complete the PLAN, and a client that received only the
 * task would have to re-fetch the plan to find out — or, worse, would not, and
 * would show a finished plan as still active.
 */
export async function updateTaskStatus(req, res) {
  res.json(
    await studyPlanService.updateTaskStatus({
      planId: req.validated.planId,
      taskId: req.validated.taskId,
      username: req.validated.username,
      status: req.validated.status,
    }),
  );
}

/**
 * POST /api/study-plans/:id/regenerate — a new plan from the same goals (§30).
 *
 * 201, and the body is the NEW plan. The original is untouched apart from its
 * status becoming `archived`, and the new plan's `parentPlanId` points at it —
 * so a client that wants to show what was replaced has the id to fetch.
 */
export async function regenerate(req, res) {
  const plan = await studyPlanService.regenerateStudyPlan({
    id: req.validated.id,
    username: req.validated.username,
  });

  res.status(201).json(plan);
}
