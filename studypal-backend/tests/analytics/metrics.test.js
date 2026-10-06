/**
 * The deterministic analytics arithmetic — §21's calculation groups and §22's
 * required weak-area matrix.
 *
 * src/analytics/analytics.metrics.js is pure: no database, no request, no
 * clock, no provider. So it is tested directly and exhaustively here, the same
 * arrangement tests/exams/grading.test.js uses for the grader and for the same
 * reason — through HTTP each case below would cost a user, an exam, an attempt
 * and a submission, and a wrong threshold would be indistinguishable from a
 * wrong fixture.
 *
 * §22 NAMES EIGHT CASES AND THIS FILE ASSERTS ALL EIGHT
 * ----------------------------------------------------
 * They are in the "§22 the required weak-area matrix" block below, numbered as
 * §22 numbers them, plus the two boundary cases §9 spells out in prose —
 * 59.99% and 60.01% — because "strict comparison" is exactly the claim that a
 * `<=` typo would break while leaving 0% and 100% passing.
 *
 * WHAT THIS FILE CANNOT SHOW
 * --------------------------
 * That the counts came from the database, that the rows were scoped to one
 * learner, or that the API returns what these functions computed. Those are
 * properties of the integrated path: tests/analytics/repository.test.js and
 * tests/analytics/api.test.js.
 *
 *   node --test tests/analytics/metrics.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { config } from "../../src/config/env.js";
import {
  accuracyBreakdown,
  averageOf,
  byWeakness,
  compareRecentPerformance,
  isWeak,
  percentageOf,
  round2,
} from "../../src/analytics/analytics.metrics.js";

/** A topic row in the shape toTopicShape produces, for the weak-area rule. */
function topic(name, attempted, correct) {
  return {
    topic: name,
    ...accuracyBreakdown({ attempted, correct }),
  };
}

/** A topic row with an accuracy stated directly, for the boundary cases. */
function atAccuracy(name, questionsAttempted, accuracyPercentage) {
  return { topic: name, questionsAttempted, accuracyPercentage };
}

describe("§3 the one rounding rule", () => {
  it("is Math.round(value * 100) / 100 — two decimal places", () => {
    assert.equal(round2(66.666666), 66.67);
    assert.equal(round2(66.664), 66.66);
    assert.equal(round2(74.571428571), 74.57);
    assert.equal(round2(0), 0);
    assert.equal(round2(100), 100);
  });

  it("rounds half away from zero, which is where round differs from floor", () => {
    // A floor-based implementation gives 66.66 here and passes every
    // whole-number case above. This is the discriminator.
    assert.equal(round2(66.665), 66.67);
    assert.equal(round2(12.345), 12.35);
  });

  it("never returns NaN or Infinity (§18)", () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, "12"]) {
      assert.equal(round2(bad), null, String(bad));
    }
  });
});

describe("§3 percentages over an empty set", () => {
  it("is null for a zero denominator, never NaN or Infinity", () => {
    // The zero-task plan §3 calls out by name. 0/0 is NaN and 1/0 is Infinity;
    // both are forbidden by §18, and both are what a bare division gives.
    assert.equal(percentageOf(0, 0), null);
    assert.equal(percentageOf(5, 0), null);
    assert.equal(percentageOf(0, -1), null);
  });

  it("distinguishes 'no data' from 'measured as zero'", () => {
    // The distinction the whole null-vs-zero decision exists for: a learner who
    // has attempted nothing is not the same as one who got everything wrong.
    assert.equal(percentageOf(0, 0), null);
    assert.equal(percentageOf(0, 10), 0);
  });

  it("computes the ordinary cases through the rounding rule", () => {
    assert.equal(percentageOf(27, 42), 64.29);
    assert.equal(percentageOf(8, 12), 66.67);
    assert.equal(percentageOf(3, 4), 75);
    assert.equal(percentageOf(10, 10), 100);
  });
});

describe("§3 averages over an empty set", () => {
  it("is null for an empty list", () => {
    assert.equal(averageOf([]), null);
    assert.equal(averageOf(undefined), null);
    assert.equal(averageOf(null), null);
  });

  it("averages and rounds by the one rule", () => {
    assert.equal(averageOf([70, 80]), 75);
    assert.equal(averageOf([91, 52, 74, 68, 88]), 74.6);
    // 522/7 = 74.5714285714… → 74.57
    assert.equal(averageOf([91, 52, 74, 68, 88, 81, 68]), 74.57);
  });

  it("returns null rather than NaN when a value is not finite", () => {
    assert.equal(averageOf([70, NaN]), null);
    assert.equal(averageOf([70, null]), null);
  });
});

describe("§7 the accuracy breakdown", () => {
  it("derives incorrect so the three numbers always agree", () => {
    // correct + incorrect === questionsAttempted, by construction. A second
    // COUNT FILTER in SQL could disagree with the total; a subtraction cannot.
    for (const [attempted, correct] of [[12, 8], [3, 0], [10, 10], [1, 1]]) {
      const row = accuracyBreakdown({ attempted, correct });
      assert.equal(
        row.correct + row.incorrect,
        row.questionsAttempted,
        `${correct}/${attempted}`,
      );
    }
  });

  it("matches §7's worked example exactly", () => {
    assert.deepEqual(accuracyBreakdown({ attempted: 12, correct: 8 }), {
      questionsAttempted: 12,
      correct: 8,
      incorrect: 4,
      accuracyPercentage: 66.67,
    });
  });

  it("gives a null accuracy and zero counts for an empty topic (§18)", () => {
    assert.deepEqual(accuracyBreakdown({ attempted: 0, correct: 0 }), {
      questionsAttempted: 0,
      correct: 0,
      incorrect: 0,
      accuracyPercentage: null,
    });
  });
});

describe("§9 the thresholds come from config, not from literals", () => {
  it("defaults to MIN_TOPIC_ATTEMPTS = 3 and WEAK_ACCURACY = 60", () => {
    // §9's recommended initial values. Asserted so that changing the default in
    // src/config/env.js is a deliberate act with a failing test attached,
    // rather than a silent reclassification of every learner's weak areas.
    assert.equal(config.analytics.minTopicAttempts, 3);
    assert.equal(config.analytics.weakTopicAccuracyThreshold, 60);
  });

  it("honours injected thresholds, so the rule is testable at any setting", () => {
    const row = atAccuracy("Algebra", 2, 10);

    assert.equal(isWeak(row), false, "not weak at the default floor of 3");
    assert.equal(
      isWeak(row, { minTopicAttempts: 2 }),
      true,
      "weak once two attempts is enough evidence",
    );
    assert.equal(
      isWeak(atAccuracy("Algebra", 5, 70), { weakThreshold: 80 }),
      true,
      "weak once the threshold is raised above it",
    );
  });
});

describe("§22 the required weak-area matrix", () => {
  it("1. two attempts at 0% is NOT weak", () => {
    // Insufficient evidence, not strength. Two wrong answers is not a finding.
    assert.equal(isWeak(topic("Algebra", 2, 0)), false);
  });

  it("2. three attempts at 0% IS weak", () => {
    assert.equal(isWeak(topic("Algebra", 3, 0)), true);
  });

  it("3. three attempts below 60% IS weak", () => {
    // 1/3 = 33.33
    assert.equal(isWeak(topic("Algebra", 3, 1)), true);
    // 5/9 = 55.56
    assert.equal(isWeak(topic("Algebra", 9, 5)), true);
  });

  it("4. exactly 60% is NOT weak", () => {
    // 3/5 = 60 exactly, and 6/10 = 60 exactly. The strict `<` is the whole
    // difference between this case and case 3, and a `<=` typo fails only here.
    assert.equal(isWeak(topic("Algebra", 5, 3)), false);
    assert.equal(isWeak(topic("Algebra", 10, 6)), false);
    assert.equal(isWeak(atAccuracy("Algebra", 3, 60)), false);
  });

  it("5. above 60% is NOT weak", () => {
    assert.equal(isWeak(atAccuracy("Algebra", 3, 60.01)), false);
    // 7/10 = 70
    assert.equal(isWeak(topic("Algebra", 10, 7)), false);
  });

  it("6. 100% is NOT weak", () => {
    assert.equal(isWeak(topic("Algebra", 8, 8)), false);
  });

  it("7. no attempts is NOT weak", () => {
    // accuracyPercentage is null here, and `null < 60` is true in JavaScript —
    // so a rule that compared before checking would report every untouched
    // topic as a weakness. That is the bug this case exists to catch.
    assert.equal(isWeak(topic("Algebra", 0, 0)), false);
    assert.equal(isWeak(atAccuracy("Algebra", 0, null)), false);
    assert.equal(isWeak(atAccuracy("Algebra", 5, null)), false);
    assert.equal(isWeak(atAccuracy("Algebra", 5, undefined)), false);
  });

  it("59.99% IS weak and 60% is not — §9's stated boundary", () => {
    assert.equal(isWeak(atAccuracy("Algebra", 3, 59.99)), true);
    assert.equal(isWeak(atAccuracy("Algebra", 3, 60)), false);
  });

  it("8. multiple weak topics order deterministically", () => {
    // §10's three keys: lowest accuracy, then highest question count, then
    // topic name. Built deliberately out of order, and with two ties, so a
    // single-key sort cannot produce this sequence.
    const rows = [
      topic("Trigonometry", 10, 5), //  50.00, 10 questions
      topic("Algebra", 4, 0), //         0.00,  4 questions
      topic("Calculus", 20, 10), //     50.00, 20 questions
      topic("Geometry", 8, 0), //        0.00,  8 questions
      topic("Statistics", 10, 5), //    50.00, 10 questions — ties Trigonometry
    ];

    assert.deepEqual(
      byWeakness(rows).map((row) => row.topic),
      [
        // 0% first; Geometry ahead of Algebra on question count
        "Geometry",
        "Algebra",
        // then 50%; Calculus ahead on question count, then S before T by name
        "Calculus",
        "Statistics",
        "Trigonometry",
      ],
    );
  });

  it("orders identically whatever order the rows arrive in", () => {
    // The property "deterministic" actually claims: PostgreSQL does not promise
    // an order for equal GROUP BY keys, so the sort must not depend on the
    // input sequence. A stable sort without a total order would pass the test
    // above and fail this one.
    const rows = [
      topic("Statistics", 10, 5),
      topic("Trigonometry", 10, 5),
      topic("Calculus", 10, 5),
    ];
    const expected = ["Calculus", "Statistics", "Trigonometry"];

    assert.deepEqual(byWeakness(rows).map((r) => r.topic), expected);
    assert.deepEqual(
      byWeakness([...rows].reverse()).map((r) => r.topic),
      expected,
    );
  });

  it("does not mutate the array it was given", () => {
    const rows = [topic("B", 5, 0), topic("A", 5, 0)];
    const before = rows.map((r) => r.topic);

    byWeakness(rows);

    assert.deepEqual(rows.map((r) => r.topic), before);
  });
});

describe("§6 the recent-performance comparison", () => {
  it("reports nothing from one attempt", () => {
    // §6: "Do not infer a trend from one attempt." All four fields null, not an
    // absent object — a client reads trend.direction without an existence check.
    assert.deepEqual(compareRecentPerformance([80]), {
      recentAveragePercentage: null,
      previousAveragePercentage: null,
      difference: null,
      direction: null,
    });
  });

  it("reports nothing from no attempts", () => {
    assert.equal(compareRecentPerformance([]).direction, null);
    assert.equal(compareRecentPerformance([]).difference, null);
    assert.equal(compareRecentPerformance(undefined).direction, null);
  });

  it("needs four completed attempts before a direction appears", () => {
    // window = min(5, floor(n/2)), and minTrendWindow is 2. So three attempts
    // give a window of 1, which is below the floor; four give a window of 2.
    assert.equal(compareRecentPerformance([80, 70, 60]).direction, null);
    assert.equal(compareRecentPerformance([80, 70, 60, 50]).direction, "up");
  });

  it("compares equal-sized windows, newest first", () => {
    // [90, 80] against [60, 50]: 85 vs 55, difference +30.
    assert.deepEqual(compareRecentPerformance([90, 80, 60, 50]), {
      recentAveragePercentage: 85,
      previousAveragePercentage: 55,
      difference: 30,
      direction: "up",
    });
  });

  it("caps the window at trendWindow and keeps both sides equal", () => {
    // Twelve attempts, cap 5: the newest 5 against the preceding 5, and the two
    // oldest are ignored. The alternative reading of §6 — "latest 5 vs all the
    // rest" — would give unequal weights, which is why the cap applies to both.
    const recent = [100, 100, 100, 100, 100];
    const previous = [50, 50, 50, 50, 50];
    const ignored = [0, 0];

    assert.deepEqual(
      compareRecentPerformance([...recent, ...previous, ...ignored]),
      {
        recentAveragePercentage: 100,
        previousAveragePercentage: 50,
        difference: 50,
        direction: "up",
      },
    );
  });

  it("never compares a five-attempt average against a one-attempt average", () => {
    // Six attempts. A literal "latest 5 vs preceding 5" gives 5-vs-1, where one
    // unlucky exam dominates a number presented as a trend. Halving gives 3-vs-3.
    const trend = compareRecentPerformance([80, 80, 80, 20, 20, 20]);

    assert.equal(trend.recentAveragePercentage, 80);
    assert.equal(trend.previousAveragePercentage, 20);
    assert.equal(trend.difference, 60);
  });

  it("calls a fall 'down' and a level result 'flat'", () => {
    assert.equal(compareRecentPerformance([50, 50, 90, 90]).direction, "down");
    assert.equal(compareRecentPerformance([50, 50, 90, 90]).difference, -40);

    // "flat" rather than null: the comparison WAS made, and its answer is "no
    // change". null is reserved for "not enough data to compare".
    const flat = compareRecentPerformance([70, 70, 70, 70]);
    assert.equal(flat.direction, "flat");
    assert.equal(flat.difference, 0);
  });

  it("rounds the difference by the one rule", () => {
    // [70, 71] = 70.5 against [60, 61] = 60.5 → 10
    assert.equal(compareRecentPerformance([70, 71, 60, 61]).difference, 10);
    // [67, 68, 69] = 68 against [61, 62, 64] = 62.33 → 5.67
    const trend = compareRecentPerformance([67, 68, 69, 61, 62, 64]);
    assert.equal(trend.recentAveragePercentage, 68);
    assert.equal(trend.previousAveragePercentage, 62.33);
    assert.equal(trend.difference, 5.67);
  });

  it("never returns NaN, Infinity or undefined (§18)", () => {
    for (let n = 0; n <= 14; n += 1) {
      const trend = compareRecentPerformance(
        Array.from({ length: n }, (_, i) => (i * 7) % 101),
      );

      for (const [field, value] of Object.entries(trend)) {
        assert.ok(
          value === null || typeof value === "number" || typeof value === "string",
          `${field} at n=${n} was ${String(value)}`,
        );
        if (typeof value === "number") {
          assert.ok(Number.isFinite(value), `${field} at n=${n} not finite`);
        }
      }
    }
  });

  it("uses no language of prediction", () => {
    // §6: "Avoid language suggesting prediction. This is historical
    // comparison, not future prediction." The DTO's own field names are the
    // surface a client sees, so they are the ones asserted.
    const keys = Object.keys(compareRecentPerformance([90, 80, 60, 50]));

    assert.deepEqual(keys, [
      "recentAveragePercentage",
      "previousAveragePercentage",
      "difference",
      "direction",
    ]);
    for (const key of keys) {
      assert.doesNotMatch(key, /predict|forecast|expect|will|risk/i);
    }
  });
});
