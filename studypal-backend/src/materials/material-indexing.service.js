/**
 * Indexing: turn a material's persisted chunks into searchable vectors.
 *
 * The one place embeddings are generated for storage. It sits BESIDE
 * material-processing.service.js rather than inside it, which is the deliberate
 * architectural choice of this ticket:
 *
 *   Processing is deterministic. Given the same bytes it produces the same
 *   chunks, offline, with no credential and no network. That property is why its
 *   54 tests are fast and why its failures are always reproducible, and it would
 *   be destroyed by putting a provider call in the middle of it. So the
 *   extraction pipeline stays exactly as SP-V2-003 left it — its docstring's
 *   claim of "no Gemini, no HTTP" remains true — and the orchestrator
 *   (material.service.js) calls processing, then calls this.
 *
 * §41 IS THE OTHER REASON THE SPLIT IS HERE. No database transaction may be held
 * open across a Gemini call. This module therefore runs strictly:
 *
 *   read what needs embedding (connection taken, released)
 *   → call the provider (no connection held, however long it takes)
 *   → write vectors and status in one transaction (connection taken, released)
 *
 * A design that embedded chunk-by-chunk inside the persistence transaction would
 * hold a pooled connection for the duration of every network round trip, and
 * DB_POOL_MAX is 10.
 */

import { logger } from "../utils/logger.js";
import { embedDocuments, embeddingInfo } from "../ai/embedding.service.js";
import * as embeddingRepository from "./embedding.repository.js";

/**
 * What a client is told when indexing fails, whatever actually happened.
 *
 * ONE fixed string, and it names no provider, no model, no HTTP status and no
 * quota (§32). It is written to `materials.indexing_error`, which the API returns
 * verbatim, so anything specific here would be specific in a response body.
 *
 * The distinction it deliberately does NOT draw is between "the API key is
 * missing", "we are rate limited" and "the provider returned malformed vectors".
 * Those are operator problems with operator diagnostics, and they go to the log
 * with the real cause attached. To the student, all three mean the same actionable
 * thing: the document is readable, it is not searchable yet, and trying again
 * later may work.
 */
const GENERIC_FAILURE =
  "This document could not be prepared for search. It can still be viewed, and " +
  "indexing can be retried.";

/**
 * Generate and persist embeddings for one material's chunks.
 *
 * Idempotent and resumable: only chunks with a NULL embedding are read, so
 * calling this twice does not re-embed anything and a retry after a partial
 * failure continues from where it stopped (§8). A material that is already fully
 * indexed is a no-op that costs one SELECT and no provider call.
 *
 * NEVER THROWS. This is called from the upload path, after the document has
 * already been extracted, chunked and marked `ready`. An embedding failure must
 * not fail the upload: the student's document IS stored and IS readable, and
 * turning that into a 500 would discard a successful upload over a provider
 * problem they cannot do anything about. So a failure is recorded on the material
 * — `indexing_status = 'failed'`, with the safe message above — logged with its
 * real cause, and reported in the return value. §9's "do not silently swallow"
 * is satisfied by the recorded status and the log, not by propagating.
 *
 * @param {object} input
 * @param {number} input.materialId
 * @returns {Promise<{materialId: number, indexed: boolean, embedded: number,
 *   skipped: number, failed: boolean}>}
 */
export async function indexMaterial({ materialId }) {
  const outstanding =
    await embeddingRepository.findChunksNeedingEmbedding(materialId);

  if (outstanding.length === 0) {
    // Either every chunk already has a vector, or the material has no chunks at
    // all (it failed extraction). Both mean there is no embedding work to do.
    // countEmbeddings distinguishes them, so the status written below is honest
    // in each case rather than a blanket 'indexed'.
    const { total, embedded } =
      await embeddingRepository.countEmbeddings(materialId);

    logger.debug(
      `material ${materialId}: nothing to embed (${embedded}/${total} chunks already indexed)`,
    );

    return {
      materialId,
      // A material with zero chunks is not "indexed" — there is nothing to
      // search. Saying otherwise would put a searchable-looking material with no
      // content in a student's list.
      indexed: total > 0 && embedded === total,
      embedded: 0,
      skipped: embedded,
      failed: false,
    };
  }

  // Compare-and-set. A false return means something else is already indexing this
  // material, or it is already `indexed`; either way this call must not proceed,
  // because two concurrent runs would both embed the same chunks and pay twice
  // for it. Nothing runs concurrently today (upload is synchronous), which is
  // precisely why making the transition safe is free right now.
  const claimed = await embeddingRepository.markIndexing(materialId);
  if (!claimed) {
    logger.warn(
      `material ${materialId}: indexing not claimed — another run holds it or it is already indexed`,
    );
    return {
      materialId,
      indexed: false,
      embedded: 0,
      skipped: 0,
      failed: false,
    };
  }

  const { model, dimensions } = embeddingInfo();

  try {
    // No connection is held here. This is the network call, and it may take
    // seconds; the read above has already returned its connection to the pool.
    const vectors = await embedDocuments(outstanding.map((chunk) => chunk.content));

    // Positional mapping, which is safe because embedDocuments guarantees one
    // vector per input in input order and the client verifies the count against
    // the request before returning. That guarantee is load-bearing: a silent
    // off-by-one here would attach every chunk's vector to its neighbour, and the
    // result would be a corpus that retrieves confidently and wrongly with no
    // error anywhere. It is checked in two places for that reason.
    const { indexed } = await embeddingRepository.saveEmbeddingsAndMarkIndexed({
      materialId,
      embeddings: outstanding.map((chunk, i) => ({
        id: chunk.id,
        embedding: vectors[i],
      })),
    });

    logger.info(
      `material ${materialId} indexed: ${vectors.length} chunks, ${model} @ ${dimensions}d`,
    );

    return {
      materialId,
      indexed,
      embedded: vectors.length,
      skipped: 0,
      failed: false,
    };
  } catch (err) {
    // The real cause, server-side only. `err.message` from the embedding path can
    // contain a provider error body; it goes to the log, which is not a response.
    // What must never appear even here is the API key — the client never puts it
    // in a message, and the SDK sends it as a header rather than in the URL.
    logger.error(
      `material ${materialId}: indexing failed (${model} @ ${dimensions}d): ${err.message}`,
    );

    // Recorded so the state is not lost when this function returns normally.
    // Best-effort: if the status write itself fails, the material is left in
    // `indexing`, which is wrong but not dangerous — it is not `indexed`, so
    // nothing claims it is searchable, and the log has the real story.
    try {
      await embeddingRepository.markIndexingFailed(materialId, GENERIC_FAILURE);
    } catch (statusErr) {
      logger.error(
        `material ${materialId}: could not record the indexing failure: ${statusErr.message}`,
      );
    }

    return {
      materialId,
      indexed: false,
      embedded: 0,
      skipped: 0,
      failed: true,
    };
  }
}

/**
 * Discard a material's embeddings and generate them again.
 *
 * The re-indexing capability §30 asks for, at its minimum useful size: clear,
 * then index. No scheduler, no queue, no worker — a function an operator or a
 * test can call.
 *
 * The case it exists for is the one the documentation calls out as unavoidable:
 * changing `STUDYPAL_EMBEDDING_MODEL` or `STUDYPAL_EMBEDDING_DIM` makes every
 * stored vector incomparable with every new one, and there is no migration that
 * can fix that — the old vectors have to go. Clearing first rather than
 * overwriting in place means a failure part-way through leaves NULLs, which
 * retrieval correctly ignores, instead of a mixture of two embedding spaces,
 * which it cannot detect.
 *
 * @param {object} input
 * @param {number} input.materialId
 * @returns {Promise<{materialId: number, indexed: boolean, embedded: number,
 *   skipped: number, failed: boolean, cleared: number}>}
 */
export async function reindexMaterial({ materialId }) {
  const cleared = await embeddingRepository.clearEmbeddings(materialId);
  logger.info(`material ${materialId}: cleared ${cleared} embeddings, re-indexing`);

  const result = await indexMaterial({ materialId });
  return { ...result, cleared };
}
