/**
 * Retrieval: a question in, the user's most relevant chunks out.
 *
 * The layer between "someone asked something" and the vector SQL. It owns three
 * decisions and delegates everything else:
 *
 *   1. how many chunks may be asked for (clamped, server-side — §13)
 *   2. what counts as relevant (the similarity threshold)
 *   3. how a chunk row becomes a retrieval result the rest of the app can use
 *
 * It does NOT own ownership. `userId` arrives already resolved from the username
 * and is passed to the repository, which puts it in the WHERE clause; this module
 * has no code path that omits it because there is no other function to call.
 * Similarly it does not talk to Gemini's generation model, does not build prompts,
 * and does not know what will be done with what it returns — retrieval is useful
 * on its own and is tested on its own.
 */

import { config } from "../config/env.js";
import { embedQuery } from "../ai/embedding.service.js";
import * as retrievalRepository from "./retrieval.repository.js";

/**
 * One retrieved chunk.
 *
 * @typedef {object} RetrievedChunk
 * @property {number} chunkId
 * @property {number} materialId
 * @property {number} chunkIndex
 * @property {string} content
 * @property {number|null} pageNumber
 * @property {string} filename
 * @property {number} similarity cosine similarity in [0, 1], higher is closer
 */

/**
 * Clamp a requested result count into what the server is willing to serve.
 *
 * §13's "the server must enforce a maximum". A request asking for 10,000 chunks
 * gets `maxTopK`, not an error: `topK` is a hint about how much context is
 * wanted, and rejecting a request over a tuning parameter would be a worse API
 * than quietly serving the most it will serve. A request asking for 0 or -3 gets
 * the default, because those are not smaller requests, they are malformed ones.
 *
 * @param {unknown} requested
 * @returns {number}
 */
export function resolveTopK(requested) {
  const ceiling = config.rag.maxTopK;
  const fallback = Math.min(config.rag.topK, ceiling);

  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    return fallback;
  }

  return Math.min(requested, ceiling);
}

/**
 * Find the chunks most relevant to `question` among those `userId` owns.
 *
 * Returns an empty array when nothing clears the threshold, and that is a
 * first-class outcome rather than an error — it is how the chat path knows to say
 * "your materials do not cover this" instead of inventing an answer (§21). The
 * caller distinguishes "no evidence" from "the provider broke" by the fact that
 * the latter throws.
 *
 * @param {object} params
 * @param {number} params.userId resolved server-side; never from the request body
 * @param {number|null} [params.materialId] optional single-material scope
 * @param {string} params.question
 * @param {number} [params.topK] a hint; clamped by resolveTopK
 * @returns {Promise<{chunks: RetrievedChunk[], topK: number, threshold: number}>}
 */
export async function retrieveRelevantChunks({
  userId,
  materialId = null,
  question,
  topK,
}) {
  const limit = resolveTopK(topK);
  const threshold = config.rag.similarityThreshold;

  // RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT — embedQuery is a separate function
  // for exactly this reason, so the task type cannot be got wrong by passing the
  // wrong flag. Throws on a provider failure or a malformed vector, which the
  // caller must not confuse with "nothing was found".
  const embedding = await embedQuery(question);

  const rows = await retrievalRepository.searchSimilarChunks({
    userId,
    materialId,
    embedding,
    limit,
    threshold,
  });

  return { chunks: rows.map(toRetrievedChunk), topK: limit, threshold };
}

/**
 * A retrieval row in the application's own vocabulary.
 *
 * The snake_case/camelCase boundary, kept in one place so nothing downstream
 * touches a raw row. `similarity` is rounded to four decimals: it is computed
 * from floats and its 17th digit is noise, but it reaches API responses and test
 * assertions, where an unrounded value is a source of spurious inequality.
 */
function toRetrievedChunk(row) {
  return {
    chunkId: row.chunk_id,
    materialId: row.material_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    pageNumber: row.page_number ?? null,
    filename: row.filename,
    similarity: Math.round(row.similarity * 10_000) / 10_000,
  };
}
