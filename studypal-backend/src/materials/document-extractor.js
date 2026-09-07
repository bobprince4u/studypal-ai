/**
 * Document text extraction — PDF and plain text.
 *
 * Deterministic and offline. There is no Gemini import in this file, and none
 * anywhere else under src/materials/: extraction is parsing, not interpretation.
 * Sending a document to a model to "read" it would make the output
 * nondeterministic, cost money per upload, leak every uploaded document to a
 * third party, and produce text that cannot be cited back to a page. A
 * tests/materials/architecture.test.js check asserts the absence by grep, so this
 * is a property of the codebase rather than a promise in a comment.
 *
 * WHAT COMES OUT
 * --------------
 * `{ pages: [{pageNumber, text}], pageCount }` — one entry per page for a PDF,
 * exactly one entry with `pageNumber: null` for plain text, which has no pages.
 * The caller chunks per page so every chunk can name its source page.
 *
 * PDF PAGE NUMBERS ARE REAL
 * -------------------------
 * §13 permits `page_number = null` if the parser cannot reliably give page
 * boundaries. It can: pdf-parse 2.x returns `{total, pages: [{num, text}]}`, so
 * the page numbers stored here come from the parser rather than from arithmetic.
 * The NULL path still exists and is still used — for plain text, and for any page
 * the parser returns with no text — because a wrong citation is worse than an
 * absent one.
 *
 * A NOTE ON pdf-parse's API
 * -------------------------
 * pdf-parse 2.x is ESM and class-based: `new PDFParse({data}).getText()`. Version
 * 1.x default-exported a function taking a Buffer. src/services/upload.service.js
 * still calls the 1.x form — `(await import("pdf-parse")).default` — which is
 * `undefined` under 2.4.5, so every PDF sent to POST /api/ask throws a TypeError
 * into that function's catch and the student receives "[A PDF was uploaded but
 * could not be parsed.]". That is a pre-existing bug, NOT introduced here, and
 * fixing it would change /api/ask's answers — which §19 forbids in this ticket.
 * It is recorded in docs/material-processing.md and in the final report so it can
 * be fixed deliberately, with its own test, rather than as a side effect of this
 * one. This module uses the 2.x API correctly.
 */

import { logger } from "../utils/logger.js";

/** Content types this module can extract. §8: PDF and plain text only. */
export const SUPPORTED_MIME_TYPES = Object.freeze([
  "application/pdf",
  "text/plain",
]);

/**
 * Thrown when a file cannot be extracted.
 *
 * Carries two messages on purpose. `message` is the internal one — parser text,
 * useful in a log. `safeMessage` is the only one the API will show a client: a
 * fixed string chosen from a small set, so no parser detail, filesystem path or
 * stack frame can reach a response through this path (§13, §20).
 */
export class ExtractionError extends Error {
  /**
   * @param {string} message internal detail, logged, never sent
   * @param {string} safeMessage client-safe explanation
   * @param {object} [options]
   * @param {unknown} [options.cause]
   */
  constructor(message, safeMessage, { cause } = {}) {
    super(message);
    this.name = "ExtractionError";
    this.safeMessage = safeMessage;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Extract text from a document.
 *
 * @param {object} input
 * @param {Buffer} input.buffer the file's bytes
 * @param {string} input.mimeType a validated type from SUPPORTED_MIME_TYPES
 * @returns {Promise<{pages: Array<{pageNumber: number|null, text: string}>, pageCount: number|null}>}
 * @throws {ExtractionError}
 */
export async function extractDocument({ buffer, mimeType }) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new ExtractionError(
      `extractDocument called with ${buffer?.byteLength ?? "no"} bytes`,
      "The uploaded file is empty.",
    );
  }

  switch (mimeType) {
    case "application/pdf":
      return extractPdf(buffer);
    case "text/plain":
      return extractPlainText(buffer);
    default:
      // Unreachable through the API — validation rejects other types with a 415
      // long before this. Throwing rather than defaulting means a future format
      // added to validation but not here fails loudly instead of silently
      // producing an empty document.
      throw new ExtractionError(
        `No extractor for ${JSON.stringify(mimeType)}`,
        "This file type is not supported.",
      );
  }
}

/**
 * Extract per-page text from a PDF.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{pages: Array<{pageNumber: number|null, text: string}>, pageCount: number|null}>}
 */
async function extractPdf(buffer) {
  // Imported lazily, as upload.service.js does: pdf-parse pulls in pdfjs-dist,
  // a sizeable dependency tree, and a server that never receives a PDF should
  // not pay for it at startup.
  const { PDFParse } = await import("pdf-parse");

  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();

    // `pages` is the per-page array; `total` is the page count the document
    // itself declares. A parser that returned neither is a parser this code does
    // not understand, so it is treated as a failure rather than as an empty
    // document — the difference matters, because an empty document must not
    // become `ready` (§17) and a broken parser must not look like an empty one.
    const rawPages = Array.isArray(result?.pages) ? result.pages : null;
    if (!rawPages) {
      throw new ExtractionError(
        "pdf-parse returned no pages array",
        "This PDF could not be read.",
      );
    }

    const pages = rawPages.map((page, position) => ({
      // `num` is the parser's own 1-based page number. Falling back to position
      // + 1 covers a parser that omits it; that is arithmetic, but it is
      // arithmetic over the parser's own page ORDER, not an invented boundary.
      pageNumber: Number.isInteger(page?.num) && page.num > 0 ? page.num : position + 1,
      text: typeof page?.text === "string" ? page.text : "",
    }));

    const pageCount =
      Number.isInteger(result?.total) && result.total > 0
        ? result.total
        : pages.length > 0
          ? pages.length
          : null;

    return { pages, pageCount };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;

    // Everything pdfjs can throw — InvalidPDFException, PasswordException, a
    // TypeError from a truncated stream — arrives here. The internal message is
    // logged by the caller via `cause`; the client gets one of three fixed
    // strings and never the parser's own words.
    throw new ExtractionError(
      `PDF extraction failed: ${err.message}`,
      classifyPdfFailure(err),
      { cause: err },
    );
  } finally {
    // pdfjs holds a worker and typed-array buffers per document. Not destroying
    // it leaks both for the process's lifetime, which on a server means every
    // upload permanently costs memory.
    if (parser) {
      await parser.destroy().catch((err) => {
        logger.warn(`pdf parser cleanup failed: ${err.message}`);
      });
    }
  }
}

/**
 * A client-safe explanation for a PDF failure.
 *
 * Three outcomes, chosen from the error's TYPE rather than by matching its
 * message text, so a reworded pdfjs error does not silently become the generic
 * case. The strings are deliberately unhelpful about internals and helpful about
 * what the user can do.
 *
 * @param {Error} err
 * @returns {string}
 */
function classifyPdfFailure(err) {
  if (err?.name === "PasswordException") {
    return "This PDF is password-protected. Remove the password and upload it again.";
  }
  if (err?.name === "InvalidPDFException") {
    return "This file is not a valid PDF, or it is damaged.";
  }
  return "This PDF could not be read.";
}

/**
 * Decode a plain-text upload.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{pages: Array<{pageNumber: number|null, text: string}>, pageCount: null}>}
 */
async function extractPlainText(buffer) {
  // fatal: false — the DEFAULT for TextDecoder, and the right choice here. Invalid
  // UTF-8 becomes U+FFFD rather than throwing, so a file that is mostly readable
  // with one bad byte still yields its text (§14: "handle invalid input safely").
  // A student's notes exported from a Windows editor in Latin-1 are exactly this
  // case, and rejecting the whole document over one accented character would be
  // the wrong trade.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

  // Replacement characters are stripped rather than kept: they are decode
  // failures, not content, and leaving them in would put "" into chunks that a
  // reader would then see. Their PRESENCE is not an error — only their count
  // relative to the document, checked below.
  const replacementCount = (text.match(/�/g) ?? []).length;

  // A file that is overwhelmingly undecodable is not text — it is a binary file
  // with a .txt extension, or text in an encoding this decoder cannot read. Either
  // way the "text" extracted from it is noise, and storing it would mean chunks
  // of garbage in the database. 30% is well clear of the handful of replacements a
  // genuine mis-encoded document produces.
  if (text.length > 0 && replacementCount / text.length > 0.3) {
    throw new ExtractionError(
      `text/plain upload is ${Math.round((replacementCount / text.length) * 100)}% undecodable`,
      "This file does not appear to be readable text.",
      // No cause: there is no underlying error, only a measurement.
    );
  }

  return {
    // One "page", numbered NULL. Plain text has no pages, and numbering it 1
    // would assert a page boundary that does not exist — §13's rule applied to
    // the format that most needs it.
    pages: [{ pageNumber: null, text: text.replaceAll("�", "") }],
    pageCount: null,
  };
}
