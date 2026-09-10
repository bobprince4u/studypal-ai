/**
 * Embeddings — SP-V2-004 §34's "Embedding tests", plus the §8 and §9 guarantees.
 *
 * Three layers, in one file because they are one story:
 *
 *   src/ai/embedding.service.js       batching, normalization, validation
 *   src/ai/gemini.client.js           the request shape and the response contract
 *   src/materials/embedding.repository.js  + material-indexing.service.js
 *                                     what actually lands in PostgreSQL
 *
 * IN-PROCESS, WITH A REAL DATABASE — the first suite in this repository to be
 * both. The material API suite is a black box over a spawned server, which is
 * right for a contract but cannot reach a provider seam or assert that a failed
 * batch left no vector behind. So this file imports the application's own modules
 * and points its connection pool at a private migrated database.
 *
 * That requires care, and the top-level block below is the whole of it:
 * useIsolatedDatabase provisions a private database and claims it as the
 * application's own, in the one order that works — src/config/env.js reads
 * process.env once, at module initialization, and provisioning loads it. Every
 * application import here is therefore dynamic and happens afterwards, and the
 * pool is then asserted to be pointing at the isolated database and nowhere else:
 * a test that writes to a developer's real database is not a failure that can be
 * apologised for after the fact.
 *
 * NO LIVE GEMINI (§34). tests/helpers/fake-gemini.mjs is imported for its side
 * effect — it patches globalThis.fetch — so the real @google/genai client, the
 * real request construction and the real response parsing all run, and only the
 * network is fake. Its FAKE_EMBEDDING_MODE is read per request, so a test can
 * change failure mode between calls without restarting anything.
 *
 *   node --test tests/materials/embeddings.test.js
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { useIsolatedDatabase } from "../helpers/test-database.mjs";
import {
  FIXTURE_DIMENSIONS,
  fakeEmbedding,
  topicVector,
} from "../fixtures/vectors.mjs";

// ── wiring, before the application reads its configuration ──────────────────

// useIsolatedDatabase provisions a private migrated database AND sets NODE_ENV and
// STUDYPAL_TEST_DATABASE_URL to it, in that order, before anything under src/ has
// been loaded. The order is not optional: env.js resolves the database URL once at
// import, and provisioning itself loads env.js transitively — so a suite that
// provisioned first and set the variable afterwards would silently run against the
// shared template. See the helper's docstring.
const database = await useIsolatedDatabase({ label: "embedsvc" });
// The fake never checks the key, but `new GoogleGenAI({apiKey})` requires one to
// be a non-empty string.
process.env.GEMINI_API_KEY ||= "fake-key-for-tests";
process.env.FAKE_EMBEDDING_MODE = "ok";

// Patches globalThis.fetch as a side effect. Imported before the SDK is used, not
// before it is loaded: @google/genai reads the global at call time.
await import("../helpers/fake-gemini.mjs");

const { config } = await import("../../src/config/env.js");
const db = await import("../../src/config/database.js");
const { embedContents } = await import("../../src/ai/gemini.client.js");
const {
  embedDocuments,
  embedQuery,
  embeddingInfo,
  setEmbeddingProvider,
} = await import("../../src/ai/embedding.service.js");
const embeddingRepository = await import(
  "../../src/materials/embedding.repository.js"
);
const { indexMaterial, reindexMaterial } = await import(
  "../../src/materials/material-indexing.service.js"
);

// The guard. If the wiring above ever stops working — a renamed variable, a
// changed resolution order — this fails on the first test rather than quietly
// running the whole suite against DATABASE_URL.
assert.equal(
  config.database.url,
  database.url,
  "the application pool must be pointing at this suite's isolated database",
);
assert.match(database.name, /test/, "and that database must be a test database");

after(async () => {
  await db.closeDatabase();
  await database.drop();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let keySequence = 0;

/** Insert a user and return its id. */
async function makeUser(prefix) {
  const { rows } = await db.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [`${prefix}_${(keySequence += 1)}_${Date.now().toString(36)}`],
  );
  return rows[0].id;
}

/**
 * A `ready` material with `contents.length` chunks, none embedded.
 *
 * Chunk text comes from the caller so a test can control which fixture topic each
 * chunk lands on — the whole point of tests/fixtures/vectors.mjs.
 */
async function makeMaterial(contents, { filename = "notes.txt" } = {}) {
  const userId = await makeUser("embed");
  const { rows } = await db.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size, status)
     VALUES ($1, $2, $3, 'text/plain', 1024, 'ready')
     RETURNING id`,
    [
      userId,
      filename,
      `${(keySequence += 1).toString(16).padStart(32, "0")}.txt`,
    ],
  );
  const materialId = rows[0].id;

  for (const [index, content] of contents.entries()) {
    await db.query(
      `INSERT INTO material_chunks (material_id, chunk_index, content, char_count)
       VALUES ($1, $2, $3, $4)`,
      [materialId, index, content, content.length],
    );
  }

  return { userId, materialId };
}

/** Every chunk of a material: index, whether it has a vector, and the vector. */
async function chunkState(materialId) {
  const { rows } = await db.query(
    `SELECT chunk_index, content, embedding IS NOT NULL AS embedded, embedding
       FROM material_chunks
      WHERE material_id = $1
      ORDER BY chunk_index`,
    [materialId],
  );
  return rows;
}

/** A material's indexing lifecycle columns. */
async function indexingState(materialId) {
  const { rows } = await db.query(
    "SELECT status, indexing_status, indexing_error FROM materials WHERE id = $1",
    [materialId],
  );
  return rows[0];
}

/** Parse pgvector's text output back into numbers. */
function parseVector(text) {
  return JSON.parse(text);
}

/** Euclidean magnitude, for asserting that something was normalized. */
function magnitude(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

/**
 * Count Gemini requests, and capture them, around one action.
 *
 * Wraps whatever fetch is currently installed rather than replacing it, so the
 * fake still answers. This is how "Gemini was NOT called" is asserted as a fact
 * about the network rather than as a fact about a mock nobody configured.
 */
async function recordingFetch(action) {
  const calls = [];
  const installed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.includes("googleapis.com")) {
      let body;
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      } catch {
        body = undefined;
      }
      calls.push({ url, body });
    }
    return installed(input, init);
  };
  try {
    const result = await action();
    return { result, calls };
  } finally {
    globalThis.fetch = installed;
  }
}

/** A provider stub for the embedding service's own seam. */
function stubProvider({ dimensions = FIXTURE_DIMENSIONS, embed, query } = {}) {
  const batches = [];
  const provider = {
    model: "stub-model",
    dimensions,
    maxBatchSize: 2,
    batches,
    async embedDocuments(texts) {
      batches.push([...texts]);
      return embed ? embed(texts) : texts.map((text) => fakeEmbedding(text));
    },
    async embedQuery(text) {
      batches.push([text]);
      return query ? query(text) : fakeEmbedding(text);
    },
  };
  return provider;
}

let restoreProvider = null;
beforeEach(() => {
  // Every test starts from the real provider and the happy-path fake. A test that
  // swaps either is responsible for nothing, because this runs before the next one.
  restoreProvider?.();
  restoreProvider = null;
  process.env.FAKE_EMBEDDING_MODE = "ok";
});

/** Install a stub provider for the current test. */
function useProvider(provider) {
  restoreProvider = setEmbeddingProvider(provider);
  return provider;
}

// ── §29, §42: one authoritative configuration ──────────────────────────────
describe("the embedding configuration is the one the column was built for", () => {
  it("agrees with the migrated column width", async () => {
    // The check migrations/postgres/003_material_embeddings.sql promises is
    // asserted here. It is not a formality: the two numbers live in different
    // files, in different languages, and a disagreement produces a PostgreSQL
    // error on every single insert with nothing before that point noticing.
    const { rows } = await db.query(
      `SELECT a.atttypmod AS declared_width
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'material_chunks' AND a.attname = 'embedding'`,
    );
    // pgvector stores the declared dimension in atttypmod directly, with none of
    // the VARHDRSZ offset a varchar would carry.
    assert.equal(rows[0].declared_width, config.rag.embeddingDimensions);
    assert.equal(config.rag.embeddingDimensions, FIXTURE_DIMENSIONS);
  });

  it("pins the model that returns one vector per input", () => {
    // gemini-embedding-001, not gemini-embedding-2. The distinction is not
    // detectable at runtime — embedding-2 returns a single aggregated vector for a
    // batch, and nothing about the response shape says so — so the model name is
    // pinned here and the reasoning lives in src/config/env.js. A future upgrade
    // has to come through this assertion and read it.
    assert.equal(config.rag.embeddingModel, "gemini-embedding-001");
    assert.deepEqual(embeddingInfo(), {
      model: "gemini-embedding-001",
      dimensions: config.rag.embeddingDimensions,
      maxBatchSize: config.rag.embeddingBatchSize,
    });
  });
});

// ── §5, §10: the request the client actually sends ─────────────────────────
describe("the Gemini embedding request", () => {
  it("asks the configured model for the configured width, per input", async () => {
    const { result, calls } = await recordingFetch(() =>
      embedContents({
        texts: ["photosynthesis", "mitochondria"],
        taskType: "RETRIEVAL_DOCUMENT",
      }),
    );

    assert.equal(calls.length, 1, "one batch is one request");
    assert.match(calls[0].url, /gemini-embedding-001:batchEmbedContents/);
    assert.equal(calls[0].body.requests.length, 2);
    for (const request of calls[0].body.requests) {
      assert.equal(request.taskType, "RETRIEVAL_DOCUMENT");
      assert.equal(request.outputDimensionality, config.rag.embeddingDimensions);
      assert.match(request.model, /gemini-embedding-001/);
    }
    assert.equal(result.length, 2);
  });

  it("distinguishes a document from a question by taskType", async () => {
    // The asymmetry that makes retrieval work rather than merely run. Embedding
    // both sides as RETRIEVAL_DOCUMENT clusters questions with questions, which
    // returns results and returns the wrong ones — the failure no assertion about
    // "results were returned" can catch.
    const { calls } = await recordingFetch(async () => {
      await embedDocuments(["photosynthesis in leaves"]);
      await embedQuery("where does photosynthesis happen");
    });

    assert.deepEqual(
      calls.map((call) => call.body.requests[0].taskType),
      ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"],
    );
  });

  it("rejects a response with no embeddings array", async () => {
    process.env.FAKE_EMBEDDING_MODE = "malformed";
    await assert.rejects(
      () => embedContents({ texts: ["anything"], taskType: "RETRIEVAL_QUERY" }),
      /no embeddings array/,
    );
  });

  it("rejects a response with the wrong number of embeddings", async () => {
    // Positional mapping is how vectors are matched to chunks, so a count mismatch
    // cannot be reconciled — it can only be detected. Accepting it would attach
    // every chunk's vector to its neighbour and produce a corpus that retrieves
    // confidently and wrongly with no error anywhere.
    process.env.FAKE_EMBEDDING_MODE = "count-mismatch";
    await assert.rejects(
      () =>
        embedContents({
          texts: ["osmosis", "glycolysis", "tectonics"],
          taskType: "RETRIEVAL_DOCUMENT",
        }),
      /returned 2 embeddings for 3 inputs/,
    );
  });

  it("propagates a provider HTTP failure rather than returning nothing", async () => {
    process.env.FAKE_EMBEDDING_MODE = "http-error";
    await assert.rejects(() =>
      embedContents({ texts: ["anything"], taskType: "RETRIEVAL_QUERY" }),
    );
  });
});

// ── §6, §10, §28: the embedding service ────────────────────────────────────
describe("embedDocuments", () => {
  it("returns one vector per input, in input order", async () => {
    const texts = ["about photosynthesis", "about calculus", "about osmosis"];
    const vectors = await embedDocuments(texts);

    assert.equal(vectors.length, 3);
    // Identity, not just shape: the fixture vectors are distinguishable, so this
    // asserts that vector i belongs to text i. A silent reordering is the one
    // embedding bug that produces no error and no visibly wrong output.
    assert.deepEqual(vectors[0], topicVector(["photosynthesis"]));
    assert.deepEqual(vectors[1], topicVector(["calculus"]));
    assert.deepEqual(vectors[2], topicVector(["osmosis"]));
  });

  it("splits into batches of maxBatchSize and keeps global order", async () => {
    const provider = useProvider(stubProvider()); // maxBatchSize 2
    const texts = [
      "photosynthesis",
      "mitochondria",
      "calculus",
      "osmosis",
      "glycolysis",
    ];
    const vectors = await embedDocuments(texts);

    assert.deepEqual(provider.batches, [
      ["photosynthesis", "mitochondria"],
      ["calculus", "osmosis"],
      ["glycolysis"],
    ]);
    assert.equal(vectors.length, 5);
    assert.deepEqual(vectors[4], topicVector(["glycolysis"]));
  });

  it("makes no request at all for an empty list", async () => {
    const provider = useProvider(stubProvider());
    assert.deepEqual(await embedDocuments([]), []);
    assert.deepEqual(provider.batches, []);
  });

  it("normalizes to unit length", async () => {
    // Mandatory for this model below 3072 dimensions — Google documents truncated
    // Matryoshka output as un-normalized — and the property every stored vector is
    // assumed to have. A provider returning a long vector must not produce a long
    // stored vector.
    useProvider(
      stubProvider({
        embed: (texts) =>
          texts.map(() => {
            const raw = new Array(FIXTURE_DIMENSIONS).fill(0);
            raw[0] = 3;
            raw[1] = 4; // magnitude 5
            return raw;
          }),
      }),
    );

    const [vector] = await embedDocuments(["anything"]);
    assert.ok(Math.abs(magnitude(vector) - 1) < 1e-12, `magnitude ${magnitude(vector)}`);
    assert.ok(Math.abs(vector[0] - 0.6) < 1e-12);
    assert.ok(Math.abs(vector[1] - 0.8) < 1e-12);
  });

  it("rejects a vector of the wrong width, naming which one", async () => {
    useProvider(
      stubProvider({
        embed: (texts) =>
          texts.map((text, i) =>
            i === 1 ? [1, 2, 3] : fakeEmbedding(text),
          ),
      }),
    );

    await assert.rejects(
      () => embedDocuments(["photosynthesis", "calculus"]),
      // The GLOBAL index, not the position in its batch: "text 1 of this batch" is
      // not actionable when there are four batches.
      /embedding for text 1: expected 1536 dimensions, got 3/,
    );
  });

  it("rejects NaN and Infinity, naming the offending index", async () => {
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY]) {
      useProvider(
        stubProvider({
          embed: (texts) =>
            texts.map((text) => {
              const values = fakeEmbedding(text);
              values[42] = poison;
              return values;
            }),
        }),
      );

      await assert.rejects(
        () => embedDocuments(["photosynthesis"]),
        /value at index 42 is not a finite number/,
      );
      restoreProvider?.();
      restoreProvider = null;
    }
  });

  it("rejects a batch that returned the wrong number of vectors", async () => {
    useProvider(stubProvider({ embed: (texts) => texts.slice(1).map(fakeEmbedding) }));
    await assert.rejects(
      () => embedDocuments(["photosynthesis", "calculus"]),
      /returned 1 vectors for 2 texts/,
    );
  });

  it("fails whole rather than returning a partial result", async () => {
    // §9's all-or-nothing. A caller that received "the first 40 of 60 worked" would
    // have to decide what to do with a two-thirds-indexed material, and the wrong
    // decision — marking it searchable — is the one that looks fine.
    let call = 0;
    useProvider(
      stubProvider({
        embed: (texts) => {
          call += 1;
          if (call === 2) throw new Error("second batch is down");
          return texts.map(fakeEmbedding);
        },
      }),
    );

    await assert.rejects(
      () => embedDocuments(["photosynthesis", "calculus", "osmosis", "glycolysis"]),
      /second batch is down/,
    );
    assert.equal(call, 2, "and it stopped there rather than trying the third");
  });
});

describe("embedQuery", () => {
  it("returns one validated, normalized vector", async () => {
    const vector = await embedQuery("what is photosynthesis");
    assert.equal(vector.length, config.rag.embeddingDimensions);
    assert.deepEqual(vector, topicVector(["photosynthesis"]));
  });

  it("refuses an empty or non-string question", async () => {
    for (const bad of ["", "   ", null, undefined, 42, ["question"]]) {
      await assert.rejects(() => embedQuery(bad), TypeError);
    }
  });

  it("validates the provider's answer exactly as the document path does", async () => {
    useProvider(stubProvider({ query: () => [0.1, 0.2] }));
    await assert.rejects(
      () => embedQuery("anything"),
      /query embedding: expected 1536 dimensions, got 2/,
    );
  });
});

// ── §8: nothing is embedded twice ──────────────────────────────────────────
describe("indexing does not repeat work", () => {
  it("embeds every chunk of a fresh material and marks it indexed", async () => {
    const { materialId } = await makeMaterial([
      "photosynthesis converts light into chemical energy",
      "mitochondria produce ATP",
    ]);

    const result = await indexMaterial({ materialId });

    assert.deepEqual(result, {
      materialId,
      indexed: true,
      embedded: 2,
      skipped: 0,
      failed: false,
    });
    const state = await indexingState(materialId);
    assert.equal(state.indexing_status, "indexed");
    assert.equal(state.indexing_error, null);
    assert.equal(state.status, "ready", "the processing lifecycle is untouched");

    const chunks = await chunkState(materialId);
    assert.deepEqual(chunks.map((c) => c.embedded), [true, true]);
    // The vector that was stored is the vector for THAT chunk's text.
    assert.deepEqual(
      parseVector(chunks[0].embedding),
      topicVector(["photosynthesis"]),
    );
    assert.deepEqual(
      parseVector(chunks[1].embedding),
      topicVector(["mitochondria"]),
    );
  });

  it("makes no provider request for an already indexed material", async () => {
    // §8, and the cheapest possible reading of it: `embedding IS NULL` finds no
    // chunk, so there is nothing to send. Asserted at the network, because the
    // point is that no quota is spent — not that a function returned early.
    const { materialId } = await makeMaterial(["photosynthesis in leaves"]);
    await indexMaterial({ materialId });

    const { result, calls } = await recordingFetch(() =>
      indexMaterial({ materialId }),
    );

    assert.deepEqual(calls, [], "Gemini must not be called again");
    assert.deepEqual(result, {
      materialId,
      indexed: true,
      embedded: 0,
      skipped: 1,
      failed: false,
    });
  });

  it("embeds only the chunks added since the last run", async () => {
    const { materialId } = await makeMaterial(["photosynthesis in leaves"]);
    await indexMaterial({ materialId });
    const [first] = await chunkState(materialId);

    // A chunk appearing after indexing: what a re-processed document looks like.
    await db.query(
      `INSERT INTO material_chunks (material_id, chunk_index, content, char_count)
       VALUES ($1, 1, 'calculus is about limits', 24)`,
      [materialId],
    );
    // Its material is `indexed`, and markIndexing refuses to move that state, so
    // a resumed run needs the material back in an eligible one — which is what
    // saveEmbeddingsAndMarkIndexed would have left it in had the chunk existed
    // during the first run. Set explicitly here to test the resumption itself.
    await db.query(
      "UPDATE materials SET indexing_status = 'pending' WHERE id = $1",
      [materialId],
    );

    const { result, calls } = await recordingFetch(() =>
      indexMaterial({ materialId }),
    );

    assert.equal(result.embedded, 1, "only the new chunk");
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].body.requests.map((r) => r.content.parts[0].text),
      ["calculus is about limits"],
      "the already-embedded chunk was not sent",
    );

    const chunks = await chunkState(materialId);
    assert.deepEqual(
      parseVector(chunks[0].embedding),
      parseVector(first.embedding),
      "and the first chunk's stored vector is byte-identical to before",
    );
  });

  it("will not claim a material that is already indexing", async () => {
    const { materialId } = await makeMaterial(["photosynthesis"]);
    await db.query(
      "UPDATE materials SET indexing_status = 'indexing' WHERE id = $1",
      [materialId],
    );

    const { result, calls } = await recordingFetch(() =>
      indexMaterial({ materialId }),
    );

    assert.equal(result.indexed, false);
    assert.equal(result.embedded, 0);
    assert.deepEqual(calls, [], "two concurrent runs must not both pay for the same chunks");
  });

  it("reports a chunkless material as not indexed", async () => {
    // A material whose extraction failed has nothing to search, and calling that
    // `indexed` would put a searchable-looking, contentless document in a list.
    const { materialId } = await makeMaterial([]);
    const result = await indexMaterial({ materialId });
    assert.equal(result.indexed, false);
    assert.equal(result.skipped, 0);
  });

  it("re-indexes by clearing first, so two embedding spaces cannot mix", async () => {
    const { materialId } = await makeMaterial([
      "photosynthesis in leaves",
      "mitochondria and ATP",
    ]);
    await indexMaterial({ materialId });

    const result = await reindexMaterial({ materialId });

    assert.equal(result.cleared, 2);
    assert.equal(result.embedded, 2);
    assert.equal(result.indexed, true);
    const chunks = await chunkState(materialId);
    assert.deepEqual(chunks.map((c) => c.embedded), [true, true]);
  });
});

// ── §9, §28: a failure leaves an honest, uncorrupted state ─────────────────
describe("an embedding failure", () => {
  /** Run indexMaterial with a given fake failure mode and return everything. */
  async function failWith(mode, contents = ["photosynthesis in leaves"]) {
    const { materialId } = await makeMaterial(contents);
    process.env.FAKE_EMBEDDING_MODE = mode;
    const result = await indexMaterial({ materialId });
    return { materialId, result, state: await indexingState(materialId) };
  }

  for (const mode of ["http-error", "network-error", "malformed", "count-mismatch"]) {
    it(`does not throw, and records "failed", for a ${mode} response`, async () => {
      const { result, state, materialId } = await failWith(mode);

      // NEVER THROWS: this runs inside the upload path, and a provider problem must
      // not discard a document that was stored and extracted successfully.
      assert.equal(result.failed, true);
      assert.equal(result.indexed, false);
      assert.equal(state.status, "ready", "the document is still readable");
      assert.equal(state.indexing_status, "failed");
      // §9's "do not claim the material is fully searchable" is this column.
      const chunks = await chunkState(materialId);
      assert.deepEqual(chunks.map((c) => c.embedded), [false]);
    });
  }

  it("records a message that names no provider, model, key or status code", async () => {
    // §32. `indexing_error` is returned verbatim by the API, so anything specific
    // here is specific in a response body.
    const { state } = await failWith("http-error");

    assert.match(state.indexing_error, /could not be prepared for search/);
    assert.doesNotMatch(
      state.indexing_error,
      /gemini|google|googleapis|api[ _-]?key|token|quota|\b500\b|fake-key/i,
    );
    assert.ok(state.indexing_error.length <= 500, "and it fits the column's bound");
  });

  it("persists no vector at all when the width is wrong", async () => {
    // §28: "if the vector dimension is unexpected, fail safely, do not persist
    // corrupt vector data". Two independent guards would have to fail for a
    // wrong-width vector to reach the column — the service's validation and the
    // column's own type — and this asserts the outcome rather than either guard.
    const { materialId, state } = await failWith("wrong-dimension", [
      "photosynthesis in leaves",
      "mitochondria and ATP",
    ]);

    assert.equal(state.indexing_status, "failed");
    const chunks = await chunkState(materialId);
    assert.deepEqual(chunks.map((c) => c.embedded), [false, false]);
  });

  it("persists no vector at all when one component is NaN", async () => {
    const { materialId, state } = await failWith("nan");
    assert.equal(state.indexing_status, "failed");
    assert.deepEqual((await chunkState(materialId)).map((c) => c.embedded), [false]);
  });

  it("can be retried, because failed is an eligible state", async () => {
    const { materialId } = await failWith("http-error");
    process.env.FAKE_EMBEDDING_MODE = "ok";

    const retry = await indexMaterial({ materialId });

    assert.equal(retry.indexed, true);
    assert.equal(retry.embedded, 1);
    const state = await indexingState(materialId);
    assert.equal(state.indexing_status, "indexed");
    assert.equal(state.indexing_error, null, "and the stale error is cleared");
  });
});

// ── §9, §27, §41: the repository's own guarantees ──────────────────────────
describe("the embedding repository", () => {
  it("offers only chunks without a vector, in document order", async () => {
    const { materialId } = await makeMaterial(["one", "two", "three"]);
    const before = await embeddingRepository.findChunksNeedingEmbedding(materialId);
    assert.deepEqual(before.map((c) => c.chunk_index), [0, 1, 2]);

    await db.query(
      `UPDATE material_chunks SET embedding = $1
        WHERE material_id = $2 AND chunk_index = 1`,
      [`[${topicVector(["osmosis"]).join(",")}]`, materialId],
    );

    const after = await embeddingRepository.findChunksNeedingEmbedding(materialId);
    assert.deepEqual(after.map((c) => c.chunk_index), [0, 2]);
    assert.deepEqual(await embeddingRepository.countEmbeddings(materialId), {
      total: 3,
      embedded: 1,
    });
  });

  it("counts as numbers, so 'fully indexed' is an arithmetic comparison", async () => {
    // src/config/pg-types.js registers an INT8 parser and this repository converts
    // again, and the belt-and-braces is deliberate: a bigint that arrived as the
    // string "3" would still satisfy `total === embedded`, so a material could be
    // called fully indexed by two strings happening to match rather than by two
    // counts being equal. Pinned here because nothing downstream would notice.
    const { materialId } = await makeMaterial(["one"]);
    const counts = await embeddingRepository.countEmbeddings(materialId);
    assert.equal(typeof counts.total, "number");
    assert.equal(typeof counts.embedded, "number");
  });

  it("marks a material indexed only when no chunk is left without a vector", async () => {
    const { materialId } = await makeMaterial(["photosynthesis", "calculus"]);
    const chunks = await embeddingRepository.findChunksNeedingEmbedding(materialId);

    const partial = await embeddingRepository.saveEmbeddingsAndMarkIndexed({
      materialId,
      embeddings: [{ id: chunks[0].id, embedding: topicVector(["photosynthesis"]) }],
    });

    assert.equal(partial.updated, 1);
    assert.equal(partial.indexed, false, "one chunk is still NULL");
    assert.equal((await indexingState(materialId)).indexing_status, "pending");

    const rest = await embeddingRepository.saveEmbeddingsAndMarkIndexed({
      materialId,
      embeddings: [{ id: chunks[1].id, embedding: topicVector(["calculus"]) }],
    });
    assert.equal(rest.indexed, true);
    assert.equal((await indexingState(materialId)).indexing_status, "indexed");
  });

  it("refuses to mark a material indexed with no embeddings", async () => {
    const { materialId } = await makeMaterial(["photosynthesis"]);
    await assert.rejects(
      () =>
        embeddingRepository.saveEmbeddingsAndMarkIndexed({
          materialId,
          embeddings: [],
        }),
      /Refusing to mark material .* indexed with no embeddings/,
    );
    assert.equal((await indexingState(materialId)).indexing_status, "pending");
  });

  it("rolls back entirely when a chunk vanished during indexing", async () => {
    const { materialId } = await makeMaterial(["photosynthesis", "calculus"]);
    const chunks = await embeddingRepository.findChunksNeedingEmbedding(materialId);

    // The owner re-uploaded or deleted the material while it was being embedded.
    await db.query("DELETE FROM material_chunks WHERE id = $1", [chunks[1].id]);

    await assert.rejects(
      () =>
        embeddingRepository.saveEmbeddingsAndMarkIndexed({
          materialId,
          embeddings: chunks.map((chunk) => ({
            id: chunk.id,
            embedding: topicVector(["photosynthesis"]),
          })),
        }),
      /the material's chunks changed during indexing/,
    );

    // ONE transaction, so the surviving chunk's vector went back too. Marking the
    // material indexed on the strength of a chunk set that no longer exists is the
    // outcome this prevents.
    const remaining = await chunkState(materialId);
    assert.deepEqual(remaining.map((c) => c.embedded), [false]);
    assert.equal((await indexingState(materialId)).indexing_status, "pending");
  });

  it("will not write a vector into another material's chunk", async () => {
    // Belt and braces against a caller that mixed ids from two materials: without
    // the `c.material_id = $1` predicate this would write into someone else's
    // chunk and report success.
    const mine = await makeMaterial(["photosynthesis"]);
    const theirs = await makeMaterial(["calculus"]);
    const [theirChunk] = await embeddingRepository.findChunksNeedingEmbedding(
      theirs.materialId,
    );

    await assert.rejects(
      () =>
        embeddingRepository.saveEmbeddingsAndMarkIndexed({
          materialId: mine.materialId,
          embeddings: [{ id: theirChunk.id, embedding: topicVector(["calculus"]) }],
        }),
      /updated 0/,
    );

    assert.deepEqual(
      (await chunkState(theirs.materialId)).map((c) => c.embedded),
      [false],
      "the other material's chunk is untouched",
    );
  });

  it("claims a material for indexing exactly once", async () => {
    const { materialId } = await makeMaterial(["photosynthesis"]);

    assert.equal(await embeddingRepository.markIndexing(materialId), true);
    assert.equal(
      await embeddingRepository.markIndexing(materialId),
      false,
      "already indexing",
    );

    await db.query(
      "UPDATE materials SET indexing_status = 'indexed' WHERE id = $1",
      [materialId],
    );
    assert.equal(
      await embeddingRepository.markIndexing(materialId),
      false,
      "a searchable material is never taken out of service by a redundant call",
    );

    await embeddingRepository.markIndexingFailed(materialId, "safe message");
    assert.equal(
      await embeddingRepository.markIndexing(materialId),
      true,
      "but a failed one can be retried",
    );
    assert.equal(
      (await indexingState(materialId)).indexing_error,
      null,
      "and claiming it clears the previous failure's message",
    );
  });

  it("clears embeddings back to pending without touching the chunks", async () => {
    const { materialId } = await makeMaterial(["photosynthesis", "calculus"]);
    await indexMaterial({ materialId });

    const cleared = await embeddingRepository.clearEmbeddings(materialId);

    assert.equal(cleared, 2);
    const chunks = await chunkState(materialId);
    assert.equal(chunks.length, 2, "the text is still there");
    assert.deepEqual(chunks.map((c) => c.embedded), [false, false]);
    assert.equal((await indexingState(materialId)).indexing_status, "pending");

    // Idempotent, and it does not rewrite rows that have no vector.
    assert.equal(await embeddingRepository.clearEmbeddings(materialId), 0);
  });
});
