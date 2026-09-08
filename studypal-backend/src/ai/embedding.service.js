/**
 * Embeddings: the application's view of "turn text into a vector".
 *
 * This is the abstraction §6 asks for, and the whole of it. `EmbeddingProvider`
 * is the contract; `geminiEmbeddingProvider` is the one implementation. Callers
 * — the indexing service, the retrieval service — depend on the two exported
 * functions and never on Gemini, so replacing the provider is a change to this
 * file and nothing above it.
 *
 * It is deliberately NOT a plugin framework. There is no registry, no dynamic
 * loading, no provider-selection config: one interface with one implementation
 * is what the codebase needs, and the second implementation is the right time to
 * generalise, not now.
 *
 * WHAT THIS LAYER OWNS, and the transport below it does not:
 *   - batching, and the choice of batch size
 *   - L2 normalization (mandatory for this model below 3072 dimensions)
 *   - dimension, type and finiteness validation of everything returned
 *   - the taskType distinction between a document and a query
 *
 * WHAT IT DOES NOT OWN: HTTP status codes, client-facing messages, and whether a
 * failure should mark a material `failed`. Those are the caller's, and this
 * module rejects with a plain Error so the caller decides.
 */

import { config } from "../config/env.js";
import { embedContents } from "./gemini.client.js";
import { assertValidEmbedding, normalize } from "../utils/vector.js";

/**
 * The provider contract.
 *
 * @typedef {object} EmbeddingProvider
 * @property {string} model identifier, for logs and for documenting a corpus
 * @property {number} dimensions vector width every returned embedding must have
 * @property {number} maxBatchSize texts accepted in one embedMany call
 * @property {(texts: string[]) => Promise<number[][]>} embedDocuments
 *   Embed text destined for storage and later retrieval.
 * @property {(text: string) => Promise<number[]>} embedQuery
 *   Embed a question being asked *against* stored documents.
 */

/**
 * gemini-embedding-001 through the shared Gemini client.
 *
 * The two embed* methods differ only in `taskType`, and that difference is the
 * point. An asymmetric embedding model places a question and its answer near
 * each other only when it is told which is which; embedding both as
 * RETRIEVAL_DOCUMENT would cluster questions with questions, which retrieves
 * confidently and wrongly.
 *
 * @type {EmbeddingProvider}
 */
export const geminiEmbeddingProvider = {
  get model() {
    return config.rag.embeddingModel;
  },
  get dimensions() {
    return config.rag.embeddingDimensions;
  },
  get maxBatchSize() {
    return config.rag.embeddingBatchSize;
  },

  async embedDocuments(texts) {
    return embedContents({ texts, taskType: "RETRIEVAL_DOCUMENT" });
  },

  async embedQuery(text) {
    const [embedding] = await embedContents({
      texts: [text],
      taskType: "RETRIEVAL_QUERY",
    });
    return embedding;
  },
};

/** The provider in use. Injectable in tests; not configurable at runtime. */
let provider = geminiEmbeddingProvider;

/**
 * Test seam. Swaps the provider and returns a restore function.
 *
 * Only unit tests use this. The HTTP-level suites intercept `fetch` instead
 * (tests/helpers/fake-gemini.mjs), because a spawned server is a separate
 * process and cannot have its module graph reached into — and because
 * intercepting at the network boundary exercises the real client, the real
 * request shape and the real response parsing, which is most of what could be
 * wrong here.
 */
export function setEmbeddingProvider(next) {
  const previous = provider;
  provider = next ?? geminiEmbeddingProvider;
  return () => {
    provider = previous;
  };
}

/** The active provider's descriptive facts, for logs and documentation. */
export function embeddingInfo() {
  return {
    model: provider.model,
    dimensions: provider.dimensions,
    maxBatchSize: provider.maxBatchSize,
  };
}

/**
 * Embed texts for storage. Returns one validated, normalized vector per input.
 *
 * Batching is per §10: the installed SDK does accept an array of contents and
 * documents that the response preserves input order, so batches are used —
 * `config.rag.embeddingBatchSize` at a time, sequentially. Sequential rather
 * than concurrent on purpose: a student's upload is a handful of batches, and
 * firing them in parallel converts a rate limit into a failed upload for no
 * meaningful latency gain. If the SDK's batching ever proves unreliable, setting
 * STUDYPAL_EMBEDDING_BATCH_SIZE=1 degrades this to one request per chunk with no
 * code change — which is the tradeoff §10 asks to have documented.
 *
 * PARTIAL FAILURE: this function is all-or-nothing. A batch that rejects
 * rejects the whole call, and no caller writes anything until every vector is in
 * hand. Returning "the first 40 of 60 worked" would put the caller in the
 * position §9 warns about — a material that looks searchable and is two-thirds
 * indexed, where a question about the last chapter silently retrieves nothing.
 * Failing whole means a retry starts from a known state.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>} normalized vectors, input order
 */
export async function embedDocuments(texts) {
  if (!Array.isArray(texts)) {
    throw new TypeError("embedDocuments expects an array of strings");
  }
  if (texts.length === 0) return [];

  const batchSize = Math.max(1, provider.maxBatchSize);
  const vectors = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const returned = await provider.embedDocuments(batch);

    if (!Array.isArray(returned) || returned.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${
          Array.isArray(returned) ? returned.length : typeof returned
        } vectors for ${batch.length} texts`,
      );
    }

    // Validated per item, with the *global* index in the message: "text 3 of
    // this batch" is not actionable when there are four batches, and the caller
    // reports failures against chunk indexes.
    returned.forEach((embedding, offset) => {
      vectors.push(finalize(embedding, `embedding for text ${start + offset}`));
    });
  }

  return vectors;
}

/**
 * Embed a question for searching. Returns one validated, normalized vector.
 *
 * Separate from embedDocuments so the taskType cannot be got wrong by a caller
 * passing a flag — the query path and the document path are different functions
 * with different names, and there is no argument that turns one into the other.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedQuery(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new TypeError("embedQuery expects a non-empty string");
  }

  return finalize(await provider.embedQuery(text), "query embedding");
}

/**
 * Validate and normalize one vector, or throw naming what was wrong.
 *
 * Order matters: validate first, then normalize. Normalizing an array
 * containing a NaN spreads it across every element (the magnitude becomes NaN),
 * so the diagnostic "index 812 is not a finite number" would degrade into "all
 * 1536 values are NaN" and the actual defect would be unrecoverable from the log.
 */
function finalize(embedding, subject) {
  assertValidEmbedding(embedding, provider.dimensions, subject);
  return normalize(embedding);
}
