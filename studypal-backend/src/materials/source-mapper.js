/**
 * Source mapping: the model's `[1, 3]` → real citations the backend vouches for.
 *
 * THE POINT OF THIS MODULE IS THAT GEMINI NEVER PRODUCES A CITATION (§23, §24).
 *
 * The model is allowed to say which of the numbered sources it used, and nothing
 * else. It never sees a chunk id, never sees a material id, and is never asked for
 * a filename or a page number — so it cannot return one, correct or otherwise.
 * Every field in every citation this application emits is read here out of the
 * retrieval result, which came out of the database.
 *
 * That is a structural guarantee rather than a behavioural hope. A model asked to
 * echo a filename will occasionally produce a plausible one that does not exist
 * ("Chapter4_Notes.pdf"), and a fabricated citation is worse than no citation:
 * it is a confident, checkable-looking claim about a document the student can go
 * and fail to find. Asking only for an integer means the worst a hallucination can
 * do is name a source index that is out of range — which is detectable, and is
 * dropped below.
 */

import { logger } from "../utils/logger.js";

/**
 * Turn the model's claimed source indexes into citations.
 *
 * `sourceIndexes` is untrusted: it is model output, constrained by a JSON schema
 * but not guaranteed by it to be meaningful. Everything that could be wrong with
 * it is handled here rather than trusted:
 *
 *   out of range (`[99]` for 3 sources)  → dropped
 *   zero or negative (`[0]`, `[-1]`)     → dropped (the contract is 1-based)
 *   not an integer (`[1.5]`, `["1"]`)    → dropped
 *   duplicated (`[1, 1, 2]`)             → de-duplicated, first position kept
 *   not an array at all                  → treated as none
 *
 * Dropped, in every case, rather than clamped or coerced. A `[99]` clamped to the
 * last source would attach a real citation to a statement the model did not take
 * from it, which is fabrication performed by us rather than by the model.
 *
 * An empty result is returned rather than an error. A grounded answer with an
 * unusable source list is still a grounded answer — the context it was built from
 * was real — and it is better to return it with no citations than to fail the
 * request. The discrepancy is logged, because a model regularly citing sources
 * that do not exist is a prompt problem worth seeing.
 *
 * @param {unknown} sourceIndexes 1-based indexes as returned by the model
 * @param {import("./retrieval.service.js").RetrievedChunk[]} sources the chunks
 *   actually placed in the prompt, in prompt order — `sources[n - 1]` is
 *   `[Source n]`
 * @returns {Array<{materialId: number, filename: string, pageNumber: number|null,
 *   chunkIndex: number, similarity: number}>} in the model's citation order
 */
export function mapSources(sourceIndexes, sources) {
  if (!Array.isArray(sourceIndexes)) return [];

  const seen = new Set();
  const mapped = [];
  let invalid = 0;

  for (const raw of sourceIndexes) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      invalid += 1;
      continue;
    }

    // 1-based on the wire, 0-based in the array. The prompt says "Source 1" and
    // the model answers "1"; the conversion happens once, here.
    const index = raw - 1;
    if (index < 0 || index >= sources.length) {
      invalid += 1;
      continue;
    }

    if (seen.has(index)) continue;
    seen.add(index);

    const chunk = sources[index];
    // Field by field out of the retrieval result. Deliberately not `{...chunk}`:
    // spreading would put `content` — a passage of the student's document — into
    // the API response, and `chunkId`, an internal surrogate key, alongside it.
    // Naming the four fields §22 specifies means a future column on
    // material_chunks cannot silently join them.
    mapped.push({
      materialId: chunk.materialId,
      filename: chunk.filename,
      pageNumber: chunk.pageNumber ?? null,
      chunkIndex: chunk.chunkIndex,
      similarity: chunk.similarity,
    });
  }

  if (invalid > 0) {
    // Counts, not values: logging the raw indexes is harmless, but logging them
    // alongside the source list is one step from logging retrieved content.
    logger.warn(
      `material chat: discarded ${invalid} source reference(s) the model returned ` +
        `that did not correspond to any of the ${sources.length} sources provided`,
    );
  }

  return mapped;
}
