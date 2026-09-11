/**
 * Scheduling and AI-output unit tests — SP-V2-005 §40's "Scheduling" and
 * "AI output validation" groups.
 *
 * No database, no HTTP, no provider. Everything under test here is a pure
 * function, which is the point: the guarantees §11-§13 and §21-§22 describe are
 * arithmetic, and arithmetic can be checked exhaustively and instantly.
 *
 * THE PROPERTY THESE TESTS EXIST FOR
 * ----------------------------------
 * §13 says the backend owns the calendar. What that means concretely is four
 * invariants that must hold for EVERY task of EVERY plan, whatever the model
 * returns:
 *
 *   1. its date is one of the learner's study days;
 *   2. its date is on or before the exam date;
 *   3. its duration is between 1 and the daily budget;
 *   4. the total scheduled on any one date is at most the daily budget.
 *
 * `assertScheduleInvariants` below checks all four, and is applied to the output
 * of every normalizer case — including the adversarial ones. A test that only
 * checked the happy path would not be testing the claim.
 *
 *   node --test tests/study-plans/scheduling.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WEEKDAYS,
  addDays,
  availableStudyDates,
  daysBetween,
  isIsoDate,
  todayIso,
  weekdayOf,
} from "../../src/study-plans/study-calendar.js";
import { normalizePlan } from "../../src/study-plans/plan-normalizer.js";
import { validatePlanOutput } from "../../src/study-plans/plan-output.validator.js";

/** The four invariants, checked together because they are one claim. */
function assertScheduleInvariants(result, { studyDays, examDate, dailyMinutes }) {
  const perDate = new Map();

  for (const task of result.tasks) {
    assert.ok(
      studyDays.includes(weekdayOf(task.scheduledDate)),
      `${task.scheduledDate} is a ${weekdayOf(task.scheduledDate)}, not a study day`,
    );
    assert.ok(task.scheduledDate <= examDate, "task scheduled after the exam");
    assert.ok(task.durationMinutes >= 1, "non-positive duration");
    assert.ok(
      task.durationMinutes <= dailyMinutes,
      "single task longer than the daily budget",
    );
    perDate.set(
      task.scheduledDate,
      (perDate.get(task.scheduledDate) ?? 0) + task.durationMinutes,
    );
  }

  for (const [date, total] of perDate) {
    assert.ok(total <= dailyMinutes, `${date} is over budget: ${total}`);
  }
}

/** A validated-shaped task, so normalizer tests state only what they are about. */
function task(overrides = {}) {
  return {
    title: "Read chapter 4",
    description: "Work through the examples.",
    topic: "Photosynthesis",
    taskType: "study",
    durationMinutes: 30,
    material: null,
    ...overrides,
  };
}

describe("study-calendar: date handling", () => {
  it("accepts real dates and rejects impossible ones", () => {
    assert.equal(isIsoDate("2026-10-01"), true);
    assert.equal(isIsoDate("2024-02-29"), true, "2024 is a leap year");

    // The cases that matter: `new Date("2026-02-31")` silently rolls over to
    // 2026-03-03, so a regex alone would accept a date that does not exist.
    assert.equal(isIsoDate("2026-02-31"), false);
    assert.equal(isIsoDate("2025-02-29"), false, "2025 is not a leap year");
    assert.equal(isIsoDate("2026-13-01"), false);
    assert.equal(isIsoDate("2026-00-10"), false);
    assert.equal(isIsoDate("2026-10-32"), false);
  });

  it("rejects anything that is not a bare YYYY-MM-DD string", () => {
    for (const value of [
      "2026-10-1",
      "26-10-01",
      "2026/10/01",
      "2026-10-01T00:00:00Z",
      " 2026-10-01",
      "",
      null,
      undefined,
      20261001,
      new Date(),
    ]) {
      assert.equal(isIsoDate(value), false, `accepted ${String(value)}`);
    }
  });

  it("names weekdays from the UTC calendar", () => {
    // 2026-10-01 is a Thursday. Checked against a fixed known date rather than
    // recomputed, so a bug in the helper cannot agree with itself.
    assert.equal(weekdayOf("2026-10-01"), "thursday");
    assert.equal(weekdayOf("2026-10-03"), "saturday");
    assert.equal(weekdayOf("2026-10-04"), "sunday");
  });

  it("indexes WEEKDAYS by getUTCDay(), Sunday first", () => {
    // The ordering the whole module depends on: weekdayOf() indexes this array
    // with getUTCDay(), where Sunday is 0. Getting it wrong by one would shift
    // every learner's schedule by a day while still looking plausible, so it is
    // walked across seven consecutive dates starting from a known Sunday.
    assert.equal(WEEKDAYS.length, 7);
    assert.equal(WEEKDAYS[0], "sunday");

    for (const [offset, name] of WEEKDAYS.entries()) {
      assert.equal(weekdayOf(addDays("2026-10-04", offset)), name);
    }
    assert.ok(Object.isFrozen(WEEKDAYS), "the allowed set must not be mutable");
  });

  it("adds days across month and year boundaries", () => {
    assert.equal(addDays("2026-10-01", 1), "2026-10-02");
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2024-03-01", -1), "2024-02-29", "leap year");
  });

  it("counts whole days in both directions", () => {
    assert.equal(daysBetween("2026-10-01", "2026-10-01"), 0);
    assert.equal(daysBetween("2026-10-01", "2026-10-08"), 7);
    assert.equal(daysBetween("2026-10-08", "2026-10-01"), -7);
    // Across a DST transition in most of Europe/US. Both operands are UTC
    // midnights, so there is no 23-hour day to make this 6.958.
    assert.equal(daysBetween("2026-10-20", "2026-11-03"), 14);
  });

  it("returns today as a bare date string", () => {
    const today = todayIso();
    assert.equal(isIsoDate(today), true);
    assert.equal(today, new Date().toISOString().slice(0, 10));
  });
});

describe("study-calendar: available study dates (§13)", () => {
  it("returns only the weekdays the learner chose", () => {
    // 2026-10-01 is a Thursday; the range covers two full weeks.
    const dates = availableStudyDates({
      from: "2026-10-01",
      to: "2026-10-14",
      studyDays: ["monday", "wednesday"],
      maxDates: 100,
    });

    assert.deepEqual(dates, [
      "2026-10-05", // Monday
      "2026-10-07", // Wednesday
      "2026-10-12", // Monday
      "2026-10-14", // Wednesday
    ]);
  });

  it("never returns a weekend when weekends are excluded", () => {
    // §13's named case, checked over a three-month range rather than a week.
    const dates = availableStudyDates({
      from: "2026-01-01",
      to: "2026-03-31",
      studyDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      maxDates: 500,
    });

    assert.ok(dates.length > 60, "sanity: a quarter has plenty of weekdays");
    for (const date of dates) {
      const day = weekdayOf(date);
      assert.notEqual(day, "saturday");
      assert.notEqual(day, "sunday");
    }
  });

  it("includes both endpoints when they qualify", () => {
    const dates = availableStudyDates({
      from: "2026-10-05",
      to: "2026-10-12",
      studyDays: ["monday"],
      maxDates: 10,
    });
    assert.deepEqual(dates, ["2026-10-05", "2026-10-12"]);
  });

  it("returns nothing when the range contains no chosen weekday", () => {
    // Tuesday to Friday, studying only on Sundays.
    const dates = availableStudyDates({
      from: "2026-10-06",
      to: "2026-10-09",
      studyDays: ["sunday"],
      maxDates: 10,
    });
    assert.deepEqual(dates, []);
  });

  it("returns nothing when the exam is before the start", () => {
    const dates = availableStudyDates({
      from: "2026-10-10",
      to: "2026-10-01",
      studyDays: WEEKDAYS,
      maxDates: 10,
    });
    assert.deepEqual(dates, []);
  });

  it("returns a single date when the exam is today", () => {
    // The cramming case. One study date, not zero — a learner studying on the
    // day of the exam is a real request.
    const dates = availableStudyDates({
      from: "2026-10-01",
      to: "2026-10-01",
      studyDays: ["thursday"],
      maxDates: 10,
    });
    assert.deepEqual(dates, ["2026-10-01"]);
  });

  it("stops at maxDates", () => {
    const dates = availableStudyDates({
      from: "2026-01-01",
      to: "2030-12-31",
      studyDays: WEEKDAYS,
      maxDates: 12,
    });
    assert.equal(dates.length, 12);
    assert.equal(dates[0], "2026-01-01");
  });

  it("accepts a Set as well as an array", () => {
    const dates = availableStudyDates({
      from: "2026-10-01",
      to: "2026-10-07",
      studyDays: new Set(["monday"]),
      maxDates: 10,
    });
    assert.deepEqual(dates, ["2026-10-05"]);
  });
});

describe("plan-normalizer: the packing rule (§21, §22)", () => {
  const studyDays = ["monday", "wednesday", "friday"];
  const examDate = "2026-10-30";
  const dates = availableStudyDates({
    from: "2026-10-01",
    to: examDate,
    studyDays,
    maxDates: 365,
  });

  it("fills each day to the budget before moving to the next", () => {
    const result = normalizePlan({
      tasks: [task(), task(), task(), task()], // 4 × 30 = two 60-minute days
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.equal(result.tasks.length, 4);
    assert.deepEqual(
      result.tasks.map((t) => [t.scheduledDate, t.position]),
      [
        [dates[0], 0],
        [dates[0], 1],
        [dates[1], 0],
        [dates[1], 1],
      ],
    );
    assertScheduleInvariants(result, { studyDays, examDate, dailyMinutes: 60 });
  });

  it("reports the first and last scheduled dates", () => {
    const result = normalizePlan({
      tasks: [task(), task(), task()],
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.equal(result.startDate, dates[0]);
    assert.equal(result.endDate, dates[1]);
    assert.equal(result.startDate, result.tasks[0].scheduledDate);
  });

  it("clamps a task longer than the whole daily budget (§21)", () => {
    const result = normalizePlan({
      tasks: [task({ durationMinutes: 500 }), task({ durationMinutes: 500 })],
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.equal(result.clampedTasks, 2);
    assert.deepEqual(result.tasks.map((t) => t.durationMinutes), [60, 60]);
    // Each fills a whole day, so they land on consecutive study dates.
    assert.deepEqual(result.tasks.map((t) => t.scheduledDate), [dates[0], dates[1]]);
    assertScheduleInvariants(result, { studyDays, examDate, dailyMinutes: 60 });
  });

  it("moves a task that does not fit to the next study date (§22)", () => {
    const result = normalizePlan({
      // 40 + 40: the second cannot share a 60-minute day.
      tasks: [task({ durationMinutes: 40 }), task({ durationMinutes: 40 })],
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.deepEqual(result.tasks.map((t) => t.scheduledDate), [dates[0], dates[1]]);
    assert.deepEqual(result.tasks.map((t) => t.position), [0, 0]);
    assertScheduleInvariants(result, { studyDays, examDate, dailyMinutes: 60 });
  });

  it("drops the tail rather than scheduling past the exam date (§22)", () => {
    // Ten times more content than the calendar holds.
    const tasks = Array.from({ length: dates.length * 10 }, () =>
      task({ durationMinutes: 60 }),
    );
    const result = normalizePlan({
      tasks,
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.equal(result.tasks.length, dates.length, "one full day each");
    assert.equal(result.droppedTasks, tasks.length - dates.length);
    assert.equal(result.endDate, dates[dates.length - 1]);
    assertScheduleInvariants(result, { studyDays, examDate, dailyMinutes: 60 });
  });

  it("never returns a task on an excluded weekday, however many are supplied", () => {
    // The §13 claim, tested adversarially: 300 tasks against a calendar that
    // excludes weekends. If the packer ever advanced a date by arithmetic rather
    // than by stepping through `availableDates`, this is where it would show.
    const weekdayOnly = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    const workdays = availableStudyDates({
      from: "2026-10-01",
      to: "2026-12-31",
      studyDays: weekdayOnly,
      maxDates: 365,
    });
    const result = normalizePlan({
      tasks: Array.from({ length: 300 }, () => task({ durationMinutes: 25 })),
      availableDates: workdays,
      dailyMinutes: 50,
      aliasToMaterialId: new Map(),
    });

    assertScheduleInvariants(result, {
      studyDays: weekdayOnly,
      examDate: "2026-12-31",
      dailyMinutes: 50,
    });
  });

  it("schedules a single-day plan without overflowing it", () => {
    const result = normalizePlan({
      tasks: [task({ durationMinutes: 30 }), task({ durationMinutes: 30 }), task()],
      availableDates: ["2026-10-01"],
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });

    assert.equal(result.tasks.length, 2, "the third has nowhere to go");
    assert.equal(result.droppedTasks, 1);
    assert.equal(result.startDate, "2026-10-01");
    assert.equal(result.endDate, "2026-10-01");
  });

  it("returns null when there are no dates at all", () => {
    const result = normalizePlan({
      tasks: [task()],
      availableDates: [],
      dailyMinutes: 60,
      aliasToMaterialId: new Map(),
    });
    assert.equal(result, null);
  });

  it("resolves a material alias to the id the map holds (§20)", () => {
    const result = normalizePlan({
      tasks: [task({ material: "MATERIAL_1" }), task({ material: null })],
      availableDates: dates,
      dailyMinutes: 120,
      aliasToMaterialId: new Map([["MATERIAL_1", 42]]),
    });

    assert.equal(result.tasks[0].materialId, 42);
    assert.equal(result.tasks[1].materialId, null);
  });

  it("nulls an alias that is not in the map rather than inventing an id", () => {
    const result = normalizePlan({
      tasks: [task({ material: "MATERIAL_9" })],
      availableDates: dates,
      dailyMinutes: 60,
      aliasToMaterialId: new Map([["MATERIAL_1", 42]]),
    });

    assert.equal(result.tasks[0].materialId, null);
  });
});

describe("plan-output.validator: rejecting model output (§19)", () => {
  const options = { maxTasks: 200, maxTextChars: 200, aliases: new Set() };

  const validPlan = {
    title: "Biology revision",
    goal: "Understand photosynthesis before the exam.",
    tasks: [
      {
        title: "Read chapter 4",
        description: "Work through the examples.",
        topic: "Photosynthesis",
        taskType: "study",
        durationMinutes: 30,
      },
    ],
  };

  it("accepts a well-formed plan", () => {
    const result = validatePlanOutput(JSON.stringify(validPlan), options);
    assert.equal(result.title, "Biology revision");
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].durationMinutes, 30);
    assert.equal(result.inventedMaterialRefs, 0);
  });

  it("rejects output that is not JSON at all", () => {
    assert.equal(validatePlanOutput("Here is a plan, in prose.", options), null);
    assert.equal(validatePlanOutput("", options), null);
    assert.equal(validatePlanOutput("```json\n{broken", options), null);
  });

  it("rejects JSON that is not an object", () => {
    for (const raw of ["[]", '"a string"', "42", "null", "true"]) {
      assert.equal(validatePlanOutput(raw, options), null, `accepted ${raw}`);
    }
  });

  it("rejects a missing or blank title and goal", () => {
    for (const override of [
      { title: undefined },
      { title: "" },
      { title: "   " },
      { title: 42 },
      { goal: undefined },
      { goal: "  " },
    ]) {
      const raw = JSON.stringify({ ...validPlan, ...override });
      assert.equal(validatePlanOutput(raw, options), null, `accepted ${raw.slice(0, 60)}`);
    }
  });

  it("rejects an empty task list", () => {
    const raw = JSON.stringify({ ...validPlan, tasks: [] });
    assert.equal(validatePlanOutput(raw, options), null);
  });

  it("rejects a missing or non-array task list", () => {
    for (const tasks of [undefined, null, "none", {}, 5]) {
      const raw = JSON.stringify({ ...validPlan, tasks });
      assert.equal(validatePlanOutput(raw, options), null);
    }
  });

  it("rejects more tasks than the configured cap", () => {
    const raw = JSON.stringify({
      ...validPlan,
      tasks: Array.from({ length: 201 }, () => validPlan.tasks[0]),
    });
    assert.equal(validatePlanOutput(raw, options), null);
    // And accepts exactly the cap, so the boundary is not off by one.
    const atCap = JSON.stringify({
      ...validPlan,
      tasks: Array.from({ length: 200 }, () => validPlan.tasks[0]),
    });
    assert.equal(validatePlanOutput(atCap, options).tasks.length, 200);
  });

  it("rejects a task type outside the four allowed", () => {
    // Including `exam`, which §7 excludes and which is the value a model is
    // most likely to reach for.
    for (const taskType of ["exam", "quiz", "", null, 42, "Study"]) {
      const raw = JSON.stringify({
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], taskType }],
      });
      assert.equal(validatePlanOutput(raw, options), null, `accepted ${taskType}`);
    }
  });

  it("accepts each of the four task types", () => {
    for (const taskType of ["study", "review", "practice", "recap"]) {
      const raw = JSON.stringify({
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], taskType }],
      });
      assert.equal(validatePlanOutput(raw, options).tasks[0].taskType, taskType);
    }
  });

  it("rejects a duration that is not a positive whole number of minutes", () => {
    for (const durationMinutes of [
      0,
      -30,
      1441,
      30.5,
      "45",
      "45 minutes",
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const raw = JSON.stringify({
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], durationMinutes }],
      });
      assert.equal(
        validatePlanOutput(raw, options),
        null,
        `accepted ${String(durationMinutes)}`,
      );
    }
  });

  it("rejects a task that is not an object", () => {
    for (const entry of ["a task", 42, null, []]) {
      const raw = JSON.stringify({ ...validPlan, tasks: [entry] });
      assert.equal(validatePlanOutput(raw, options), null);
    }
  });

  it("rejects a task with a blank title", () => {
    const raw = JSON.stringify({
      ...validPlan,
      tasks: [{ ...validPlan.tasks[0], title: "   " }],
    });
    assert.equal(validatePlanOutput(raw, options), null);
  });
});

describe("plan-output.validator: clamping and dropping", () => {
  const options = { maxTasks: 200, maxTextChars: 200, aliases: new Set(["MATERIAL_1"]) };

  const base = {
    title: "Biology revision",
    goal: "Understand photosynthesis.",
    tasks: [
      {
        title: "Read chapter 4",
        description: "Examples.",
        topic: "Photosynthesis",
        taskType: "study",
        durationMinutes: 30,
      },
    ],
  };

  it("clamps over-long text rather than rejecting the plan", () => {
    const raw = JSON.stringify({
      ...base,
      title: "T".repeat(600),
      goal: "G".repeat(5000),
      tasks: [
        {
          ...base.tasks[0],
          title: "S".repeat(600),
          description: "D".repeat(5000),
          topic: "P".repeat(600),
        },
      ],
    });

    const result = validatePlanOutput(raw, options);
    assert.ok(result !== null, "a long title is not a broken plan");
    // The bounds match the CHECK constraints, so nothing here can fail on INSERT.
    assert.ok(result.title.length <= 200);
    assert.ok(result.goal.length <= 2000);
    assert.ok(result.tasks[0].title.length <= 200);
    assert.ok(result.tasks[0].description.length <= 2000);
    assert.ok(result.tasks[0].topic.length <= 200);
  });

  it("clamps at a word boundary when one is close to the limit", () => {
    const text = `${"word ".repeat(60)}final`;
    const raw = JSON.stringify({ ...base, title: text });
    const result = validatePlanOutput(raw, options);

    assert.ok(result.title.length <= 200);
    assert.doesNotMatch(result.title, / $/, "no trailing space");
    assert.doesNotMatch(result.title, /wor$/, "not cut mid-word");
  });

  it("cuts hard when there is no word boundary to use", () => {
    // A 600-character run with no space: the fallback matters, because this is
    // exactly what a malfunctioning response produces.
    const raw = JSON.stringify({ ...base, title: "X".repeat(600) });
    const result = validatePlanOutput(raw, options);
    assert.equal(result.title.length, 200);
  });

  it("nulls an absent, blank or wrong-typed description and topic", () => {
    for (const value of [undefined, null, "", "   ", 42, {}]) {
      const raw = JSON.stringify({
        ...base,
        tasks: [{ ...base.tasks[0], description: value, topic: value }],
      });
      const result = validatePlanOutput(raw, options);
      assert.ok(result !== null, "optional fields do not fail a plan");
      assert.equal(result.tasks[0].description, null);
      assert.equal(result.tasks[0].topic, null);
    }
  });

  it("keeps a material alias the prompt actually contained", () => {
    const raw = JSON.stringify({
      ...base,
      tasks: [{ ...base.tasks[0], material: "MATERIAL_1" }],
    });
    const result = validatePlanOutput(raw, options);
    assert.equal(result.tasks[0].material, "MATERIAL_1");
    assert.equal(result.inventedMaterialRefs, 0);
  });

  it("drops an invented alias but keeps the task (§20)", () => {
    const raw = JSON.stringify({
      ...base,
      tasks: [
        { ...base.tasks[0], material: "MATERIAL_99" },
        { ...base.tasks[0], material: "../../etc/passwd" },
        { ...base.tasks[0], material: "42" },
      ],
    });
    const result = validatePlanOutput(raw, options);

    assert.equal(result.tasks.length, 3, "the pedagogy survives");
    for (const t of result.tasks) assert.equal(t.material, null);
    assert.equal(result.inventedMaterialRefs, 3);
  });

  it("drops every alias when the plan had no materials at all", () => {
    // §37: a plan with no materials must still work, and every citation in one
    // is necessarily invented.
    const raw = JSON.stringify({
      ...base,
      tasks: [{ ...base.tasks[0], material: "MATERIAL_1" }],
    });
    const result = validatePlanOutput(raw, {
      ...options,
      aliases: new Set(),
    });

    assert.equal(result.tasks[0].material, null);
    assert.equal(result.inventedMaterialRefs, 1);
  });

  it("returns the alias, never a database id", () => {
    // The validator must not resolve aliases: that is the normalizer's job, and
    // splitting it this way is what keeps model output away from real ids.
    const raw = JSON.stringify({
      ...base,
      tasks: [{ ...base.tasks[0], material: "MATERIAL_1" }],
    });
    const result = validatePlanOutput(raw, options);
    assert.equal(typeof result.tasks[0].material, "string");
    assert.equal(result.tasks[0].materialId, undefined);
  });
});
