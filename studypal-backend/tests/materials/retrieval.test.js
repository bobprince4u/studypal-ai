/**
 * Retrieval — SP-V2-004 §35 (relevance ordering), §36 (user isolation) and §40
 * (the database does the work).
 *
 * §35 is explicit that "do not write retrieval tests that merely assert 'some
 * results returned'", and the whole design of this file follows from taking that
 * seriously. Two things make it possible:
 *
 *   tests/fixtures/vectors.mjs gives every topic its own axis, so the cosine
 *   similarity between a question and a chunk is |A∩B| / (√|A| · √|B|) — a
 *   fraction derivable on paper. The expected ORDER is therefore written into each
 *   test as a literal sequence, not computed by re-running the code under test.
 *
 *   The fixture corpus is seeded in an order that DISAGREES with every wrong
 *   answer. Below, document order is 0,1,2,3,4 and the correct relevance order is
 *   2,4,0 — so a query that forgot its ORDER BY, or sorted by insertion, or by id,
 *   or descending instead of ascending, fails. That is the property §35 is really
 *   asking for: the assertion has to be able to fail.
 *
 * Vectors are written straight into the column with SQL rather than generated
 * through the provider, so a chunk's vector is a fact of the fixture rather than a
 * consequence of two other layers working. tests/materials/embeddings.test.js
 * covers the path that produces them.
 *
 *   node --test tests/materials/retrieval.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { useIsolatedDatabase } from "../helpers/test-database.mjs";
import {
  SIMILARITY,
  fakeEmbedding,
  topicVector,
  vectorLiteral,
} from "../fixtures/vectors.mjs";

// ── wiring: see tests/materials/embeddings.test.js for why this order ────────

const database = await useIsolatedDatabase({ label: "retrieval" });
process.env.GEMINI_API_KEY ||= "fake-key-for-tests";
process.env.FAKE_EMBEDDING_MODE = "ok";

await import("../helpers/fake-gemini.mjs");

const { config } = await import("../../src/config/env.js");
const db = await import("../../src/config/database.js");
const { setEmbeddingProvider } = await import("../../src/ai/embedding.service.js");
const { searchSimilarChunks } = await import(
  "../../src/materials/retrieval.repository.js"
);
const { resolveTopK, retrieveRelevantChunks } = await import(
  "../../src/materials/retrieval.service.js"
);

assert.equal(
  config.database.url,
  database.url,
  "the application pool must be pointing at this suite's isolated database",
);

after(async () => {
  await db.closeDatabase();
  await database.drop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let keySequence = 0;

async function makeUser(prefix) {
  const { rows } = await db.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [`${prefix}_${(keySequence += 1)}_${Date.now().toString(36)}`],
  );
  return rows[0].id;
}

/**
 * A `ready`, `indexed` material whose chunks already carry fixture vectors.
 *
 * Each entry is `{topics, page}`: `topics` decides the vector (and therefore the
 * chunk's exact similarity to any question), `page` the page number that should
 * come back as a citation. Content is generated from the topics so it reads like
 * study material and so a test can recognise a chunk in a failure message.
 *
 * `topics: null` means a chunk that exists with text but has NO vector — a
 * material caught mid-indexing. `topics: []` means text that mentions no topic at
 * all, which gets the off-topic axis and is exactly orthogonal to every question.
 * The two are different states and retrieval must treat them differently.
 *
 * @param {number} userId
 * @param {Array<{topics: string[]|null, page?: number|null}>} chunks
 */
async function makeIndexedMaterial(userId, chunks, { filename = "notes.txt" } = {}) {
  const { rows } = await db.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size,
             status, indexing_status)
     VALUES ($1, $2, $3, 'text/plain', 2048, 'ready', 'indexed')
     RETURNING id`,
    [userId, filename, `${(keySequence += 1).toString(16).padStart(32, "0")}.txt`],
  );
  const materialId = rows[0].id;

  for (const [index, chunk] of chunks.entries()) {
    const topics = chunk.topics ?? [];
    const content =
      topics.length > 0
        ? `This section covers ${topics.join(" and ")}.`
        : "This section is an unrelated administrative note.";

    await db.query(
      `INSERT INTO material_chunks
              (material_id, chunk_index, content, char_count, page_number, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [
        materialId,
        index,
        content,
        content.length,
        chunk.page ?? null,
        // NULL stays NULL: a chunk with no vector must be unreachable by
        // retrieval, and `topics: null` is how a test asks for one.
        chunk.topics === null ? null : vectorLiteral(topicVector(topics)),
      ],
    );
  }

  return materialId;
}

/** The query vector for a question, exactly as the fake provider would produce it. */
function questionVector(question) {
  return fakeEmbedding(question);
}

/** Repository search with the fixture's defaults filled in. */
function search({ userId, materialId = null, question, limit = 10, threshold = 0.5 }) {
  return searchSimilarChunks({
    userId,
    materialId,
    embedding: questionVector(question),
    limit,
    threshold,
  });
}

/** `[chunk_index, …]` — the shape every ordering assertion is written in. */
function order(rows) {
  return rows.map((row) => row.chunk_index);
}

// ── §35: relevance ordering ─────────────────────────────────────────────────
describe("similarity ordering", () => {
  let userId;
  let materialId;

  /**
   * The corpus, and its whole point: document order is NOT relevance order.
   *
   * Against the question "photosynthesis" (a unit vector on the photosynthesis
   * axis), the similarity of each chunk follows from |A∩B| / (√|A| · √|B|):
   *
   *   index 0  {photosynthesis, mitochondria, calculus}  1/√3 = 0.5774
   *   index 1  {mitochondria}                            0      (orthogonal)
   *   index 2  {photosynthesis}                          1.0
   *   index 3  {}  → the off-topic axis                  0      (orthogonal)
   *   index 4  {photosynthesis, mitochondria}            1/√2 = 0.7071
   *
   * So the correct answer at the default threshold is [2, 4, 0], which is not
   * document order (0,1,2,3,4), not reverse document order, not id order, and not
   * what a descending sort would give (0,4,2). Every plausible wrong query
   * produces a different sequence.
   */
  before(async () => {
    userId = await makeUser("order");
    materialId = await makeIndexedMaterial(userId, [
      { topics: ["photosynthesis", "mitochondria", "calculus"], page: 7 },
      { topics: ["mitochondria"], page: 8 },
      { topics: ["photosynthesis"], page: 2 },
      { topics: [], page: null },
      { topics: ["photosynthesis", "mitochondria"], page: 4 },
    ]);
  });

  it("returns the most similar chunk first", async () => {
    const rows = await search({ userId, question: "explain photosynthesis" });

    assert.deepEqual(order(rows), [2, 4, 0]);
    // And the scores are the fractions the basis predicts, not merely descending.
    assert.deepEqual(
      rows.map((row) => Math.round(row.similarity * 10_000) / 10_000),
      [SIMILARITY.IDENTICAL, SIMILARITY.ONE_OF_TWO, SIMILARITY.ONE_OF_THREE],
    );
  });

  it("orders by a different question differently", async () => {
    // The same five rows, a different question, a different correct order — so the
    // previous assertion cannot be satisfied by a fixed sequence that happens to
    // match. Against {mitochondria}: index 1 is identical (1.0), index 4 shares
    // one of two (0.7071), index 0 one of three (0.5774), and the photosynthesis-
    // only chunk is orthogonal.
    const rows = await search({ userId, question: "how do mitochondria work" });

    assert.deepEqual(order(rows), [1, 4, 0]);
  });

  it("counts a question mentioning two topics against both", async () => {
    // {photosynthesis, mitochondria} as the question:
    //   index 4 {p,m}      → 2/(√2·√2) = 1.0
    //   index 0 {p,m,c}    → 2/(√2·√3) = 0.8165
    //   index 2 {p}        → 1/(√2·√1) = 0.7071
    //   index 1 {m}        → 1/(√2·√1) = 0.7071  — tied with index 2
    const rows = await search({
      userId,
      question: "compare photosynthesis and mitochondria",
    });

    assert.deepEqual(order(rows), [4, 0, 1, 2]);
    assert.deepEqual(
      rows.map((row) => Math.round(row.similarity * 10_000) / 10_000),
      [
        SIMILARITY.TWO_OF_TWO,
        SIMILARITY.TWO_OF_THREE,
        SIMILARITY.ONE_OF_TWO,
        SIMILARITY.ONE_OF_TWO,
      ],
    );
    // The tie between 1 and 2 broke on chunk_index, which is the tie-break the
    // query names — 1 before 2 rather than whichever the scan reached first.
  });

  it("enforces the requested limit in the database", async () => {
    const rows = await search({ userId, question: "photosynthesis", limit: 2 });

    // The two BEST, not the first two found: a LIMIT applied before the sort would
    // return [0, 1] here.
    assert.deepEqual(order(rows), [2, 4]);
  });

  it("drops everything below the threshold", async () => {
    assert.deepEqual(
      order(await search({ userId, question: "photosynthesis", threshold: 0.6 })),
      [2, 4],
      "0.5774 does not clear 0.6",
    );
    assert.deepEqual(
      order(await search({ userId, question: "photosynthesis", threshold: 0.99 })),
      [2],
    );
    assert.deepEqual(
      order(await search({ userId, question: "photosynthesis", threshold: 1.01 })),
      [],
      "nothing is more similar than identical",
    );
  });

  it("orders the orthogonal remainder deterministically", async () => {
    // Threshold 0 admits the two orthogonal chunks, which are exactly tied at 0.0.
    // Their order is decided by the query's tie-break, not by the heap, so the
    // sequence is stable across runs — which is what keeps §35's ordering tests
    // from being flaky rather than wrong.
    const rows = await search({ userId, question: "photosynthesis", threshold: 0 });

    assert.deepEqual(order(rows), [2, 4, 0, 1, 3]);

    const repeated = await search({
      userId,
      question: "photosynthesis",
      threshold: 0,
    });
    assert.deepEqual(order(repeated), order(rows), "and it is the same every time");
  });

  it("returns nothing for a question the corpus does not cover", async () => {
    // Empty is a first-class result, not an error and not a fallback: it is how the
    // chat path knows to say so instead of asking Gemini (§21).
    const rows = await search({ userId, question: "explain plate tectonics" });
    assert.deepEqual(rows, []);
  });

  it("carries exactly the citation fields a source needs, and nothing more", async () => {
    const [best] = await search({ userId, question: "photosynthesis" });

    assert.deepEqual(Object.keys(best).sort(), [
      "chunk_id",
      "chunk_index",
      "content",
      "filename",
      "material_id",
      "page_number",
      "similarity",
    ]);
    assert.equal(best.material_id, materialId);
    assert.equal(best.page_number, 2, "the page a citation points at");
    assert.equal(best.filename, "notes.txt");
    assert.match(best.content, /photosynthesis/);
    // No embedding, no user_id, no storage_key. Asserted exactly, so a future
    // `SELECT c.*` shows up here rather than in a response body.
  });

  it("reports a null page number rather than omitting it", async () => {
    const rows = await search({ userId, question: "photosynthesis", threshold: 0 });
    const offTopic = rows.find((row) => row.chunk_index === 3);
    assert.equal(offTopic.page_number, null);
  });
});

// ── §35: a chunk with no vector is not searchable ───────────────────────────
describe("chunks without an embedding", () => {
  it("never match, whatever the question", async () => {
    const userId = await makeUser("unindexed");
    await makeIndexedMaterial(userId, [
      { topics: null, page: 1 }, // extracted, chunked, not yet embedded
      { topics: ["calculus"], page: 2 },
    ]);

    // Even at threshold 0, where everything else qualifies.
    const rows = await search({ userId, question: "calculus", threshold: 0 });

    assert.deepEqual(order(rows), [1]);
    // The point being that a material mid-indexing contributes its finished
    // chunks rather than nothing — and contributes nothing for the unfinished ones
    // rather than a zero vector that would rank ahead of a real near-miss.
  });
});

// ── §36: user isolation ─────────────────────────────────────────────────────
describe("user isolation", () => {
  let alice;
  let bob;
  let aliceMaterial;
  let bobMaterial;

  before(async () => {
    alice = await makeUser("alice");
    bob = await makeUser("bob");

    // Deliberately IDENTICAL content and therefore identical vectors. If ownership
    // were enforced anywhere other than the query, both would score 1.0 against the
    // same question and there would be nothing about the data to separate them.
    aliceMaterial = await makeIndexedMaterial(
      alice,
      [{ topics: ["photosynthesis"], page: 1 }],
      { filename: "alice-biology.txt" },
    );
    bobMaterial = await makeIndexedMaterial(
      bob,
      [{ topics: ["photosynthesis"], page: 1 }],
      { filename: "bob-biology.txt" },
    );
  });

  it("gives Alice her own chunks and no others", async () => {
    const rows = await search({ userId: alice, question: "photosynthesis" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].material_id, aliceMaterial);
    assert.equal(rows[0].filename, "alice-biology.txt");
  });

  it("gives Bob his own, from the same question", async () => {
    const rows = await search({ userId: bob, question: "photosynthesis" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].material_id, bobMaterial);
  });

  it("returns nothing when Alice names Bob's material", async () => {
    // Not an error — zero rows. "Absent" and "not yours" are indistinguishable
    // through this path, so it cannot be used to probe for other people's
    // materials.
    const rows = await search({
      userId: alice,
      materialId: bobMaterial,
      question: "photosynthesis",
    });

    assert.deepEqual(rows, []);
  });

  it("is enforced by the SQL, not by a filter afterwards", async () => {
    // §36: "do not rely solely on application-level filtering. Verify the SQL query
    // itself enforces the relationship." The counter-assertion is what gives the
    // three tests above their meaning — it proves the fixture really does contain a
    // chunk that a missing predicate would have returned.
    const { rows: withoutOwnership } = await db.query(
      `SELECT c.id
         FROM material_chunks c
         JOIN materials m ON m.id = c.material_id
        WHERE c.embedding IS NOT NULL
          AND 1 - (c.embedding <=> $1::vector) >= 0.99
          AND c.material_id IN ($2, $3)`,
      [vectorLiteral(topicVector(["photosynthesis"])), aliceMaterial, bobMaterial],
    );

    assert.equal(
      withoutOwnership.length,
      2,
      "the same search without the user predicate reaches both users' chunks",
    );

    const owned = await search({ userId: alice, question: "photosynthesis" });
    assert.equal(owned.length, 1, "and the repository's version reaches one");
  });

  it("scopes to one material without ever widening past the user", async () => {
    // Two materials for one user: the material filter narrows, and the user
    // predicate is not part of the same OR as anything, so it cannot be traded away.
    const second = await makeIndexedMaterial(
      alice,
      [{ topics: ["calculus"], page: 3 }],
      { filename: "alice-maths.txt" },
    );

    const userWide = await search({
      userId: alice,
      question: "photosynthesis and calculus",
      threshold: 0.6,
    });
    assert.deepEqual(
      userWide.map((row) => row.filename).sort(),
      ["alice-biology.txt", "alice-maths.txt"],
      "user-wide scope spans her materials",
    );

    const scoped = await search({
      userId: alice,
      materialId: second,
      question: "photosynthesis and calculus",
      threshold: 0.6,
    });
    assert.deepEqual(scoped.map((row) => row.filename), ["alice-maths.txt"]);
  });

  it("returns nothing for a material id that does not exist", async () => {
    const rows = await search({
      userId: alice,
      materialId: 9_999_999,
      question: "photosynthesis",
    });
    assert.deepEqual(rows, []);
  });
});

// ── §28: a malformed query vector fails, and fails before it reaches a row ──
describe("a malformed query embedding", () => {
  let userId;

  before(async () => {
    userId = await makeUser("malformed");
    await makeIndexedMaterial(userId, [{ topics: ["photosynthesis"], page: 1 }]);
  });

  /** Search with a raw vector, bypassing the service's validation. */
  function searchRaw(embedding) {
    return searchSimilarChunks({
      userId,
      materialId: null,
      embedding,
      limit: 5,
      threshold: 0.5,
    });
  }

  it("is rejected by pgvector when the width is wrong", async () => {
    // The last line of defence, after src/ai/embedding.service.js's check: even a
    // caller that skipped validation cannot get a mis-sized vector compared against
    // stored data.
    //
    // Note WHERE the refusal comes from. `$2::vector` is a cast to the
    // *unconstrained* type, so a three-element literal parses fine — a mis-sized
    // query vector is not caught the way a mis-sized stored vector is, where the
    // column's `vector(1536)` typmod rejects it ("expected 1536 dimensions, not
    // 3"). What refuses this is the `<=>` operator itself, on the first stored
    // vector it is asked to compare against. Which means the refusal depends on
    // there being a row to compare with: against an empty corpus the same bad
    // vector returns zero rows and no error. That is why the service validates
    // before calling, and why this is a backstop rather than the check.
    await assert.rejects(
      () => searchRaw([0.1, 0.2, 0.3]),
      /different vector dimensions 1536 and 3/,
    );
  });

  it("is rejected when a component is not finite", async () => {
    const withNaN = topicVector(["photosynthesis"]);
    withNaN[5] = Number.NaN;
    await assert.rejects(() => searchRaw(withNaN), /NaN not allowed in vector/);

    const withInfinity = topicVector(["photosynthesis"]);
    withInfinity[5] = Number.POSITIVE_INFINITY;
    await assert.rejects(
      () => searchRaw(withInfinity),
      /infinite value not allowed in vector/,
    );
  });

  it("throws rather than returning a partial or empty result set", async () => {
    // The distinction §33 depends on: a broken query is not "nothing relevant was
    // found". If this returned [] the chat path would tell a student their material
    // does not cover the question, which would be a lie about their document rather
    // than an error about our software.
    await assert.rejects(() => searchRaw([1, 2]));

    const healthy = await search({ userId, question: "photosynthesis" });
    assert.equal(healthy.length, 1, "and the same search still works afterwards");
  });

  it("never reaches the database through the service, whatever the provider returns", async () => {
    // Closing the gap the first test's comment names. pgvector only objects to a
    // mis-sized query vector when it has a row to compare against, so the check
    // that actually holds is src/ai/embedding.service.js's — and this asserts it
    // holds for the retrieval path specifically.
    //
    // The stub declares the right width and then returns the wrong one, which is
    // the realistic provider misbehaviour: a truncated or malformed response body.
    // (Validation is against what the provider CLAIMS to produce, not against the
    // column — the agreement between the two is a separate assertion, in
    // tests/materials/embeddings.test.js, and this test would be meaningless if it
    // quietly moved that goalpost.)
    const restore = setEmbeddingProvider({
      get model() {
        return "stub";
      },
      get dimensions() {
        return config.rag.embeddingDimensions;
      },
      get maxBatchSize() {
        return 1;
      },
      async embedDocuments(texts) {
        return texts.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    });

    let reachedDatabase = false;
    const pool = db.getPool();
    const realQuery = pool.query.bind(pool);
    pool.query = (sql, values) => {
      if (typeof sql === "string" && sql.includes("<=>")) reachedDatabase = true;
      return realQuery(sql, values);
    };

    try {
      await assert.rejects(
        () => retrieveRelevantChunks({ userId, question: "explain photosynthesis" }),
        /query embedding: expected 1536 dimensions, got 2/,
      );
    } finally {
      pool.query = realQuery;
      restore();
    }

    assert.equal(
      reachedDatabase,
      false,
      "the vector must be validated before any SQL runs — §28's 'fail safely, do " +
        "not persist corrupt vector data', applied to the read path",
    );
  });
});

// ── §13: the service clamps what a request may ask for ─────────────────────
describe("resolveTopK", () => {
  it("defaults to the configured topK", () => {
    assert.equal(resolveTopK(undefined), config.rag.topK);
    assert.equal(resolveTopK(null), config.rag.topK);
  });

  it("honours a smaller request", () => {
    assert.equal(resolveTopK(1), 1);
    assert.equal(resolveTopK(3), 3);
  });

  it("caps a larger one at the server's maximum", () => {
    // §13: "do not allow an arbitrary request to control unrestricted topK". A
    // request for the whole corpus gets the most the server will serve, because
    // topK is a hint about how much context is wanted and refusing over a tuning
    // parameter would be a worse API than clamping.
    assert.equal(resolveTopK(config.rag.maxTopK + 1), config.rag.maxTopK);
    assert.equal(resolveTopK(10_000), config.rag.maxTopK);
    assert.equal(resolveTopK(Number.MAX_SAFE_INTEGER), config.rag.maxTopK);
  });

  it("treats a malformed request as absent rather than as a smaller one", () => {
    for (const bad of [0, -3, 2.5, "3", true, Number.NaN, Infinity, [], {}]) {
      assert.equal(resolveTopK(bad), config.rag.topK, `for ${JSON.stringify(bad)}`);
    }
  });
});

// ── the service's own contract ──────────────────────────────────────────────
describe("retrieveRelevantChunks", () => {
  let userId;
  let materialId;

  before(async () => {
    userId = await makeUser("service");
    materialId = await makeIndexedMaterial(
      userId,
      [
        { topics: ["photosynthesis", "mitochondria", "calculus"], page: 7 },
        { topics: ["mitochondria"], page: 8 },
        { topics: ["photosynthesis"], page: 2 },
      ],
      { filename: "biology-notes.txt" },
    );
  });

  it("embeds the question and returns chunks in the application's vocabulary", async () => {
    const result = await retrieveRelevantChunks({
      userId,
      question: "explain photosynthesis",
    });

    assert.equal(result.topK, config.rag.topK);
    assert.equal(result.threshold, config.rag.similarityThreshold);
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.chunkIndex),
      [2, 0],
      "1.0 then 0.5774; the mitochondria-only chunk is orthogonal",
    );

    assert.deepEqual(Object.keys(result.chunks[0]).sort(), [
      "chunkId",
      "chunkIndex",
      "content",
      "filename",
      "materialId",
      "pageNumber",
      "similarity",
    ]);
    assert.equal(result.chunks[0].materialId, materialId);
    assert.equal(result.chunks[0].filename, "biology-notes.txt");
    assert.equal(result.chunks[0].pageNumber, 2);
  });

  it("rounds similarity to the precision the API reports", async () => {
    const { chunks } = await retrieveRelevantChunks({
      userId,
      question: "explain photosynthesis",
    });

    assert.deepEqual(
      chunks.map((chunk) => chunk.similarity),
      [SIMILARITY.IDENTICAL, SIMILARITY.ONE_OF_THREE],
    );
    // Rounded, so an assertion or a client comparing scores is not defeated by the
    // seventeenth digit of a float.
    for (const chunk of chunks) {
      assert.equal(chunk.similarity, Math.round(chunk.similarity * 10_000) / 10_000);
    }
  });

  it("clamps topK before it reaches the database", async () => {
    const result = await retrieveRelevantChunks({
      userId,
      question: "explain photosynthesis and mitochondria and calculus",
      topK: 10_000,
    });

    assert.equal(result.topK, config.rag.maxTopK);
    assert.ok(result.chunks.length <= config.rag.maxTopK);
  });

  it("honours a smaller topK", async () => {
    const result = await retrieveRelevantChunks({
      userId,
      question: "explain photosynthesis and mitochondria",
      topK: 1,
    });

    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].chunkIndex, 0, "the {p,m,c} chunk at 0.8165");
  });

  it("asks the provider for a QUERY embedding, not a document one", async () => {
    // The asymmetry that makes retrieval land a question near its answer rather
    // than near other questions. Asserted at the wire, because it is the kind of
    // parameter that can be silently dropped by a refactor with no test noticing.
    const calls = [];
    const installed = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("googleapis.com")) calls.push(JSON.parse(init.body));
      return installed(input, init);
    };

    try {
      await retrieveRelevantChunks({ userId, question: "explain photosynthesis" });
    } finally {
      globalThis.fetch = installed;
    }

    assert.equal(calls.length, 1, "one question is one embedding request");
    assert.deepEqual(
      calls[0].requests.map((request) => request.taskType),
      ["RETRIEVAL_QUERY"],
    );
  });

  it("propagates a provider failure instead of reporting no evidence", async () => {
    // §33: "do not convert provider failures into 'no relevant information'".
    process.env.FAKE_EMBEDDING_MODE = "http-error";
    try {
      await assert.rejects(() =>
        retrieveRelevantChunks({ userId, question: "explain photosynthesis" }),
      );
    } finally {
      process.env.FAKE_EMBEDDING_MODE = "ok";
    }

    const recovered = await retrieveRelevantChunks({
      userId,
      question: "explain photosynthesis",
    });
    assert.ok(recovered.chunks.length > 0);
  });

  it("returns an empty result, not an error, when nothing is relevant", async () => {
    const result = await retrieveRelevantChunks({
      userId,
      question: "explain plate tectonics",
    });

    assert.deepEqual(result.chunks, []);
    assert.equal(result.threshold, config.rag.similarityThreshold);
  });
});

// ── §40: the database does the searching ────────────────────────────────────
describe("the query plan", () => {
  let userId;
  let recorded;

  before(async () => {
    userId = await makeUser("plan");
    // More chunks than the limit, all above the threshold, so a bounded result is
    // a bound rather than a coincidence.
    await makeIndexedMaterial(
      userId,
      Array.from({ length: 12 }, (_, i) => ({
        topics: i % 2 === 0 ? ["photosynthesis"] : ["photosynthesis", "mitochondria"],
        page: i + 1,
      })),
    );

    // Capture the statement the repository actually sends, rather than restating it
    // here: a copy of the SQL in this file would go on passing after the real query
    // changed, which is the one thing a plan assertion must not do.
    const pool = db.getPool();
    const realQuery = pool.query.bind(pool);
    pool.query = (sql, values) => {
      if (typeof sql === "string" && sql.includes("<=>")) {
        recorded = { sql, values };
      }
      return realQuery(sql, values);
    };
    try {
      await search({ userId, question: "photosynthesis", limit: 4 });
    } finally {
      pool.query = realQuery;
    }

    assert.ok(recorded, "the retrieval statement was not captured");
  });

  it("bounds the result count in SQL", async () => {
    const rows = await search({ userId, question: "photosynthesis", limit: 4 });
    assert.equal(rows.length, 4, "12 chunks qualify; 4 came back");

    const plan = await explain();
    assert.ok(
      nodeTypes(plan).includes("Limit"),
      "the plan must contain a Limit node — the bound belongs to the database, " +
        "not to a slice() in Node",
    );
  });

  it("filters on user_id inside the query", async () => {
    const plan = JSON.stringify(await explain());
    assert.match(
      plan,
      /user_id/,
      "ownership must appear in the plan; if it does not, it is being applied in " +
        "JavaScript over rows that were already fetched",
    );
  });

  it("computes and orders distances in the database", async () => {
    const plan = JSON.stringify(await explain());

    assert.match(plan, /<=>/, "pgvector evaluates the distance");
    assert.match(
      plan,
      /"Sort Key":[^\]]*<=>|"Index Cond":[^"]*<=>|"Order By":[^"]*<=>/,
      "and orders by it — §11 forbids pulling chunks into Node to score them",
    );
  });

  it("does not read the whole corpus per question", async () => {
    // With a fixture this small PostgreSQL will sequentially scan whatever it likes
    // and be right to; §12 documents that exact search is intentional at this size
    // and that ANN indexing is deliberately deferred. What matters, and what this
    // asserts, is that the number of rows crossing the wire is the limit rather
    // than the corpus.
    const plan = await explainAnalyze();
    const top = plan[0].Plan;

    assert.equal(top["Node Type"], "Limit");
    assert.ok(
      top["Actual Rows"] <= 4,
      `the top node returned ${top["Actual Rows"]} rows for a limit of 4`,
    );
  });

  /** EXPLAIN the captured statement with its captured parameters. */
  async function explain() {
    const { rows } = await db.query(
      `EXPLAIN (FORMAT JSON) ${recorded.sql}`,
      recorded.values,
    );
    return rows[0]["QUERY PLAN"];
  }

  async function explainAnalyze() {
    const { rows } = await db.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${recorded.sql}`,
      recorded.values,
    );
    return rows[0]["QUERY PLAN"];
  }

  /** Every node type in a plan tree, flattened. */
  function nodeTypes(plan) {
    const found = [];
    const walk = (node) => {
      if (!node) return;
      found.push(node["Node Type"]);
      for (const child of node.Plans ?? []) walk(child);
    };
    for (const entry of plan) walk(entry.Plan);
    return found;
  }
});
