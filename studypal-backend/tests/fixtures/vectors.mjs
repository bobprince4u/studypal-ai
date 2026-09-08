/**
 * Deterministic embedding fixtures — SP-V2-004 §35's "controlled fixture vectors
 * so the expected nearest-neighbor ordering is known".
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A retrieval test that embeds text with a random or hash-derived function can
 * only assert "some results came back", because nobody knows what order 1536
 * pseudo-random floats should produce. §35 forbids exactly that test. But the
 * alternative — compute the expected order in JavaScript with the same cosine
 * function the assertion uses — is worse: it proves the test agrees with itself,
 * not that PostgreSQL ranked anything correctly.
 *
 * So the vectors here are built on an ORTHONORMAL BASIS. Each topic owns one
 * axis, one dimension of the 1536, and a text's vector is the normalized sum of
 * the axes for the topics it mentions. Cosine similarity between two such vectors
 * is then a fraction anyone can work out on paper:
 *
 *   same single topic         →  1.0        ("photosynthesis" vs "photosynthesis")
 *   disjoint topics           →  0.0        ("photosynthesis" vs "calculus")
 *   one shared of two         →  0.5        ({photo, mito} vs {photo, calc})
 *   one shared, one vs two    →  0.7071     ({photo} vs {photo, mito})   = 1/√2
 *   two shared of three       →  0.6667     ({p,m,c} vs {p,m})           = 2/(√3·√2)... see below
 *
 * The general rule, for unit vectors made of |A| and |B| distinct axes sharing
 * |A∩B| of them:
 *
 *   cos(A, B) = |A∩B| / (√|A| · √|B|)
 *
 * That single formula is the whole fixture design, and it is why the ordering
 * assertions in tests/materials/retrieval.test.js can be written as literal
 * expected sequences: the correct answer is derivable from the topic lists
 * without running any code.
 *
 * WHY THIS IS NOT CHEATING
 * ------------------------
 * The vectors are unrealistic — real embeddings are dense and no dimension means
 * "photosynthesis". That is deliberate and it costs nothing that matters here.
 * What is under test is the SQL: whether `<=>` is used, whether the ORDER BY is
 * ascending on distance, whether the threshold and LIMIT are applied, and whether
 * the user_id predicate is in the query. None of those depend on the vectors being
 * lifelike, and all of them are easier to catch when the expected output is exact.
 *
 * Semantic quality of the real model is not testable offline at all — that is
 * documented as deferred in docs/rag-architecture.md rather than faked here.
 *
 * USED BY
 * -------
 *   tests/helpers/fake-gemini.mjs      to answer :batchEmbedContents in-process
 *   tests/materials/retrieval.test.js  to seed chunk vectors directly through SQL
 *   tests/materials/rag.test.js        to predict which chunks a question retrieves
 */

/**
 * The width every fixture vector has.
 *
 * Must equal migrations/postgres/003_material_embeddings.sql's `vector(n)` and
 * STUDYPAL_EMBEDDING_DIM. Hard-coded rather than imported from src/config/env.js
 * on purpose: this module is loaded inside the fake-Gemini preload, which runs
 * before the application in a spawned server process, and a fixture that reads
 * application config could be made to agree with a wrong config. The agreement is
 * asserted instead — see tests/materials/schema.test.js.
 */
export const FIXTURE_DIMENSIONS = 1536;

/**
 * Topic → the axis it owns.
 *
 * Low indexes, contiguous, no gaps: nothing depends on the specific numbers, but
 * keeping them small makes a failing assertion's vector dump readable when a test
 * prints the first few components.
 *
 * The keys double as the KEYWORDS scanned for in text (case-insensitively), which
 * is what lets a test write ordinary-looking chunk content — "Photosynthesis
 * converts light into chemical energy" — and still know its exact vector.
 */
export const TOPIC_AXES = Object.freeze({
  photosynthesis: 0,
  mitochondria: 1,
  calculus: 2,
  osmosis: 3,
  glycolysis: 4,
  tectonics: 5,
});

/** Every topic name, in axis order. */
export const TOPICS = Object.freeze(
  Object.keys(TOPIC_AXES).sort((a, b) => TOPIC_AXES[a] - TOPIC_AXES[b]),
);

/**
 * The axis reserved for text that mentions no known topic.
 *
 * Deliberately the LAST dimension rather than another low one, so it can never be
 * confused with a topic axis in a debug dump, and deliberately a real axis rather
 * than the zero vector: a zero vector has no defined cosine distance to anything,
 * pgvector warns about it, and a test using one would be measuring undefined
 * behaviour rather than irrelevance. On this axis an unrelated text is exactly
 * orthogonal — similarity 0.0 — to every topic, which is what "irrelevant" should
 * mean.
 */
export const OFF_TOPIC_AXIS = FIXTURE_DIMENSIONS - 1;

/**
 * A unit vector along the axes of the given topics.
 *
 * @param {string[]} topics topic names from TOPIC_AXES; [] gives the off-topic axis
 * @returns {number[]} FIXTURE_DIMENSIONS numbers, magnitude 1
 */
export function topicVector(topics) {
  const axes = [];
  for (const topic of topics) {
    const axis = TOPIC_AXES[topic];
    if (axis === undefined) {
      // A typo in a topic name would otherwise produce a silently off-topic
      // vector and an ordering assertion that fails for a reason having nothing
      // to do with the code under test.
      throw new Error(
        `unknown fixture topic "${topic}" (have: ${TOPICS.join(", ")})`,
      );
    }
    if (!axes.includes(axis)) axes.push(axis);
  }

  const vector = new Array(FIXTURE_DIMENSIONS).fill(0);
  if (axes.length === 0) {
    vector[OFF_TOPIC_AXIS] = 1;
    return vector;
  }

  // 1/√n on each of n axes: magnitude √(n · 1/n) = 1.
  const component = 1 / Math.sqrt(axes.length);
  for (const axis of axes) vector[axis] = component;
  return vector;
}

/**
 * The topics a text mentions, in axis order.
 *
 * A plain substring scan, so "Photosynthesis" and "photosynthesis-dependent" both
 * count. Word boundaries are not required: fixture text is written by these tests,
 * and a stricter matcher would only add a way for a fixture to silently stop
 * matching.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function topicsIn(text) {
  const haystack = String(text).toLowerCase();
  return TOPICS.filter((topic) => haystack.includes(topic));
}

/**
 * The vector the fake provider returns for a text.
 *
 * The one function that defines the fake's behaviour, exported so a test can
 * predict a stored chunk's vector without duplicating the rule. Identical text
 * always yields an identical vector, which is what lets a test assert that
 * re-indexing unchanged content produces no change.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function fakeEmbedding(text) {
  return topicVector(topicsIn(text));
}

/**
 * Cosine similarity, for expressing an expectation — not for computing one.
 *
 * Present so a test can assert `similarity ≈ SHARED_ONE_OF_TWO` against a value
 * PostgreSQL returned, and so the constants below can be written as the formula
 * that produced them rather than as decimals. A test that used this to derive the
 * order it then asserts would be the tautology this file exists to avoid.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

/**
 * The similarities the basis produces, named.
 *
 * Written as the |A∩B| / (√|A| · √|B|) expression rather than as decimals so the
 * derivation is visible at the point of use, and rounded to the 4 decimal places
 * retrieval.service.js reports — a test comparing against 0.7071067811865475
 * would fail on a value the API deliberately truncates.
 */
export const SIMILARITY = Object.freeze({
  /** Same single topic. */
  IDENTICAL: 1,
  /** No shared axis. The off-topic axis against any topic, too. */
  ORTHOGONAL: 0,
  /** One topic against a chunk covering it and one other: 1 / (√1 · √2). */
  ONE_OF_TWO: round4(1 / Math.sqrt(2)),
  /** One topic against a chunk covering it and two others: 1 / (√1 · √3). */
  ONE_OF_THREE: round4(1 / Math.sqrt(3)),
  /** Two shared axes, both vectors two-topic: 2 / (√2 · √2). */
  TWO_OF_TWO: 1,
  /** Two shared, query has two and chunk three: 2 / (√2 · √3). */
  TWO_OF_THREE: round4(2 / (Math.sqrt(2) * Math.sqrt(3))),
});

/** Round to 4 decimals, matching retrieval.service.js's reported precision. */
export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A pgvector literal for a fixture vector, for tests that seed chunks via SQL.
 *
 * Duplicates src/utils/vector.js's toVectorLiteral deliberately: a test that
 * seeded its rows with the production serializer could not fail when that
 * serializer is wrong, and this is one line.
 *
 * @param {number[]} vector
 * @returns {string}
 */
export function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}
