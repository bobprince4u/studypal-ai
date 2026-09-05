/**
 * Upload handling for POST /api/ask.
 *
 * The pre-refactor server used `multer({storage: multer.memoryStorage()})` with
 * no limits at all, so any client could push an arbitrarily large body straight
 * into the Node heap and any file type would be read and forwarded to Gemini.
 *
 * This adds the two bounds that were missing — a size cap and an extension
 * allowlist — without changing what the frontend is able to upload: the
 * allowlist is a superset of the file picker's `accept` attribute, and the
 * default 10 MB cap is well above anything the UI produces.
 */

import multer from "multer";

import { config } from "../config/env.js";
import { ALLOWED_EXTENSIONS, extensionOf } from "../services/upload.service.js";
import { payloadTooLarge, unsupportedMediaType } from "../utils/app-error.js";

/** Marker set on the rejection so the error handler can map it to a 415. */
const UNSUPPORTED_TYPE = "STUDYPAL_UNSUPPORTED_FILE_TYPE";

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.limits.uploadBytes,
    files: 1,
    // Text fields are small (username, question); this bounds the multipart
    // body as a whole rather than just the file part.
    fields: 10,
    fieldSize: 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    if (ALLOWED_EXTENSIONS.includes(extensionOf(file.originalname))) {
      return cb(null, true);
    }
    const err = new Error("Unsupported file type");
    err.code = UNSUPPORTED_TYPE;
    cb(err);
  },
});

const single = multerUpload.single("file");

/**
 * Accept at most one optional file under the field name "file".
 *
 * Wraps multer so its own error objects never reach the central error handler:
 * they carry field names and internal codes, and MulterError instances would
 * otherwise be serialised as unexpected 500s.
 */
export function acceptOptionalFile(req, res, next) {
  single(req, res, (err) => {
    if (!err) return next();

    if (err.code === UNSUPPORTED_TYPE) {
      return next(
        unsupportedMediaType(
          `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
          { cause: err },
        ),
      );
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      const mb = Math.round(config.limits.uploadBytes / (1024 * 1024));
      return next(
        payloadTooLarge(`File too large. Maximum size is ${mb}MB`, {
          cause: err,
        }),
      );
    }

    if (typeof err.code === "string" && err.code.startsWith("LIMIT_")) {
      return next(payloadTooLarge("Upload rejected", { cause: err }));
    }

    next(err);
  });
}
