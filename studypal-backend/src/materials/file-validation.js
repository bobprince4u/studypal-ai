/**
 * Upload validation — deciding what a file actually IS.
 *
 * §8 is explicit: "Validate both: extension, MIME type. Do not trust either one
 * individually." Both are client-controlled, and neither is evidence:
 *
 *   • The extension is part of a filename the client typed. `notes.pdf` can hold
 *     anything at all.
 *   • The MIME type is the `Content-Type` header the client's HTTP library chose.
 *     Browsers guess it from the extension, so it is usually the same claim
 *     restated, and a script can send whatever it likes.
 *
 * So this module takes a third input the client does not control: the first bytes
 * of the file. The three must agree, and the type this module RETURNS is the one
 * derived from the content — that returned value is what the rest of the pipeline
 * and the `materials.mime_type` column record, so the type stored in the database
 * is the type the backend determined rather than the type the client asserted.
 *
 * WHAT "AGREE" MEANS FOR TEXT
 * ---------------------------
 * A PDF is identifiable: it starts with `%PDF-`. Plain text has no signature —
 * that is what makes it plain — so it cannot be positively identified, only
 * ruled out. The test is therefore inverted for text: the content must not look
 * like something else. A file claiming `text/plain` that begins with `%PDF-`,
 * `PK\x03\x04` or an ELF header is rejected; one that begins with "Photosynthesis"
 * is accepted because nothing contradicts the claim.
 *
 * That asymmetry is deliberate and worth stating plainly: this is not a virus
 * scanner and cannot be. The upload path's real safety comes from what the
 * backend never does with the bytes — never executes them, never passes them to a
 * shell, never uses the filename as a path, and only ever hands them to a PDF
 * parser or a UTF-8 decoder (§21's "no executable file handling").
 */

import { config } from "../config/env.js";
import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from "../utils/app-error.js";

/**
 * The two formats SP-V2-003 accepts, keyed by the extension the client used.
 *
 * `mimeType` is the canonical type stored for that format. `clientMimeTypes` is
 * what a client may plausibly claim for it — a set rather than a single value
 * because real clients are inconsistent: browsers send `text/plain` for `.txt`,
 * some send nothing at all, curl sends `application/octet-stream`, and Windows
 * has been known to send `application/x-pdf`. Rejecting an honest upload over a
 * header quirk would be a worse failure than accepting a slightly odd claim,
 * because the content check below is what actually decides.
 */
const SUPPORTED_FORMATS = Object.freeze({
  pdf: Object.freeze({
    mimeType: "application/pdf",
    clientMimeTypes: Object.freeze([
      "application/pdf",
      "application/x-pdf",
      "application/octet-stream",
    ]),
  }),
  txt: Object.freeze({
    mimeType: "text/plain",
    clientMimeTypes: Object.freeze([
      "text/plain",
      "text/markdown",
      "application/octet-stream",
    ]),
  }),
});

/** Extensions POST /api/materials accepts, for the multer filter and messages. */
export const ALLOWED_MATERIAL_EXTENSIONS = Object.freeze(
  Object.keys(SUPPORTED_FORMATS),
);

/**
 * Magic-byte signatures for formats that are NOT plain text.
 *
 * Used two ways: to confirm a PDF, and to rule out a binary masquerading as
 * text. The non-PDF entries exist only for the second purpose — this list is not
 * a claim to detect every binary format, just the ones common enough that a
 * mislabelled upload is plausible.
 */
const SIGNATURES = Object.freeze([
  { name: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
  { name: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] }, // also docx, xlsx, odt
  { name: "elf", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { name: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "gzip", bytes: [0x1f, 0x8b] },
  { name: "ole", bytes: [0xd0, 0xcf, 0x11, 0xe0] }, // legacy .doc/.xls
  { name: "rtf", bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] }, // "{\rtf"
  { name: "exe", bytes: [0x4d, 0x5a] }, // "MZ"
]);

/**
 * Which known signature a buffer starts with.
 *
 * @param {Buffer} buffer
 * @returns {string | null} signature name, or null if none matched
 */
function detectSignature(buffer) {
  for (const { name, bytes } of SIGNATURES) {
    if (buffer.byteLength < bytes.length) continue;
    if (bytes.every((byte, index) => buffer[index] === byte)) return name;
  }
  return null;
}

/**
 * The extension of a filename, lowercased.
 *
 * Takes the LAST dot-separated segment, so `notes.pdf.txt` is a `.txt` file — the
 * same rule every filesystem and browser uses. Deliberately a separate function
 * from src/services/upload.service.js's `extensionOf`: that one is part of
 * /api/ask's behaviour and §19 forbids changing it, so this module does not
 * import it and cannot drag a change into that endpoint.
 *
 * @param {string} filename
 * @returns {string} e.g. "pdf", or "" if there is no dot
 */
export function extensionOf(filename) {
  const name = String(filename ?? "");
  const dot = name.lastIndexOf(".");
  // `dot < 1` rather than `=== -1`: a leading dot (".txt") is an extensionless
  // dotfile, not a text file, and treating it as one would accept a filename
  // whose entire content is an extension.
  return dot < 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a buffer's NUL bytes are dense enough to call it binary.
 *
 * NUL is the oldest binary signal — real prose does not contain U+0000 — but
 * PRESENCE is the wrong test, and getting this wrong in either direction has a
 * cost:
 *
 *   • Rejecting on a single NUL throws out genuine documents. A NUL turns up in
 *     real text exports: a truncated write, a database dump, an editor that
 *     padded a block. §15 already handles that case by STRIPPING NUL bytes during
 *     normalization, and it can only do so for documents that got past validation.
 *   • Ignoring NULs entirely lets a binary with no known signature through to the
 *     UTF-8 decoder, which is a worse failure: it becomes a `failed` material with
 *     a confusing message instead of a clear 415.
 *
 * So the test is proportion. A binary is DENSE with NULs — UTF-16 text is roughly
 * half, a compiled object file is full of padding — while a damaged text file has
 * a handful at most. The floor of 4 matters as much as the 1%: without it a
 * 200-byte note containing one NUL would be judged by a ratio computed from almost
 * no evidence.
 *
 * Only the first 8 KB is sampled — enough to characterise the file, and bounded so
 * a 10 MB upload is not scanned in full for a decision its first page already
 * makes.
 *
 * This is a heuristic and is documented as one. It is not the security boundary;
 * as the module header says, that comes from what the backend never does with the
 * bytes.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  let nulls = 0;
  for (const byte of sample) {
    if (byte === 0x00) nulls++;
  }
  return nulls > Math.max(4, sample.byteLength * 0.01);
}

/**
 * Validate an uploaded file and determine its real type.
 *
 * @param {object} input
 * @param {string} input.filename the client's filename
 * @param {string} input.clientMimeType the client's Content-Type for the part
 * @param {Buffer} input.buffer the file's bytes
 * @returns {{mimeType: string, extension: string, size: number}} the type the
 *   BACKEND determined, which is what gets stored
 * @throws {AppError} 400 / 413 / 415, each with a client-safe message
 */
export function validateUpload({ filename, clientMimeType, buffer }) {
  if (!Buffer.isBuffer(buffer)) {
    throw badRequest("No file was uploaded.");
  }

  // §17 begins here: a zero-byte file cannot produce text, so it is refused at
  // the door rather than allowed to create a material that must then fail. 400
  // rather than 415 — the type is fine, the content is missing.
  if (buffer.byteLength === 0) {
    throw badRequest("The uploaded file is empty.");
  }

  // Checked here as well as by multer's `limits.fileSize`. Multer aborts the
  // stream, which is what protects memory; this catches a caller that reached
  // the service some other way, and keeps the limit meaningful in unit tests
  // that do not go through HTTP.
  if (buffer.byteLength > config.limits.materialUploadBytes) {
    throw payloadTooLarge(
      `File too large. Maximum size is ${megabytes(config.limits.materialUploadBytes)}MB`,
    );
  }

  const name = typeof filename === "string" ? filename : "";
  if (!name.trim()) {
    throw badRequest("The uploaded file has no filename.");
  }
  if (name.length > config.limits.materialFilenameLength) {
    throw badRequest(
      `Filename must be ${config.limits.materialFilenameLength} characters or fewer.`,
    );
  }

  const extension = extensionOf(name);
  const format = SUPPORTED_FORMATS[extension];
  if (!format) {
    throw unsupportedMediaType(
      `Unsupported file type. Allowed: ${ALLOWED_MATERIAL_EXTENSIONS.join(", ")}`,
    );
  }

  // The client's claim must at least be consistent with the extension. A missing
  // Content-Type is tolerated — some clients omit it, and the content check below
  // is the one that matters — but a claim that CONTRADICTS the extension is
  // rejected, because one of the two is then a lie and there is no way to tell
  // which.
  const claimed = String(clientMimeType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (claimed && !format.clientMimeTypes.includes(claimed)) {
    throw unsupportedMediaType(
      `The file's type (${describeSafely(claimed)}) does not match its .${extension} extension.`,
    );
  }

  const signature = detectSignature(buffer);

  if (extension === "pdf") {
    // Positive identification. `%PDF-` is required by the PDF specification and
    // pdfjs will refuse anything without it anyway — rejecting here means the
    // client gets a clear 415 instead of a material that reaches `failed`.
    if (signature !== "pdf") {
      throw unsupportedMediaType(
        "This file is not a PDF. Its contents do not match the .pdf extension.",
      );
    }
    return {
      mimeType: format.mimeType,
      extension,
      size: buffer.byteLength,
    };
  }

  // Text: ruled out rather than confirmed, as the header explains.
  if (signature) {
    throw unsupportedMediaType(
      "This file is not plain text. Its contents do not match the .txt extension.",
    );
  }
  if (looksBinary(buffer)) {
    throw unsupportedMediaType(
      "This file is not plain text. Its contents do not match the .txt extension.",
    );
  }

  return {
    mimeType: format.mimeType,
    extension,
    size: buffer.byteLength,
  };
}

/**
 * Round bytes to whole megabytes for a client-facing message.
 *
 * Matches the wording src/middleware/upload.js already uses for /api/ask, so the
 * two upload paths report their limits the same way.
 *
 * @param {number} bytes
 * @returns {number}
 */
export function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * A client-supplied string made safe to echo in an error message.
 *
 * The only place this API reflects client input back, and it exists because "your
 * type does not match your extension" is genuinely more useful when it says WHICH
 * type. Bounded to 64 characters and stripped of everything outside a
 * conservative allowlist, so a crafted Content-Type cannot inject control
 * characters into a log line or markup into a page that renders the error.
 *
 * @param {string} value
 * @returns {string}
 */
function describeSafely(value) {
  const cleaned = value.replaceAll(/[^a-z0-9/+.-]/gi, "").slice(0, 64);
  return cleaned || "unknown";
}

/** The formats table, for documentation and tests. */
export const supportedFormats = SUPPORTED_FORMATS;
