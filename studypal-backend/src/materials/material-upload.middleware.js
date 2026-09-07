/**
 * Multipart handling for POST /api/materials.
 *
 * Separate from src/middleware/upload.js, which serves /api/ask, and that
 * separation is the point rather than duplication. The two endpoints have
 * genuinely different rules: /api/ask accepts images, markdown, CSV and JSON
 * because it inlines them into a prompt, while /api/materials accepts PDF and TXT
 * only because it extracts, chunks and stores them. Sharing one middleware would
 * mean one endpoint's allowlist silently governing the other's — and §19 forbids
 * changing /api/ask's behaviour at all.
 *
 * The limits both come from config (§9: "Do not duplicate hard-coded limits
 * across the application"), so there is no number written here.
 *
 * WHY MEMORY STORAGE
 * ------------------
 * `multer.memoryStorage()` — the file arrives as a Buffer and multer never writes
 * to disk. multer's DiskStorage would create a temp file that this code would then
 * have to move, validate and clean up on every error path, and a temp file whose
 * name multer chooses is a filesystem path this backend does not otherwise have.
 * At a 10 MB cap, holding the buffer is bounded and the whole upload path stays
 * within one place that writes to disk: local-storage.service.js.
 */

import multer from "multer";

import { config } from "../config/env.js";
import {
  ALLOWED_MATERIAL_EXTENSIONS,
  extensionOf,
  megabytes,
} from "./file-validation.js";
import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from "../utils/app-error.js";

/** Marker on the rejection so the wrapper below can map it to a 415. */
const UNSUPPORTED_TYPE = "STUDYPAL_UNSUPPORTED_MATERIAL_TYPE";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.limits.materialUploadBytes,
    files: 1,
    // The only text field is `username`. A few more than one, because a browser's
    // FormData can carry incidentals, but far short of letting a client stuff a
    // multipart body with thousands of fields.
    fields: 5,
    fieldSize: 64 * 1024,
    // No `parts` beyond files + fields, and no `headerPairs` override: multer's
    // defaults for those are already conservative and naming them here would
    // imply they had been tuned.
  },
  fileFilter(_req, file, cb) {
    // An extension check only. It is the cheapest possible rejection and it runs
    // BEFORE the file is buffered, so an obviously wrong upload costs no memory.
    // The real decision — does the content match the claim — needs the bytes, so
    // it happens later in file-validation.js. This filter is a fast path, not the
    // security boundary.
    if (ALLOWED_MATERIAL_EXTENSIONS.includes(extensionOf(file.originalname))) {
      return cb(null, true);
    }
    const err = new Error("Unsupported file type");
    err.code = UNSUPPORTED_TYPE;
    cb(err);
  },
});

const single = upload.single("file");

/**
 * Parse a single required `file` part, mapping multer's errors to AppErrors.
 *
 * multer's own errors carry field names, internal codes and a stack; letting them
 * reach the central handler would serialise them as unexpected 500s and could
 * expose internals (§20). Every branch below produces a fixed, client-safe message.
 *
 * The file's PRESENCE is not checked here — that is the validator's job, so that
 * "no file" and "no username" are reported by the same layer in the same shape.
 */
export function acceptMaterialFile(req, res, next) {
  single(req, res, (err) => {
    if (!err) return next();

    if (err.code === UNSUPPORTED_TYPE) {
      return next(
        unsupportedMediaType(
          `Unsupported file type. Allowed: ${ALLOWED_MATERIAL_EXTENSIONS.join(", ")}`,
          { cause: err },
        ),
      );
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      return next(
        payloadTooLarge(
          `File too large. Maximum size is ${megabytes(config.limits.materialUploadBytes)}MB`,
          { cause: err },
        ),
      );
    }

    // Two codes, one mistake. multer distinguishes a file part under an
    // unexpected field name (LIMIT_UNEXPECTED_FILE) from a second part under the
    // expected one (LIMIT_FILE_COUNT), which is a distinction the client cannot
    // act on differently: either way the body did not carry exactly one `file`.
    // Both are 400 rather than 413 — the request is malformed, not oversized, and
    // answering 413 would tell a client to send a smaller file when the problem
    // is the number of parts.
    if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
      return next(
        badRequest('Send exactly one file, in a field named "file".', {
          cause: err,
        }),
      );
    }

    if (typeof err.code === "string" && err.code.startsWith("LIMIT_")) {
      return next(payloadTooLarge("Upload rejected.", { cause: err }));
    }

    // Not a multer limit — a malformed multipart body, usually. Busboy's messages
    // are not client-safe, so the message is fixed and the original goes in
    // `cause` for the log.
    return next(
      badRequest("The upload could not be read as a multipart form.", {
        cause: err,
      }),
    );
  });
}
