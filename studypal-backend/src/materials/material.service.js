/**
 * Material use cases: upload, list, get, status, delete.
 *
 * The orchestration layer. It resolves the username to a user, calls validation,
 * storage, processing and the repository in the right order, and shapes what the
 * API returns. It never touches `req` or `res`, never writes SQL, and never calls
 * `fs` — those belong to the controller, the repository and
 * local-storage.service.js respectively.
 *
 * OWNERSHIP
 * ---------
 * Every function here takes a `username` and resolves it to a `users.id` through
 * the EXISTING src/repositories/user.repository.js (§6: "Reuse the repository's
 * existing user-resolution logic. Do not create a second users table."). The
 * resolved id then goes into the repository call, which filters on it in SQL. No
 * function in this file looks up a material by id alone.
 *
 * The asymmetry between upload and the read paths is deliberate and mirrors what
 * /api/ask already does: uploading CREATES the user on demand (a student who has
 * never logged in can still upload), while listing, reading and deleting do NOT —
 * reading a URL must not write a row. An unknown username therefore gets an empty
 * list, or a 404 for a specific material.
 *
 * THE LIMITATION, STATED PLAINLY
 * ------------------------------
 * A username is a claim, not a credential. Anyone who knows a student's username
 * can upload materials as them, list their documents and delete them. The
 * ownership checks below are real — they stop student A from reaching student B's
 * material by ID — but they cannot stop someone from simply asserting they ARE
 * student B. That is S1 in docs/security-baseline.md, it is unchanged by this
 * ticket (§21: "Do not attempt to solve authentication in this task"), and it is
 * the reason this API is not fit for real student data yet.
 */

import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import * as users from "../repositories/user.repository.js";
import * as storage from "../storage/local-storage.service.js";
import { badRequest, notFound } from "../utils/app-error.js";
import { validateUpload } from "./file-validation.js";
import * as materialRepository from "./material.repository.js";
import { processMaterial } from "./material-processing.service.js";

/**
 * The API's view of a material.
 *
 * The ONLY place a material row becomes a response body, so it is the only place
 * that decides what a client can see. Three things are absent by construction
 * rather than by remembering to delete them (§18, §21):
 *
 *   • `storage_key` — the repository's public column list does not select it, so
 *     it is not in `row` to leak.
 *   • any filesystem path — no path exists above local-storage.service.js at all;
 *     this module has never seen one.
 *   • `user_id` — an internal surrogate key. The client already knows which
 *     username it asked about, so returning the id only exposes an enumerable
 *     identifier.
 *
 * camelCase, following §18's example shape. That differs from the snake_case
 * `has_file` / `created_at` of GET /api/history, which is a contract this ticket
 * must not break (§19) — so the existing endpoints keep their casing and the new
 * ones use the casing the spec specifies. The inconsistency is real and
 * documented in docs/material-processing.md rather than fixed by changing a live
 * contract.
 *
 * @param {object} row a materials row with the repository's public columns
 * @param {number} [chunkCount] included when the caller has counted them
 * @returns {object}
 */
function toApiShape(row, chunkCount) {
  const view = {
    id: row.id,
    filename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    // NULL rather than absent when unknown: the key is always present, so a
    // client can read `pageCount` without checking whether it exists, and a null
    // says "this format has no pages or the parser could not tell" (§13).
    pageCount: row.page_count ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (chunkCount !== undefined) view.chunkCount = chunkCount;

  // Only on a failed material, and only ever the sanitised string written by
  // material-processing.service.js. Omitted entirely when there is nothing to
  // report, rather than sent as null — an `error` key that is present but empty
  // reads like a bug in a client that checks for the key's existence.
  if (row.error_message) view.error = row.error_message;

  return view;
}

/**
 * Upload, store and process a material.
 *
 * The ORDER here is the important part, and it is chosen so that no failure can
 * leave a state a client would be misled by:
 *
 *   1. validate the bytes — nothing is created for a file that will never work
 *   2. resolve/create the user
 *   3. write the file to storage
 *   4. insert the material row as `uploaded`
 *   5. process it to `ready` or `failed`
 *
 * Step 3 before step 4 means a storage failure leaves no row. Step 4 failing
 * after step 3 would leave a file with no row — an orphan — so that path deletes
 * the file explicitly (§7's "clean up partially written files when processing
 * fails", §11's "avoid leaving orphaned chunks or files").
 *
 * Processing failures are NOT cleaned up: a `failed` material keeps its row and
 * its file. That is deliberate. The student uploaded something, they should see it
 * in their list with a reason it did not work, and they should be able to delete
 * it themselves. Deleting it for them would make a failed upload silently vanish.
 *
 * @param {object} input
 * @param {string} input.username
 * @param {{originalname: string, mimetype: string, buffer: Buffer}} input.file
 * @returns {Promise<object>} the API view of the finished material
 */
export async function uploadMaterial({ username, file }) {
  if (!file) {
    throw badRequest("A file is required.");
  }

  // First, so an invalid upload costs no user row, no file and no material.
  // Throws a 400/413/415 AppError with a client-safe message.
  const { mimeType, size } = validateUpload({
    filename: file.originalname,
    clientMimeType: file.mimetype,
    buffer: file.buffer,
  });

  // Created on demand, exactly as /api/ask does — a student who has never called
  // POST /api/session can still upload. Uses the existing repository; there is no
  // second user table.
  const user = await users.upsert(username);

  const { key: storageKey } = await storage.save({
    buffer: file.buffer,
    mimeType,
  });

  let material;
  try {
    material = await materialRepository.insert({
      userId: user.id,
      // Stored as the client sent it, for display only. It is never a path: the
      // storage key above was generated independently and the filename does not
      // contribute to it.
      originalFilename: file.originalname,
      storageKey,
      mimeType,
      fileSize: size,
    });
  } catch (err) {
    // The row could not be created, so nothing references these bytes and
    // nothing ever will. Removed rather than left as an orphan — best-effort,
    // because the insert's error is the one worth propagating.
    await storage.removeQuietly(storageKey, "failed material insert");
    throw err;
  }

  const processed = await processMaterial({
    materialId: material.id,
    storageKey,
    mimeType,
  });

  // Counted rather than assumed: the response's chunkCount comes from the
  // database, so it reports what was actually persisted. Zero for a failed
  // material, which is correct — markFailed removes any chunks from an earlier
  // attempt.
  const chunkCount = await materialRepository.countChunks(processed.id);

  return toApiShape(processed, chunkCount);
}

/**
 * A user's materials, newest first.
 *
 * No document content, no chunk text — the repository's single query selects
 * neither (§10: "must not return document contents"). An unknown username gives
 * an empty array rather than a 404, matching GET /api/history: the frontend maps
 * over the result unguarded, and "this user has nothing" and "this user does not
 * exist" are the same answer to a client that cannot authenticate anyway.
 *
 * @param {string} username
 * @returns {Promise<Array<object>>} always an array
 */
export async function listMaterials(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) return [];

  const rows = await materialRepository.findByUserId(
    userId,
    config.limits.materialListItems,
  );

  return rows.map((row) => toApiShape(row, row.chunk_count));
}

/**
 * One material's metadata, if it belongs to this user.
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.username
 * @returns {Promise<object>}
 * @throws {AppError} 404 if it does not exist OR is not theirs
 */
export async function getMaterial({ id, username }) {
  const { material } = await requireOwnedMaterial({ id, username });
  const chunkCount = await materialRepository.countChunks(material.id);
  return toApiShape(material, chunkCount);
}

/**
 * A material's processing status.
 *
 * A deliberately narrow response — id, status, pageCount, chunkCount and a safe
 * error — because this is the endpoint a client polls. It is a subset of what GET
 * /api/materials/:id returns rather than a different shape, so nothing new has to
 * be learned to read it.
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.username
 * @returns {Promise<object>}
 * @throws {AppError} 404
 */
export async function getMaterialStatus({ id, username }) {
  const { material } = await requireOwnedMaterial({ id, username });
  const chunkCount = await materialRepository.countChunks(material.id);

  const status = {
    id: material.id,
    status: material.status,
    pageCount: material.page_count ?? null,
    chunkCount,
  };
  if (material.error_message) status.error = material.error_message;
  return status;
}

/**
 * Delete a material: its row, its chunks and its stored bytes.
 *
 * The order is row-then-file, and it matters. Deleting the row first means the
 * chunks go with it by `ON DELETE CASCADE` and the material stops being visible
 * to the API immediately. If the file removal then fails, the result is a few
 * orphaned bytes on disk — logged, invisible to every client, and reclaimable.
 * The other order risks the opposite: a file gone while the row still says
 * `ready`, which is a material that lies about being readable.
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.username
 * @returns {Promise<{id: number, deleted: true}>}
 * @throws {AppError} 404 if it does not exist OR is not theirs
 */
export async function deleteMaterial({ id, username }) {
  const userId = await requireUserId(username);

  const storageKey = await materialRepository.deleteOwnedById(id, userId);
  if (storageKey === undefined) {
    throw notFoundMaterial();
  }

  // Best-effort by design: the material is already gone as far as every client is
  // concerned, and turning a successful delete into a 500 over an unlinked file
  // would be the wrong trade. The leak is logged so it can be found.
  await storage.removeQuietly(storageKey, `delete of material ${id}`);

  logger.info(`material ${id} deleted`);
  return { id, deleted: true };
}

/**
 * Resolve a username to a user id, or 404.
 *
 * Read paths do not create users, so an unknown username on a per-material
 * endpoint is a 404 — the same answer as a material that does not exist, which is
 * what keeps the API from confirming whether a given id or username is real.
 *
 * @param {string} username
 * @returns {Promise<number>}
 */
async function requireUserId(username) {
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) throw notFoundMaterial();
  return userId;
}

/**
 * Fetch a material, requiring that it belongs to this username.
 *
 * The single choke point for §6's "Never trust a material ID alone for
 * user-scoped operations": every read path goes through here, and the repository
 * it calls has no by-id-only alternative to reach for.
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.username
 * @returns {Promise<{material: object, userId: number}>}
 */
async function requireOwnedMaterial({ id, username }) {
  const userId = await requireUserId(username);
  const material = await materialRepository.findOwnedById(id, userId);
  if (!material) throw notFoundMaterial();
  return { material, userId };
}

/**
 * The 404 every ownership failure produces.
 *
 * One message for four different situations — no such user, no such material,
 * someone else's material, already deleted — because distinguishing them would
 * tell an unauthenticated caller which material ids exist. 404 rather than 403
 * for the same reason: a 403 confirms the resource is real.
 *
 * @returns {import("../utils/app-error.js").AppError}
 */
function notFoundMaterial() {
  return notFound("Material not found.");
}
