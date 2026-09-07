/**
 * Material and chunk persistence — the only module with SQL for these tables.
 *
 * Same rules as src/repositories/question.repository.js: every value is a bind
 * parameter, nothing is concatenated, and no layer above this one writes SQL.
 * `original_filename` is client-controlled and arrives unsanitised by design;
 * `$1` is what makes that safe.
 *
 * OWNERSHIP IS IN THE WHERE CLAUSE, NOT IN THE CALLER
 * ---------------------------------------------------
 * Every per-material function takes a `userId` alongside the `id` and filters on
 * both. There is deliberately no `findById(id)` for the API to call: a function
 * that returns a material by id alone is one forgotten check away from letting
 * student A read student B's document, and the safest version of that function is
 * the one that does not exist. §6's "never trust a material ID alone" is
 * therefore a property of this module's INTERFACE rather than a rule callers have
 * to remember.
 *
 * A missing row and someone else's row are indistinguishable in the return value
 * — both are `undefined`. That is intentional: it lets the service answer 404 for
 * both without needing to know which happened, so the API never reveals that a
 * material id exists but belongs to another user.
 *
 * WHY THE COLUMN LISTS ARE EXPLICIT
 * ---------------------------------
 * No `SELECT *` anywhere. Two reasons, and the second is the one that matters:
 * `content` is large and the list endpoint must not load it (§29), and
 * `storage_key` must never reach a response (§18). Naming columns means a future
 * `ALTER TABLE` cannot quietly start feeding either of them into an API payload.
 */

import { query, withTransaction } from "../config/database.js";

/**
 * Columns the API layer is allowed to see. `storage_key` is absent on purpose —
 * it is fetched only by the functions that need to touch storage, and never by
 * the ones whose result is serialised.
 */
const PUBLIC_COLUMNS = `
  id, user_id, original_filename, mime_type, file_size,
  status, page_count, error_message, created_at, updated_at
`;

/**
 * The same columns qualified for the aliased `materials m` in findByUserId.
 *
 * Written out rather than derived from PUBLIC_COLUMNS by string manipulation:
 * two short lists a reader can compare are better than one list plus a regex
 * that rewrites it, and the schema test asserts both against the real table.
 */
const PUBLIC_COLUMNS_QUALIFIED = `
  m.id, m.user_id, m.original_filename, m.mime_type, m.file_size,
  m.status, m.page_count, m.error_message, m.created_at, m.updated_at
`;

/**
 * Insert a material in `uploaded` state.
 *
 * @param {object} record
 * @param {number} record.userId
 * @param {string} record.originalFilename client-controlled, display only
 * @param {string} record.storageKey backend-generated
 * @param {string} record.mimeType the type the backend determined
 * @param {number} record.fileSize bytes actually written
 * @param {import("pg").PoolClient} [client]
 * @returns {Promise<object>} the new row, public columns only
 */
export async function insert(
  { userId, originalFilename, storageKey, mimeType, fileSize },
  client,
) {
  const sql = `
    INSERT INTO materials
           (user_id, original_filename, storage_key, mime_type, file_size, status)
    VALUES ($1, $2, $3, $4, $5, 'uploaded')
    RETURNING ${PUBLIC_COLUMNS}
  `;
  const values = [userId, originalFilename, storageKey, mimeType, fileSize];
  const runner = client ?? { query };
  const { rows } = await runner.query(sql, values);
  return rows[0];
}

/**
 * One material, only if it belongs to this user.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<object | undefined>} undefined if absent OR not theirs
 */
export async function findOwnedById(id, userId) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}
       FROM materials
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0];
}

/**
 * A material's storage key, only if it belongs to this user.
 *
 * Separate from findOwnedById so the key is fetched only where storage is about
 * to be touched, and cannot be picked up incidentally by a caller that is going
 * to serialise its result.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<string | undefined>}
 */
export async function findOwnedStorageKey(id, userId) {
  const { rows } = await query(
    "SELECT storage_key FROM materials WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0]?.storage_key;
}

/**
 * A user's materials, newest first, with each one's chunk count.
 *
 * The LEFT JOIN LATERAL is what keeps this a single query: a straight
 * `SELECT ... FROM materials` followed by a count per row would be the N+1 §29
 * forbids, and a plain `LEFT JOIN material_chunks ... GROUP BY` would have to
 * group by every selected column and would build a much larger intermediate.
 * LATERAL runs the aggregate once per material row using the
 * material_chunks_material_index_key index, and returns one row per material.
 *
 * `content` is not selected here at any point — the aggregate counts rows, it
 * does not read text. Listing 100 materials transfers no document content.
 *
 * @param {number} userId
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
export async function findByUserId(userId, limit) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS_QUALIFIED},
            chunks.count AS chunk_count
       FROM materials m
       LEFT JOIN LATERAL (
              SELECT COUNT(*) AS count
                FROM material_chunks c
               WHERE c.material_id = m.id
            ) chunks ON TRUE
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * How many chunks a material has.
 *
 * @param {number} materialId
 * @returns {Promise<number>} a number, not pg's bigint string — the INT8 parser
 *   in src/config/pg-types.js handles that process-wide
 */
export async function countChunks(materialId) {
  const { rows } = await query(
    "SELECT COUNT(*) AS c FROM material_chunks WHERE material_id = $1",
    [materialId],
  );
  return rows[0].c;
}

/**
 * Move a material to `processing`, but only from `uploaded`.
 *
 * The status is in the WHERE clause, so this is a compare-and-set rather than a
 * blind UPDATE: two concurrent processing attempts on the same material cannot
 * both win, because the second finds no row in `uploaded` and gets `undefined`.
 * Nothing runs concurrently today (§30: processing is synchronous), which is
 * exactly why it is worth making the transition safe now — the guarantee is free
 * here and would be an afterthought once a queue exists.
 *
 * @param {number} id
 * @returns {Promise<object | undefined>} the updated row, or undefined if the
 *   material was not in `uploaded`
 */
export async function markProcessing(id) {
  const { rows } = await query(
    `UPDATE materials
        SET status = 'processing', updated_at = now()
      WHERE id = $1 AND status = 'uploaded'
      RETURNING ${PUBLIC_COLUMNS}`,
    [id],
  );
  return rows[0];
}

/**
 * Persist chunks and mark the material `ready`, atomically.
 *
 * ONE transaction, and that is the point (§11, §29). `ready` is the API's promise
 * that a material's text is retrievable, so the insert of the chunks and the
 * write of the status must either both happen or neither: a crash between them
 * would otherwise leave a `ready` material with no chunks, which is precisely the
 * misleading state §11 prohibits.
 *
 * Chunks go in with a single multi-row INSERT rather than one statement each. At
 * 10 MB the worst case is a few thousand chunks, which is one statement of a few
 * megabytes — well within what PostgreSQL takes happily, and far cheaper than a
 * few thousand round trips.
 *
 * Empty `chunks` is rejected rather than committed: a document that produced no
 * chunks must not become `ready` (§17). The service checks for this earlier and
 * fails the material properly; this is the backstop that makes the invariant
 * impossible to violate through this function.
 *
 * @param {object} input
 * @param {number} input.materialId
 * @param {Array<{index: number, content: string, pageNumber: number|null, charCount: number}>} input.chunks
 * @param {number|null} input.pageCount
 * @returns {Promise<object>} the material row, now `ready`
 */
export async function saveChunksAndMarkReady({ materialId, chunks, pageCount }) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error(
      `Refusing to mark material ${materialId} ready with no chunks`,
    );
  }

  return withTransaction(async (client) => {
    // Re-processing the same material would otherwise collide with
    // material_chunks_material_index_key. Deleting first inside the same
    // transaction makes the operation idempotent: the material's chunk set is
    // replaced wholesale, never merged into. No path re-processes today, and the
    // alternative is an integrity error for a future one to debug.
    await client.query("DELETE FROM material_chunks WHERE material_id = $1", [
      materialId,
    ]);

    // Four parallel arrays expanded by unnest, so the statement has a FIXED four
    // placeholders regardless of chunk count. Building `($1,$2,$3,$4),($5,...)`
    // instead would be a statement whose text changes with every document,
    // defeating PostgreSQL's plan cache and risking the 65535-parameter ceiling
    // at around 16k chunks. The casts on the arrays are required: pg sends a JS
    // array as an untyped array literal and unnest needs to know the element
    // type.
    await client.query(
      `INSERT INTO material_chunks
              (material_id, chunk_index, content, page_number, char_count)
       SELECT $1,
              chunk.index,
              chunk.content,
              chunk.page_number,
              chunk.char_count
         FROM unnest($2::int[], $3::text[], $4::int[], $5::int[])
              AS chunk(index, content, page_number, char_count)`,
      [
        materialId,
        chunks.map((chunk) => chunk.index),
        chunks.map((chunk) => chunk.content),
        // `?? null` rather than leaving undefined: pg encodes undefined as NULL
        // too, but relying on that makes the intent unreadable. NULL here is the
        // deliberate "page unknown" of §13.
        chunks.map((chunk) => chunk.pageNumber ?? null),
        chunks.map((chunk) => chunk.charCount),
      ],
    );

    const { rows } = await client.query(
      `UPDATE materials
          SET status = 'ready',
              page_count = $2,
              -- Cleared explicitly. A material that failed and was re-processed
              -- would otherwise keep a stale error, and
              -- materials_error_message_matches_status would reject the row.
              error_message = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING ${PUBLIC_COLUMNS}`,
      [materialId, pageCount],
    );

    if (!rows[0]) {
      // The material vanished mid-processing — deleted by its owner while the
      // document was being parsed. Throwing rolls back the chunk insert, so no
      // orphans are left behind pointing at a row that no longer exists.
      throw new Error(`Material ${materialId} disappeared during processing`);
    }

    return rows[0];
  });
}

/**
 * Mark a material `failed` with a client-safe reason.
 *
 * `safeMessage` is written to `error_message`, which the API returns verbatim, so
 * the caller is responsible for it containing no parser output, no filesystem
 * path and no stack frame. src/materials/material.service.js is the only caller
 * and takes the string from ExtractionError.safeMessage, which is chosen from a
 * fixed set.
 *
 * Any chunks from an earlier attempt are removed in the same statement pair: a
 * `failed` material must not leave content behind that a later reader could take
 * for the real thing (§11's "avoid leaving orphaned chunks").
 *
 * @param {number} id
 * @param {string} safeMessage
 * @returns {Promise<object | undefined>}
 */
export async function markFailed(id, safeMessage) {
  return withTransaction(async (client) => {
    await client.query("DELETE FROM material_chunks WHERE material_id = $1", [
      id,
    ]);

    const { rows } = await client.query(
      `UPDATE materials
          SET status = 'failed',
              error_message = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING ${PUBLIC_COLUMNS}`,
      [id, safeMessage],
    );
    return rows[0];
  });
}

/**
 * Chunks of one material, in document order.
 *
 * Not currently reached by any endpoint — no API exposes chunk text in SP-V2-003,
 * and §10's list and get endpoints are explicit that they return no document
 * contents. It exists because the persistence tests must verify what was
 * actually written (§22), and it is the function SP-V2-004's retrieval will read
 * through. Kept here rather than in a test helper so the SQL stays in the
 * repository layer where the architecture checks expect it.
 *
 * @param {number} materialId
 * @returns {Promise<Array<{chunk_index: number, content: string, page_number: number|null, char_count: number}>>}
 */
export async function findChunksByMaterialId(materialId) {
  const { rows } = await query(
    `SELECT chunk_index, content, page_number, char_count
       FROM material_chunks
      WHERE material_id = $1
      ORDER BY chunk_index ASC`,
    [materialId],
  );
  return rows;
}

/**
 * Delete a material, if it belongs to this user.
 *
 * Chunks go with it via `ON DELETE CASCADE` on material_chunks.material_id —
 * deliberately not deleted here first. The database enforcing it means there is
 * no application path that could forget, and tests/materials/schema.test.js
 * asserts the cascade at the SQL level rather than only through this function.
 *
 * Returns the storage key so the caller can remove the bytes. The row is gone by
 * then, so this is the last moment the key is knowable — which is why it is
 * returned rather than looked up separately: a crash between a delete and a
 * second lookup would orphan the file permanently.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<string | undefined>} the deleted material's storage key, or
 *   undefined if there was nothing of theirs to delete
 */
export async function deleteOwnedById(id, userId) {
  const { rows } = await query(
    `DELETE FROM materials
      WHERE id = $1 AND user_id = $2
      RETURNING storage_key`,
    [id, userId],
  );
  return rows[0]?.storage_key;
}
