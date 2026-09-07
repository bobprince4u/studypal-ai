/**
 * The processing pipeline: bytes in, persisted chunks out.
 *
 *   extract → normalize → chunk → persist → ready
 *
 * One function, `processMaterial`, and its whole job is sequencing those five
 * steps and deciding what happens when one of them fails. The steps themselves
 * live in their own modules and know nothing about materials, statuses or the
 * database: document-extractor.js parses, text-normalizer.js cleans,
 * text-chunker.js splits. This module is the only one that knows the ORDER.
 *
 * SYNCHRONOUS, ON PURPOSE
 * -----------------------
 * §30: "processing can happen synchronously if that is the cleanest
 * implementation. Do not introduce asynchronous infrastructure just because
 * future scale may require it." So POST /api/materials returns after processing
 * finishes, and there is no queue, no worker and no job table. At a 10 MB cap
 * that is a second or two for a large PDF, and the honest cost of the simple
 * version is a slower upload response — not a lost document, which is what a
 * half-built async pipeline would risk.
 *
 * The seam for changing that later is this function's signature: it takes a
 * material id and returns the finished row, so a future queue enqueues a call to
 * it rather than reimplementing it.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * No Gemini, no HTTP, no res, no SQL. Persistence goes through
 * material.repository.js and the bytes come from local-storage.service.js, so this
 * module contains neither a query nor an `fs` call.
 */

import { logger } from "../utils/logger.js";
import * as storage from "../storage/local-storage.service.js";
import * as materialRepository from "./material.repository.js";
import { ExtractionError, extractDocument } from "./document-extractor.js";
import { hasMeaningfulText, normalizeText } from "./text-normalizer.js";
import { chunkPages } from "./text-chunker.js";

/**
 * The one message a client sees when processing failed for a reason that is not
 * about their document.
 *
 * Storage errors, database errors and bugs all land here. They are logged in
 * full server-side; what reaches the client says nothing about which of the three
 * it was, because that distinction is useful to an attacker and useless to a
 * student (§20).
 */
const GENERIC_FAILURE = "This document could not be processed.";

/**
 * Process an uploaded material through to `ready` or `failed`.
 *
 * Never throws for a document-level problem — a malformed PDF, an empty file, an
 * unreadable encoding are all normal outcomes here, and each one leaves the
 * material in `failed` with a safe message. It DOES throw if the material cannot
 * be moved out of `uploaded` at all, because that means the caller's assumption
 * about the material's state was wrong and silently succeeding would be worse.
 *
 * @param {object} input
 * @param {number} input.materialId
 * @param {string} input.storageKey
 * @param {string} input.mimeType the type the backend determined at validation
 * @returns {Promise<object>} the material row, `ready` or `failed`
 */
export async function processMaterial({ materialId, storageKey, mimeType }) {
  const material = await materialRepository.markProcessing(materialId);
  if (!material) {
    // The compare-and-set in markProcessing found no row in `uploaded`: the
    // material was deleted, or something else is already processing it. Both are
    // the caller's problem to report, not a document failure to record.
    throw new Error(
      `Material ${materialId} is not in 'uploaded' state and cannot be processed`,
    );
  }

  try {
    // 1. READ. The only read of the file — the buffer is passed down from here
    //    rather than re-read per step (§29: "avoid reading files multiple
    //    times").
    const buffer = await storage.read(storageKey);

    // 2. EXTRACT. Per-page for a PDF, one NULL-numbered page for text.
    const { pages, pageCount } = await extractDocument({ buffer, mimeType });

    // 3. NORMALIZE, per page. Before chunking, because chunk boundaries are
    //    chosen from the text's structure and normalization is what makes that
    //    structure comparable between a Windows export and a PDF.
    const normalizedPages = pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: normalizeText(page.text),
    }));

    // 4. §17's gate. A file can be perfectly valid, parse without error and
    //    still contain nothing a reader could use: a scanned page with no text
    //    layer, a .txt of newlines. Those must fail rather than become an empty
    //    `ready` material, and this is where that is decided — across the whole
    //    document, since a PDF whose first page is a blank cover is fine.
    const meaningful = normalizedPages.some((page) =>
      hasMeaningfulText(page.text),
    );
    if (!meaningful) {
      throw new ExtractionError(
        `material ${materialId}: no text after normalization of ${pages.length} page(s)`,
        // Says what to do about it. A scanned PDF is the overwhelmingly common
        // cause and OCR is the actual answer, so the message names it rather
        // than leaving the student to guess why a file they can read is refused.
        "No readable text could be found in this document. If it is a scanned PDF, it needs to be converted with OCR first.",
      );
    }

    // 5. CHUNK. One continuous 0-based sequence across pages; each chunk carries
    //    the page it came from, or NULL.
    const chunks = chunkPages(normalizedPages);
    if (chunks.length === 0) {
      // Unreachable given the check above — text that is meaningful produces at
      // least one chunk. Kept because the invariant "ready implies chunks" is
      // the one thing in this file that must not be wrong, and an assertion that
      // never fires is cheaper than one that was never written.
      throw new ExtractionError(
        `material ${materialId}: chunker produced nothing from non-empty text`,
        GENERIC_FAILURE,
      );
    }

    // 6. PERSIST, atomically with the status change. Either the chunks and
    //    `ready` both land or neither does — see saveChunksAndMarkReady.
    const ready = await materialRepository.saveChunksAndMarkReady({
      materialId,
      chunks,
      pageCount,
    });

    logger.info(
      `material ${materialId} ready: ${chunks.length} chunk(s)` +
        `${pageCount === null ? "" : `, ${pageCount} page(s)`}`,
    );
    return ready;
  } catch (err) {
    return failMaterial(materialId, err);
  }
}

/**
 * Record a processing failure and return the failed row.
 *
 * The split between what is logged and what is stored is the whole point of this
 * function. `err.message` — parser output, a filesystem path, a SQL error — goes
 * to the log with its cause chain. Only a message from a fixed set is written to
 * `error_message`, which the API returns verbatim (§13, §20).
 *
 * @param {number} materialId
 * @param {unknown} err
 * @returns {Promise<object>} the material row, now `failed`
 */
async function failMaterial(materialId, err) {
  const safeMessage =
    err instanceof ExtractionError ? err.safeMessage : GENERIC_FAILURE;

  // An ExtractionError is an expected outcome for a bad document, so it is a
  // warning; anything else is a bug or an outage and gets the full error with its
  // stack. Both include `cause`, which is where the parser's own words are.
  if (err instanceof ExtractionError) {
    logger.warn(`material ${materialId} failed: ${err.message}`);
  } else {
    logger.error(`material ${materialId} failed unexpectedly`, err);
  }

  const failed = await materialRepository.markFailed(materialId, safeMessage);
  if (!failed) {
    // The material was deleted while it was being processed. Nothing to record
    // and nothing wrong: the owner asked for it to be gone, and it is.
    throw new Error(
      `Material ${materialId} disappeared before its failure could be recorded`,
    );
  }
  return failed;
}
