/**
 * Vector similarity search — the only module with retrieval SQL.
 *
 * ONE function, because there is only one safe shape for this query, and every
 * property that makes it safe is a property of the SQL rather than of the caller:
 *
 *   USER ISOLATION IS A JOIN CONDITION. `m.user_id = $1` is inside the query, so
 *   there is no result set that ever contains another student's chunk — not
 *   briefly, not before a filter, not in a variable. §15 forbids retrieving
 *   globally and filtering in JavaScript, and the reason is that such a filter is
 *   one early `return` or one refactor away from being skipped, whereas a WHERE
 *   clause cannot be accidentally omitted by code that does not exist. There is
 *   deliberately no function here that searches without a user id, for the same
 *   reason material.repository.js has no findById.
 *
 *   THE DATABASE COMPUTES THE DISTANCE. `embedding <=> $2::vector` is evaluated
 *   by pgvector, ordered by pgvector and limited by pgvector (§11, §40). Nothing
 *   loads chunks into Node to score them: at 1536 dimensions that would mean
 *   transferring every chunk of the corpus per question, and it is the difference
 *   between a query that stays fast as documents accumulate and one that does not.
 *
 *   THE RESULT COUNT IS BOUNDED. `LIMIT $4`, always, with the value clamped by
 *   the service against config.rag.maxTopK (§13). A request cannot ask for the
 *   whole table.
 *
 * `<=>` is cosine distance: 0 for identical direction, 1 for orthogonal, 2 for
 * opposite. Similarity is `1 - distance`, which is what the threshold and the API
 * speak in, because "0.82 similar" is a number a human can reason about and
 * "0.18 distant" is one they will misread eventually. Cosine and not L2 (`<->`)
 * because embeddings encode meaning in direction; and because every stored vector
 * is L2-normalized (see src/ai/embedding.service.js), the two would in fact rank
 * identically here — cosine is chosen for being the one that stays correct if a
 * future vector ever arrives un-normalized.
 */

import { query } from "../config/database.js";
import { toVectorLiteral } from "../utils/vector.js";

/**
 * The nearest chunks to `embedding` among those this user owns.
 *
 * Everything §11 asks a result to carry: chunk id, material id, chunk index,
 * content, page number, similarity score, and the material's filename — the last
 * because a citation naming "material 47" is not a citation a student can use,
 * and because the alternative is a second query per source.
 *
 * `materialId` is optional and additive: supplying it narrows the search to that
 * one material (§15's specific-material scope), omitting it searches everything
 * the user owns (user-wide scope). It NEVER widens the search — the user
 * predicate is unconditional and is not part of the same OR as anything. A
 * material id belonging to someone else therefore returns zero rows rather than
 * an error, which is the same "absent and not-yours are indistinguishable"
 * property material.repository.js relies on, and it means a caller cannot probe
 * for the existence of other people's materials through this path.
 *
 * The `$3::bigint IS NULL OR` idiom keeps the statement text constant instead of
 * appending a clause when the parameter is present. Two shapes of a
 * security-critical query is twice as much to review and twice as much to get
 * wrong; one shape with a parameter that may be NULL is checked once. It is also
 * why the ownership predicate cannot be conditionally assembled by mistake —
 * there is no assembly.
 *
 * WHY `indexing_status` IS NOT FILTERED ON: a chunk with a NULL embedding cannot
 * match, because `NULL <=> vector` is NULL and the threshold comparison excludes
 * it. Retrieval therefore reads whatever is actually embedded, and a material
 * mid-indexing contributes its finished chunks rather than nothing at all. The
 * status column tells a *client* whether a material is fully searchable; it is
 * not a precondition for searching, and adding it here would make retrieval
 * depend on two sources of truth that can disagree.
 *
 * @param {object} params
 * @param {number} params.userId resolved server-side from the username; never
 *   accepted from a request body
 * @param {number|null} params.materialId optional scope, already ownership-checked
 *   by the caller — but not trusted here either, hence the user predicate
 * @param {number[]} params.embedding the query vector, validated and normalized
 * @param {number} params.limit already clamped to config.rag.maxTopK
 * @param {number} params.threshold minimum similarity in [0, 1]
 * @returns {Promise<Array<{chunk_id: number, material_id: number, chunk_index: number,
 *   content: string, page_number: number|null, filename: string, similarity: number}>>}
 *   most similar first
 */
export async function searchSimilarChunks({
  userId,
  materialId = null,
  embedding,
  limit,
  threshold,
}) {
  const { rows } = await query(
    `SELECT c.id            AS chunk_id,
            c.material_id   AS material_id,
            c.chunk_index   AS chunk_index,
            c.content       AS content,
            c.page_number   AS page_number,
            m.original_filename AS filename,
            1 - (c.embedding <=> $2::vector) AS similarity
       FROM material_chunks c
       JOIN materials m ON m.id = c.material_id
      WHERE m.user_id = $1
        AND ($3::bigint IS NULL OR c.material_id = $3::bigint)
        -- Redundant against the distance comparison below, which is already NULL
        -- for a NULL embedding and therefore already excludes these rows. Stated
        -- anyway because it makes the intent legible to the next reader: only
        -- embedded chunks participate. Costs nothing — the planner folds it in.
        AND c.embedding IS NOT NULL
        -- The threshold in SQL, not in JavaScript. Filtering after LIMIT would
        -- return fewer than the requested number of *qualifying* rows whenever
        -- any near-miss made the top K; filtering before it means LIMIT counts
        -- rows that actually qualify.
        AND 1 - (c.embedding <=> $2::vector) >= $5
      ORDER BY c.embedding <=> $2::vector ASC,
               -- Tie-break on stable identity so equal distances come back in
               -- the same order every time. Without this, two chunks at the same
               -- similarity may swap positions between runs, which makes the
               -- ordering tests §35 demands flaky rather than wrong — the worst
               -- kind of failure to diagnose. Ascending distance, so the nearest
               -- is first: with cosine, smaller distance is more similar.
               c.material_id ASC,
               c.chunk_index ASC
      LIMIT $4`,
    [userId, toVectorLiteral(embedding), materialId, limit, threshold],
  );

  return rows;
}
