/**
 * Embedding persistence — the only module with SQL for the vector column and the
 * indexing lifecycle.
 *
 * Same rules as material.repository.js: every value is a bind parameter, nothing
 * is concatenated, no layer above writes SQL. Vectors in particular go through
 * `$n::vector` as pgvector text literals — see src/utils/vector.js for why that
 * matters even though a vector "is only numbers".
 *
 * WHY THE STATUS TRANSITIONS LIVE HERE AND NOT IN material.repository.js
 * ----------------------------------------------------------------------
 * `indexing_status` moves only as a consequence of embedding work, and the
 * embedding service is the only thing that should be able to move it. Keeping
 * these three transitions beside the vector writes means the indexing lifecycle
 * is one file to read, and it keeps material.repository.js — which every material
 * endpoint touches — free of functions that could set a material 'indexed'
 * without any embedding having happened.
 */

import { query, withTransaction } from "../config/database.js";
import { toVectorLiteral } from "../utils/vector.js";

/**
 * Chunks of one material that still need an embedding, in document order.
 *
 * `embedding IS NULL` is the whole of §8's "do not needlessly reprocess". No
 * content hash, no cache, no comparison — a chunk either has a vector or it does
 * not, and it cannot have a stale one, because material.repository.js replaces
 * the chunk *rows* when a document is re-processed rather than updating them in
 * place. The embedding of text that no longer exists is deleted with the row that
 * held the text. That is the reasoning §8 wanted checked, and it is why the
 * complicated content-addressed cache it warns against is not needed.
 *
 * Ordered by chunk_index so a partially-indexed material fills in predictably and
 * so failures name a stable position. Served by
 * material_chunks_material_index_key.
 *
 * NOTE the deliberate absence of a userId parameter: this is called from the
 * indexing path, after material.repository.findOwnedById has already established
 * ownership, and is never reachable from a request that names a material. The
 * retrieval path — the one a request *does* drive — is in
 * retrieval.repository.js and filters on user_id in SQL.
 *
 * @param {number} materialId
 * @returns {Promise<Array<{id: number, chunk_index: number, content: string}>>}
 */
export async function findChunksNeedingEmbedding(materialId) {
  const { rows } = await query(
    `SELECT id, chunk_index, content
       FROM material_chunks
      WHERE material_id = $1
        AND embedding IS NULL
      ORDER BY chunk_index ASC`,
    [materialId],
  );
  return rows;
}

/**
 * How many of a material's chunks have an embedding, and how many exist.
 *
 * Both numbers in one row so the caller can decide "fully indexed" without a
 * second query that might see a different state. Used to decide whether a
 * material is `indexed` and by the tests that assert no chunk was re-embedded.
 *
 * @param {number} materialId
 * @returns {Promise<{total: number, embedded: number}>}
 */
export async function countEmbeddings(materialId) {
  const { rows } = await query(
    `SELECT COUNT(*) AS total,
            COUNT(embedding) AS embedded
       FROM material_chunks
      WHERE material_id = $1`,
    [materialId],
  );
  // COUNT(embedding) rather than COUNT(*) FILTER (...): COUNT of an expression
  // already skips NULLs, which is exactly the question being asked.
  //
  // Number() even though src/config/pg-types.js registers an INT8 parser that
  // already returns these as numbers. That registration is process-global and
  // installed by whoever built the pool, and pg-types.js's own docstring calls out
  // the trap: a pool created without it gets pg's defaults, where COUNT arrives as
  // the string "3". The caller compares total against embedded to decide whether a
  // material is fully indexed, and `"3" === "3"` is true by luck — so this path
  // would appear to work right up until the two counts came from different
  // sources. One conversion here makes the comparison arithmetic regardless.
  return { total: Number(rows[0].total), embedded: Number(rows[0].embedded) };
}

/**
 * Write embeddings for chunks of one material and mark it `indexed`, atomically.
 *
 * ONE transaction (§9), for the same reason saveChunksAndMarkReady is one:
 * `indexed` is a claim the API makes about searchability, so the vectors and the
 * status must both land or neither. A crash between them would leave a material
 * claiming to be searchable with half its chunks NULL — a question about the
 * unindexed half would return "your materials do not cover this" about material
 * that does cover it, which is the specific failure §9 calls out as worse than
 * an honest error.
 *
 * The transaction opens AFTER every embedding is in hand. §41 forbids holding a
 * connection across a provider call, and this is where that rule is kept: the
 * caller does all its Gemini work first, then hands finished vectors here. The
 * transaction's lifetime is two local statements.
 *
 * Written with unnest and a fixed six placeholders, matching
 * saveChunksAndMarkReady: the statement text does not change with the number of
 * chunks, so the plan cache is effective and the 65535-parameter ceiling is
 * unreachable.
 *
 * @param {object} input
 * @param {number} input.materialId
 * @param {Array<{id: number, embedding: number[]}>} input.embeddings validated
 *   and normalized by src/ai/embedding.service.js before arriving here
 * @returns {Promise<{updated: number, indexed: boolean}>}
 */
export async function saveEmbeddingsAndMarkIndexed({ materialId, embeddings }) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new Error(
      `Refusing to mark material ${materialId} indexed with no embeddings`,
    );
  }

  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE material_chunks AS c
          SET embedding = incoming.embedding
         FROM unnest($2::bigint[], $3::vector[])
              AS incoming(id, embedding)
        WHERE c.id = incoming.id
          -- Scoping the UPDATE to the material as well as the chunk id is
          -- belt-and-braces against a caller that mixed ids from two materials
          -- into one call: without it, this function would happily write a
          -- vector into another material's chunk — potentially another USER's
          -- chunk — and report success.
          AND c.material_id = $1`,
      [
        materialId,
        embeddings.map((row) => row.id),
        // ::vector[] needs text literals; pgvector parses each one. This is the
        // only place a vector crosses into SQL, and it crosses as a parameter.
        embeddings.map((row) => toVectorLiteral(row.embedding)),
      ],
    );

    if (rowCount !== embeddings.length) {
      // Fewer rows updated than vectors supplied means chunks disappeared under
      // us — the owner deleted or re-uploaded the material while it was being
      // embedded. Throwing rolls the whole thing back rather than marking a
      // material `indexed` on the strength of a chunk set that no longer exists.
      throw new Error(
        `Expected to embed ${embeddings.length} chunks of material ${materialId}, ` +
          `updated ${rowCount} — the material's chunks changed during indexing`,
      );
    }

    // 'indexed' only when NO chunk is left without a vector. The subquery is the
    // guard: the caller believes it embedded everything outstanding, but that
    // belief is based on a read taken before the provider call, and a document
    // re-processed in between would have added rows. Deriving the status from the
    // table rather than from the caller's count means the column cannot claim
    // more than the data supports.
    const { rows } = await client.query(
      `UPDATE materials
          SET indexing_status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM material_chunks
                   WHERE material_id = $1 AND embedding IS NULL
                ) THEN 'pending'
                ELSE 'indexed'
              END,
              indexing_error = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING indexing_status`,
      [materialId],
    );

    if (!rows[0]) {
      throw new Error(`Material ${materialId} disappeared during indexing`);
    }

    return { updated: rowCount, indexed: rows[0].indexing_status === "indexed" };
  });
}

/**
 * Move a material to `indexing`, but only from `pending` or `failed`.
 *
 * Compare-and-set, like markProcessing: two concurrent indexing attempts cannot
 * both proceed, because the second finds no row in an eligible state. `failed` is
 * eligible so a retry is possible; `indexed` is not, so a material that is
 * already searchable is never taken out of service by a redundant call.
 *
 * @param {number} id
 * @returns {Promise<boolean>} false if the material was not eligible
 */
export async function markIndexing(id) {
  const { rowCount } = await query(
    `UPDATE materials
        SET indexing_status = 'indexing',
            -- Required by materials_indexing_error_matches_status: leaving a
            -- previous failure's message attached to a non-failed status would
            -- violate the constraint and abort the statement.
            indexing_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND indexing_status IN ('pending', 'failed')`,
    [id],
  );
  return rowCount === 1;
}

/**
 * Mark a material's indexing `failed` with a client-safe reason.
 *
 * `safeMessage` is written to `indexing_error`, which the API returns verbatim,
 * so the caller is responsible for it carrying no provider output, no API key,
 * no URL and no document text (§32). material-indexing.service.js is the only
 * caller and takes the string from a fixed set.
 *
 * Chunks and any embeddings already written are deliberately LEFT IN PLACE,
 * unlike markFailed's treatment of an extraction failure. The text extracted
 * fine and the material is still readable — `status` stays `ready` — so
 * destroying the chunks would turn a "not searchable yet" into "not usable at
 * all". A partially embedded material is not mistakable for a complete one
 * because `indexing_status` is the only thing retrieval trusts, and it says
 * `failed`.
 *
 * @param {number} id
 * @param {string} safeMessage
 * @returns {Promise<boolean>}
 */
export async function markIndexingFailed(id, safeMessage) {
  const { rowCount } = await query(
    `UPDATE materials
        SET indexing_status = 'failed',
            indexing_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, safeMessage],
  );
  return rowCount === 1;
}

/**
 * Clear every embedding of one material and set it back to `pending`.
 *
 * The minimum safe re-indexing capability §30 asks for, and no more: no cron, no
 * worker, no queue. It exists for the case the documentation is explicit about —
 * the embedding model or dimension changing, which invalidates every stored
 * vector — and for a `failed` material whose partial embeddings should not be
 * mixed with vectors from a retry.
 *
 * Not reachable from any HTTP endpoint. Re-indexing every chunk of every material
 * is an operator action with a real cost in provider quota, and exposing it to an
 * unauthenticated caller (S1) would be a free way to spend someone else's money.
 * It is called by the indexing service and by tests.
 *
 * @param {number} materialId
 * @returns {Promise<number>} chunks cleared
 */
export async function clearEmbeddings(materialId) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE material_chunks
          SET embedding = NULL
        WHERE material_id = $1
          -- Only rows that have one. Without this the statement rewrites every
          -- chunk of the material on every call, which for a re-index of a large
          -- corpus is a great deal of pointless WAL.
          AND embedding IS NOT NULL`,
      [materialId],
    );

    await client.query(
      `UPDATE materials
          SET indexing_status = 'pending',
              indexing_error = NULL,
              updated_at = now()
        WHERE id = $1`,
      [materialId],
    );

    return rowCount;
  });
}
