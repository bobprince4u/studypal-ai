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
import { indexMaterial } from "./material-indexing.service.js";

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
 * TWO LIFECYCLES, TWO FIELDS (SP-V2-004 §7)
 * -----------------------------------------
 * `status` and `indexingStatus` are reported separately because they answer
 * different questions, and merging them would have made one of the answers
 * unavailable:
 *
 *   status         can this document be read? (extracted, chunked, stored)
 *   indexingStatus can it be searched?        (chunks have vectors)
 *
 * `status: "ready"` kept the meaning SP-V2-003 gave it — successfully processed —
 * rather than being quietly widened to "processed AND indexed", which would have
 * changed what a value already in the database and already in a live contract
 * means. A material can be perfectly readable and not yet searchable, and a
 * student polling after an upload needs to be able to tell.
 *
 * The one combination worth explaining is `status: "failed"` with
 * `indexingStatus: "pending"`. A material that never produced chunks has no
 * embedding work outstanding, so nothing will ever move its indexing state — but
 * `pending` is still the truthful value (indexing has not run and has not failed),
 * and the failed `status` alongside it already explains why it never will.
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
    // Always present, never null — the column is NOT NULL with a default, so a
    // missing value here would mean a repository stopped selecting it, and a `??`
    // fallback would hide that rather than let a test catch it.
    indexingStatus: row.indexing_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (chunkCount !== undefined) view.chunkCount = chunkCount;

  // Only on a failed material, and only ever the sanitised string written by
  // material-processing.service.js. Omitted entirely when there is nothing to
  // report, rather than sent as null — an `error` key that is present but empty
  // reads like a bug in a client that checks for the key's existence.
  if (row.error_message) view.error = row.error_message;

  // The same treatment for the indexing lifecycle's error, and a separate key
  // rather than reusing `error`: the two failures are independent, a material can
  // have either or both, and one key would make "readable but not searchable"
  // indistinguishable from "unreadable". Also the sanitised string written by
  // material-indexing.service.js — no provider, model or quota detail (§32).
  if (row.indexing_error) view.indexingError = row.indexing_error;

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
 *   6. index it — embed its chunks, if it has any
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
 * STEP 6 IS A SEPARATE STEP FOR A REASON (SP-V2-004)
 * --------------------------------------------------
 * Indexing is called from here rather than from inside processMaterial, which
 * keeps material-processing.service.js deterministic, offline and free of any
 * provider dependency — see material-indexing.service.js for the full argument.
 * The consequence for this function is that upload now makes a network call to
 * Google, so it is slower than it was and it can be affected by an outage.
 *
 * It cannot FAIL because of one, though: indexMaterial never throws. An upload
 * that stored and extracted a document successfully returns 201 even when the
 * embedding provider is unreachable, and says so in `indexingStatus` rather than
 * discarding the work. §9's "leave the material non-indexed and do not claim it is
 * searchable" is that field.
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

  // Skipped for a failed material rather than left to the no-op path inside
  // indexMaterial. A material that never produced chunks has nothing to embed, and
  // saying that here — where the reader can see `status` — is clearer than two
  // queries that discover it.
  const indexed =
    processed.status === "ready" ? await indexAfterUpload(processed, user.id) : processed;

  // Counted rather than assumed: the response's chunkCount comes from the
  // database, so it reports what was actually persisted. Zero for a failed
  // material, which is correct — markFailed removes any chunks from an earlier
  // attempt.
  const chunkCount = await materialRepository.countChunks(indexed.id);

  return toApiShape(indexed, chunkCount);
}

/**
 * Index a freshly processed material and return its post-indexing row.
 *
 * The re-read is the point. `processed` was captured before indexing ran, so its
 * `indexing_status` is whatever it was then — `pending` — and returning it would
 * have the response tell a client "not indexed yet" about a material that is, at
 * that very moment, indexed. The client would poll /status once to learn something
 * the upload response could have told it.
 *
 * Reading the row back rather than deriving the status from indexMaterial's return
 * value keeps ONE authority for what a material's indexing state is: the table.
 * The derivation already exists, in SQL, inside saveEmbeddingsAndMarkIndexed —
 * reproducing it here from `{indexed, failed}` booleans would be a second copy to
 * keep in agreement with the first.
 *
 * @param {object} processed the row processMaterial returned
 * @param {number} userId
 * @returns {Promise<object>} the material row, re-read after indexing
 */
async function indexAfterUpload(processed, userId) {
  await indexMaterial({ materialId: processed.id });

  // Absent only if the material was deleted while this upload was still running —
  // possible, since DELETE takes an id and this request has not returned one yet.
  // The pre-index snapshot is then the most accurate thing left to describe what
  // the upload did, and it beats a TypeError on a path that genuinely succeeded.
  const reread = await materialRepository.findOwnedById(processed.id, userId);
  return reread ?? processed;
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
 * A deliberately narrow response — id, status, pageCount, chunkCount, the indexing
 * state and a safe error for each lifecycle — because this is the endpoint a client
 * polls. It is a subset of what GET /api/materials/:id returns rather than a
 * different shape, so nothing new has to be learned to read it.
 *
 * `indexingStatus` belongs here specifically BECAUSE this is the polled endpoint:
 * "can I ask questions about this document yet?" is the question a client polls to
 * answer, and before SP-V2-004 `status: "ready"` was a complete answer to it. It no
 * longer is, so the field a client now needs has to be reachable from the same
 * request rather than only from GET /api/materials/:id.
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
    indexingStatus: material.indexing_status,
  };
  if (material.error_message) status.error = material.error_message;
  if (material.indexing_error) status.indexingError = material.indexing_error;
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
