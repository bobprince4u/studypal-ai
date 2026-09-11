/**
 * The plan normalizer: an ordered list of activities becomes a dated schedule.
 *
 * This is where §11-§13 and §21-§22 are actually enforced, and it is entirely
 * deterministic — same input, same plan, no model involved. The model decided
 * WHAT to study and IN WHAT ORDER; everything below decides WHEN, and it decides
 * it from the learner's own study days and daily budget.
 *
 * THE PACKING RULE
 * ----------------
 * One forward pass. Tasks are taken in the order the model returned them and
 * placed on the first available study date with room for them:
 *
 *   duration is clamped to the daily budget          §21
 *   a task that does not fit today moves to tomorrow  §22 — "compress"
 *   a task with no date left is dropped               §22 — never overflow
 *
 * Because a clamped duration can never exceed a full day's budget, the first
 * task on any date always fits. That is what makes the pass single: there is no
 * backtracking, no bin-packing search, and no date that gets skipped while
 * holding room. It also means the used dates are a prefix of the available ones,
 * so `startDate` is the first available date and `endDate` is wherever the
 * content ran out.
 *
 * WHY COMPRESS RATHER THAN REJECT
 * -------------------------------
 * §22 allows either, and requires the choice to be consistent and documented.
 * This implementation compresses, and rejects only the degenerate case of a plan
 * that normalizes to ZERO tasks.
 *
 * The reason is what each behaviour does to the learner. A model that produced
 * 10% more content than fits is not wrong about the material — it is wrong about
 * the arithmetic, which is not its job and is precisely what this module is for.
 * Rejecting would mean a second generation, a second provider call, and an error
 * message about something the learner cannot act on: they did not choose how
 * much content the model proposed. Dropping the tail keeps a complete, ordered,
 * correctly-budgeted plan covering the material the model itself prioritised
 * first — and the drop is reported, so the API can say so rather than pretending
 * the plan was always that length.
 *
 * A GUARANTEE, NOT A BEST EFFORT
 * ------------------------------
 * Every task that comes out of here satisfies all four of:
 *   - its date is one the learner listed as a study day;
 *   - its date is on or before the exam date;
 *   - its duration is between 1 and the daily budget;
 *   - the total duration on any one date is at most the daily budget.
 * No caller re-checks these, and no caller should have to.
 */

import { logger } from "../utils/logger.js";

/**
 * Assign dates, positions, durations and material ids.
 *
 * `availableDates` must come from availableStudyDates() in study-calendar.js —
 * it is the only thing that guarantees the first two properties above, and this
 * function does not re-derive them. Passing an arbitrary date list would produce
 * a schedule on arbitrary days.
 *
 * @param {object} input
 * @param {Array<object>} input.tasks validated model tasks, in model order
 * @param {Array<string>} input.availableDates ascending `YYYY-MM-DD`, already
 *   filtered to the learner's study days and bounded by the exam date
 * @param {number} input.dailyMinutes the per-day budget
 * @param {Map<string, number>} input.aliasToMaterialId MATERIAL_n → database id
 * @returns {{tasks: Array<object>, startDate: string, endDate: string,
 *   droppedTasks: number, clampedTasks: number} | null} null when nothing could
 *   be scheduled at all
 */
export function normalizePlan({
  tasks,
  availableDates,
  dailyMinutes,
  aliasToMaterialId,
}) {
  if (availableDates.length === 0) return null;

  const scheduled = [];
  let dateIndex = 0;
  let remaining = dailyMinutes;
  let position = 0;
  let droppedTasks = 0;
  let clampedTasks = 0;

  for (const task of tasks) {
    // §21. A 90-minute task for a learner with 60 minutes a day becomes a
    // 60-minute task rather than an error: the model's judgement about what to
    // cover survives, and the constraint the learner actually stated wins.
    let duration = task.durationMinutes;
    if (duration > dailyMinutes) {
      duration = dailyMinutes;
      clampedTasks += 1;
    }

    if (duration > remaining) {
      dateIndex += 1;
      if (dateIndex >= availableDates.length) {
        // Out of calendar. The current task and every one after it is dropped,
        // which is exactly the tasks not yet in `scheduled` — counted in one
        // step rather than by continuing the loop, because once the dates are
        // exhausted no later task can fit either.
        droppedTasks = tasks.length - scheduled.length;
        break;
      }
      remaining = dailyMinutes;
      position = 0;
    }

    scheduled.push({
      scheduledDate: availableDates[dateIndex],
      position,
      title: task.title,
      description: task.description,
      topic: task.topic,
      taskType: task.taskType,
      durationMinutes: duration,
      // The alias→id resolution, and the only place it happens. The map was
      // built by material-brief.js from materials the database confirmed this
      // user owns, so an id can only be one of theirs. `?? null` covers a task
      // the validator already stripped the alias from.
      materialId: task.material ? (aliasToMaterialId.get(task.material) ?? null) : null,
    });

    remaining -= duration;
    position += 1;
  }

  if (scheduled.length === 0) return null;

  if (droppedTasks > 0) {
    // A count, never the task text. Worth seeing: a model that routinely
    // overshoots by half is a prompt or a budget problem, and the difference
    // between "dropped 2" and "dropped 40" is the difference between rounding
    // and a plan that was never going to fit.
    logger.warn(
      `study plan: dropped ${droppedTasks} task(s) that did not fit before the exam date`,
    );
  }

  return {
    tasks: scheduled,
    startDate: scheduled[0].scheduledDate,
    endDate: scheduled[scheduled.length - 1].scheduledDate,
    droppedTasks,
    clampedTasks,
  };
}
