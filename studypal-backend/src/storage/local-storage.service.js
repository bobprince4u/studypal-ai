/**
 * Object storage — the ONLY module in the backend that touches the filesystem.
 *
 * Four operations: save, read, delete, exists. Everything above this line deals
 * in opaque storage KEYS and never in paths, which is what makes the eventual
 * move to S3 or GCS a replacement of this file rather than a search across the
 * codebase for `fs.` and `path.join`. Controllers and services import these
 * functions; none of them imports `node:fs`.
 *
 * THE THREAT MODEL
 * ----------------
 * The one interesting thing a file store must not do is let a caller name a path
 * outside itself. Uploaded filenames are attacker-controlled and routinely
 * contain `../`, absolute paths, NUL bytes, Windows separators, URL escapes and
 * Unicode that normalises into separators. So keys here are not filenames at all:
 *
 *   • `generateKey()` MAKES the key — a UUID plus an extension from the
 *     already-validated content type. The client's filename contributes nothing
 *     to it, not even a sanitised form of it. There is no code path that turns a
 *     filename into a key, because the safest sanitiser is the one you never
 *     have to write.
 *   • Every entry point re-validates the key against KEY_PATTERN, which permits
 *     no separator, no dot-segment and no leading dot. A key that came back from
 *     the database is checked exactly as strictly as one from anywhere else: a
 *     stored value is not more trustworthy than a fresh one, it is merely older.
 *   • `resolvePath()` then confirms the resolved absolute path is still inside
 *     the configured root. This is redundant given the pattern check, and it
 *     stays: a defence that only works while a regex is correct is one edit away
 *     from not working.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No S3, no GCS, no signed URLs, no streaming, no content-addressing, no
 * deduplication, no encryption at rest. Uploads are capped at 10 MB (§9), so a
 * whole-buffer write is the honest implementation; streaming machinery for files
 * that cannot exceed ten megabytes would be complexity bought on credit. The
 * seam is the four-function interface, not a plugin system: SP-V2-00x swaps the
 * body of these functions and every caller is unchanged.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Extensions this store will produce, by validated content type.
 *
 * The extension exists purely so a human looking in the storage directory can
 * tell a PDF from a text file; nothing reads it back. It is derived from the
 * type the BACKEND determined, never from the name the client sent.
 */
const EXTENSION_BY_MIME_TYPE = Object.freeze({
  "application/pdf": "pdf",
  "text/plain": "txt",
});

/**
 * The shape of every key this module accepts.
 *
 * Deliberately narrower than "a safe filename": it matches what generateKey()
 * produces and nothing else. One path segment, starting with an alphanumeric —
 * which rules out `.`, `..`, `.hidden` and anything beginning with a separator —
 * and containing only characters that are literal on every filesystem. No `/`,
 * no `\`, no NUL, no whitespace, no Unicode.
 *
 * Kept in sync with the materials_storage_key_safe CHECK constraint in
 * migrations/postgres/002_materials.sql. Both exist because they fail at
 * different times: the constraint stops a bad key being STORED, this stops one
 * being USED.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Generate a storage key for a validated upload.
 *
 * @param {string} mimeType a type from EXTENSION_BY_MIME_TYPE. Anything else
 *   throws — an unrecognised type here means validation upstream let something
 *   through, and inventing a default extension would hide that.
 * @returns {string} e.g. "9f1c3b1e8a244d7f9c2e5a6b7d8e9f01.pdf"
 */
export function generateKey(mimeType) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!extension) {
    throw new Error(
      `Cannot generate a storage key for unsupported type ${JSON.stringify(mimeType)}`,
    );
  }
  // randomUUID with the hyphens removed: 128 bits of entropy, so keys cannot be
  // guessed or enumerated even though nothing about the store relies on that.
  // Hyphens removed only because an unbroken hex string is easier to select.
  return `${crypto.randomUUID().replaceAll("-", "")}.${extension}`;
}

/**
 * Absolute path for a key, proven to be inside the storage root.
 *
 * @param {string} key
 * @returns {string}
 * @throws {Error} if the key is not one this store could have generated, or if
 *   the resolved path escapes the root
 */
function resolvePath(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    // The key is quoted rather than interpolated bare, so a control character in
    // it cannot rewrite the log line. This message reaches logs, never a client.
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }

  const root = config.storage.dir;
  const resolved = path.resolve(root, key);

  // The belt-and-braces check described in the header. `path.resolve` collapses
  // `..` segments, so this compares final locations rather than the strings that
  // produced them. `path.sep` is appended to the root so a sibling directory
  // whose name merely starts with the root's name (`/data/uploads-evil`) does
  // not pass a naive prefix test.
  if (resolved !== path.join(root, key) || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Storage key escapes the storage root: ${JSON.stringify(key)}`);
  }

  return resolved;
}

/** Create the storage directory if it is not there yet. Idempotent. */
async function ensureRoot() {
  // recursive: true is also "do not throw if it exists", which is what makes
  // this safe to call before every write rather than once at startup — the
  // directory can be removed underneath a running server.
  await fs.mkdir(config.storage.dir, { recursive: true, mode: 0o700 });
}

/**
 * Write bytes under a newly generated key.
 *
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.mimeType validated type, used only for the extension
 * @returns {Promise<{key: string, size: number}>}
 */
export async function save({ buffer, mimeType }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("save() requires a Buffer");
  }

  const key = generateKey(mimeType);
  const target = resolvePath(key);

  await ensureRoot();

  // `wx` fails if the path already exists rather than truncating it. A UUID
  // collision is not a realistic worry; a bug that reused a key is, and this
  // turns that into a loud EEXIST instead of one material silently overwriting
  // another's bytes.
  //
  // mode 0600: the files are read by this process only. The default 0644 would
  // make every student's uploads world-readable on a shared host.
  await fs.writeFile(target, buffer, { flag: "wx", mode: 0o600 });

  return { key, size: buffer.byteLength };
}

/**
 * Read the bytes stored under a key.
 *
 * @param {string} key
 * @returns {Promise<Buffer>}
 * @throws {Error} ENOENT if the key is not in the store
 */
export async function read(key) {
  return fs.readFile(resolvePath(key));
}

/**
 * Remove the object stored under a key.
 *
 * Idempotent: deleting a key that is not there is a success, not an error. That
 * matters for the cleanup paths — a failed upload may be cleaned up twice (once
 * by the failure handler, once by a later DELETE), and neither call should turn
 * a tidy-up into a 500.
 *
 * @param {string} key
 * @returns {Promise<boolean>} true if a file was removed, false if there was
 *   nothing to remove
 */
export async function remove(key) {
  const target = resolvePath(key);
  try {
    await fs.unlink(target);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Best-effort delete for cleanup paths.
 *
 * Swallows every error and logs it, because the caller is already handling a
 * failure and a secondary storage error must not replace the primary one. The
 * leaked file is recorded so it can be found later; losing the original error
 * would be worse than leaking a few bytes.
 *
 * @param {string} key
 * @param {string} [reason] included in the log line, for traceability
 */
export async function removeQuietly(key, reason = "cleanup") {
  try {
    await remove(key);
  } catch (err) {
    logger.warn(
      `storage: failed to remove ${key} during ${reason}: ${err.message}`,
    );
  }
}

/**
 * @param {string} key
 * @returns {Promise<boolean>} whether an object exists under this key
 */
export async function exists(key) {
  try {
    // stat rather than access: it also tells us the entry is a regular file, so
    // a directory that somehow acquired a key's name does not read as present.
    const stats = await fs.stat(resolvePath(key));
    return stats.isFile();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The configured root, for diagnostics and tests.
 *
 * Exported so the tests can assert where bytes landed without importing config
 * themselves. NOT for building paths: callers deal in keys.
 */
export function storageRoot() {
  return config.storage.dir;
}
