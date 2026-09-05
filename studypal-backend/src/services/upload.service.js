/**
 * Turning an uploaded file into model input.
 *
 * Extracted from server.js:83-109. The dispatch on file extension, the mime
 * mapping, the 4000-character truncation and the PDF fallback text are all
 * unchanged, because each of them is observable in the answer the student gets.
 *
 * Type *validation* happens earlier, in src/middleware/upload.js — by the time
 * a file reaches this module its extension is already on the allowlist.
 */

import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

/** Extensions sent as native image input. */
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];

/** Extensions extracted to text before being sent. */
export const DOCUMENT_EXTENSIONS = ["pdf"];

/** Extensions read as UTF-8 text. Anything not listed above falls here. */
export const TEXT_EXTENSIONS = ["txt", "md", "csv", "json", "log"];

/** Every extension POST /api/ask accepts. */
export const ALLOWED_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...TEXT_EXTENSIONS,
];

/**
 * @param {string} filename
 * @returns {string} lowercased extension, or "" if there is no dot
 */
export function extensionOf(filename) {
  const parts = String(filename ?? "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

/**
 * Gemini mime type for an image extension. `jpg` is special-cased because
 * `image/jpg` is not a real mime type.
 * @param {string} ext
 * @returns {string}
 */
function imageMimeType(ext) {
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

/**
 * Extract text from a PDF buffer.
 *
 * pdf-parse is imported lazily, as it was before: it is only needed for PDF
 * uploads and pulls in a sizeable dependency tree at import time.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string|null>} extracted text, or null if parsing failed
 */
async function extractPdfText(buffer) {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text.slice(0, config.limits.documentTextChars);
  } catch (err) {
    logger.warn(`PDF could not be parsed: ${err.message}`);
    return null;
  }
}

/**
 * Convert a multer file into @google/genai parts.
 *
 * @param {{originalname: string, buffer: Buffer}} file
 * @returns {Promise<Array<object>>} parts to append to the user turn
 */
export async function buildAttachmentParts(file) {
  const ext = extensionOf(file.originalname);

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return [
      {
        inlineData: {
          data: file.buffer.toString("base64"),
          mimeType: imageMimeType(ext),
        },
      },
    ];
  }

  if (ext === "pdf") {
    const text = await extractPdfText(file.buffer);
    return [
      {
        text:
          text === null
            ? "\n[A PDF was uploaded but could not be parsed.]"
            : `\n[Uploaded PDF content]:\n${text}`,
      },
    ];
  }

  const text = file.buffer
    .toString("utf-8")
    .slice(0, config.limits.documentTextChars);
  return [{ text: `\n[Uploaded file content]:\n${text}` }];
}
