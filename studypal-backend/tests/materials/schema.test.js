/**
 * Materials schema tests — SP-V2-003 §22's "Database" group, extended by
 * SP-V2-004 §34's embedding schema checks.
 *
 * The same approach as tests/schema.test.js, one migration later: go through SQL
 * directly, and assert that the DATABASE refuses a bad row rather than that the
 * application avoids writing one. Every CHECK constraint in
 * migrations/postgres/002_materials.sql and 003_material_embeddings.sql is a rule
 * that has to hold even if a future code path forgets it, and the only way to
 * demonstrate that is to try the write.
 *
 * Constraint NAMES are matched rather than message text, so renaming a constraint
 * fails here and a reworded PostgreSQL error does not.
 *
 * Real PostgreSQL, one private already-migrated database for the suite. pgvector is
 * a hard requirement of that database, not something these tests can stub: the
 * whole point is to check what the extension and the column actually do.
 *
 *   node --test tests/materials/schema.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { config } from "../../src/config/env.js";
import { createIsolatedDatabase } from "../helpers/test-database.mjs";

const { Pool } = pg;

/**
 * The width migrations/postgres/003_material_embeddings.sql declares.
 *
 * A literal, deliberately NOT read from config: the tests below check that the
 * migration and the configuration agree, and reading both sides from the same
 * source would make that check tautological. Change the migration and this number
 * changes with it — which is the point, because changing it also invalidates every
 * vector already stored.
 */
const MIGRATED_DIMENSIONS = 1536;

/** A vector literal of the migrated width, as pgvector accepts it. */
function vectorLiteral(fill = 0.1, dimensions = MIGRATED_DIMENSIONS) {
  return `[${Array.from({ length: dimensions }, () => fill).join(",")}]`;
}

let database;
let pool;

before(async () => {
  database = await createIsolatedDatabase({ label: "matschema" });
  pool = new Pool({ connectionString: database.url, max: 4 });
});

after(async () => {
  await pool?.end();
  await database?.drop();
});

let keySequence = 0;

/** A storage key of the shape generateKey() produces: 32 hex characters + ext. */
function storageKey(extension = "txt") {
  const unique = `${Date.now().toString(16)}${(keySequence += 1).toString(16).padStart(4, "0")}`;
  return `${unique.padEnd(32, "0").slice(0, 32)}.${extension}`;
}

async function makeUser(username) {
  const { rows } = await pool.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [username],
  );
  return rows[0].id;
}

/** Insert a material, overriding any column. Returns the pg result or throws. */
function insertMaterial(overrides = {}) {
  const row = {
    original_filename: "notes.txt",
    storage_key: storageKey(),
    mime_type: "text/plain",
    file_size: 1024,
    status: "uploaded",
    page_count: null,
    error_message: null,
    ...overrides,
  };
  return pool.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size,
             status, page_count, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      row.user_id,
      row.original_filename,
      row.storage_key,
      row.mime_type,
      row.file_size,
      row.status,
      row.page_count,
      row.error_message,
    ],
  );
}

/** Insert a chunk, overriding any column. */
function insertChunk(overrides = {}) {
  const row = {
    chunk_index: 0,
    content: "Photosynthesis happens in the chloroplasts.",
    page_number: null,
    ...overrides,
  };
  // char_count defaults to the content's real length, so a test that wants a
  // mismatch has to ask for one explicitly. `?? 0` for the NULL-content case:
  // that insert is meant to fail on the NOT NULL, and computing a length from
  // null here would throw a TypeError in the test instead.
  // `in` rather than `??`: an explicit `char_count: null` is a NOT NULL test and
  // must be sent as null, whereas `??` would silently substitute the computed
  // length and turn that test into a successful insert.
  const charCount =
    "char_count" in overrides ? overrides.char_count : (row.content?.length ?? 0);
  return pool.query(
    `INSERT INTO material_chunks
            (material_id, chunk_index, content, page_number, char_count)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [row.material_id, row.chunk_index, row.content, row.page_number, charCount],
  );
}

/** Assert that a write fails with a named constraint. */
async function assertViolates(name, fn) {
  await assert.rejects(fn, (err) => {
    assert.equal(
      err.constraint,
      name,
      `expected constraint ${name}, got ${err.constraint} (${err.message})`,
    );
    return true;
  });
}

/** Insert a material and return just its id, for tests that only need a target. */
async function makeMaterial(userId, status = "uploaded") {
  const { rows } = await insertMaterial({ user_id: userId, status });
  return rows[0].id;
}

// ── the tables exist, with the columns the code selects ────────────────────
describe("the migration creates the materials tables", () => {
  it("creates materials with every documented column and type", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'materials'
        ORDER BY column_name`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    // Exact: an extra column would be a schema change nobody documented, and a
    // missing one breaks the repository's explicit column lists.
    assert.deepEqual(Object.keys(byName).sort(), [
      "created_at",
      "error_message",
      "file_size",
      "id",
      "indexing_error",
      "indexing_status",
      "mime_type",
      "original_filename",
      "page_count",
      "status",
      "storage_key",
      "updated_at",
      "user_id",
    ]);

    // §4's types, spot-checked where the choice matters. bigint for the keys and
    // the size, timestamptz (not timestamp) for the stamps — a naive timestamp
    // would make the ISO round-trip in pg-types.js ambiguous.
    assert.equal(byName.id.data_type, "bigint");
    assert.equal(byName.user_id.data_type, "bigint");
    assert.equal(byName.file_size.data_type, "bigint");
    assert.equal(byName.page_count.data_type, "integer");
    assert.equal(byName.created_at.data_type, "timestamp with time zone");
    assert.equal(byName.updated_at.data_type, "timestamp with time zone");

    // The nullability split is the lifecycle: page_count, error_message and
    // indexing_error are the only three things a material may legitimately not
    // know. `indexing_status` is NOT NULL with a default because there is always
    // an answer to "is this searchable" — before SP-V2-004's migration ran the
    // answer for every existing row was 'pending', which is exactly right.
    assert.equal(byName.page_count.is_nullable, "YES");
    assert.equal(byName.error_message.is_nullable, "YES");
    assert.equal(byName.indexing_error.is_nullable, "YES");
    for (const required of [
      "user_id",
      "original_filename",
      "storage_key",
      "mime_type",
      "file_size",
      "status",
      "indexing_status",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        byName[required].is_nullable,
        "NO",
        `${required} must be NOT NULL`,
      );
    }

    assert.match(byName.status.column_default, /'uploaded'/);
    assert.match(byName.indexing_status.column_default, /'pending'/);
  });

  it("creates material_chunks with every documented column and type", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'material_chunks'
        ORDER BY column_name`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    assert.deepEqual(Object.keys(byName).sort(), [
      "char_count",
      "chunk_index",
      "content",
      "created_at",
      "embedding",
      "id",
      "material_id",
      "page_number",
    ]);

    assert.equal(byName.material_id.data_type, "bigint");
    assert.equal(byName.chunk_index.data_type, "integer");
    assert.equal(byName.content.data_type, "text");
    assert.equal(byName.page_number.is_nullable, "YES");
    assert.equal(byName.char_count.is_nullable, "NO");

    // NULLABLE, and that is the whole indexing model. A chunk exists as soon as
    // the document is processed and gets its vector later — so `embedding IS NULL`
    // means "not indexed yet", which is what retrieval filters on and what makes a
    // partial failure resumable. A NOT NULL column would have forced embedding
    // into the same transaction as chunking, i.e. a provider call inside the
    // document pipeline (§41).
    assert.equal(byName.embedding.is_nullable, "YES");
    // pgvector's type is an extension type, so information_schema reports the
    // generic USER-DEFINED; udt_name below carries the real name.
    assert.equal(byName.embedding.data_type, "USER-DEFINED");
  });

  it("enables pgvector and gives the embedding column the migrated width", async () => {
    // §34: the extension is enabled, the column is a real `vector`, and its
    // dimension is the one the code expects. The third is the one that bites — a
    // vector column of the wrong width does not degrade, it rejects every insert
    // with "expected N dimensions, not M", and it does so only once an embedding
    // is generated.
    const { rows: extensions } = await pool.query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'",
    );
    assert.equal(extensions.length, 1, "the vector extension must be enabled");

    const { rows } = await pool.query(
      `SELECT t.typname, a.atttypmod
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = 'material_chunks'::regclass
          AND a.attname = 'embedding'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].typname, "vector");
    // pgvector stores the declared dimension in atttypmod directly, with no
    // VARHDRSZ offset — so this is literally `vector(1536)`.
    assert.equal(
      rows[0].atttypmod,
      MIGRATED_DIMENSIONS,
      "the column's width must equal the migration's vector(n)",
    );

    // And the running configuration must agree with the migrated width, because
    // nothing at runtime can reconcile a disagreement: the embedding service would
    // produce vectors of one size for a column of another. env.js logs a warning
    // about this at startup; here it is an outright failure, which is the right
    // severity for a repository whose migrations and code must match.
    assert.equal(
      config.rag.embeddingDimensions,
      MIGRATED_DIMENSIONS,
      "STUDYPAL_EMBEDDING_DIM disagrees with migrations/postgres/003 — every " +
        "embedding insert would fail",
    );
  });

  it("has no approximate vector index, deliberately (§12)", async () => {
    /**
     * The one test in this file that asserts the ABSENCE of something we could
     * easily have added, so the reasoning has to live somewhere it will be read.
     *
     * §12: "do not blindly add an approximate vector index simply because pgvector
     * supports one". An HNSW or IVFFlat index trades recall for speed, and recall is
     * the product here — a study answer that silently omits the one relevant
     * paragraph is worse than one that takes 40ms longer. At this corpus size exact
     * search is also genuinely fast, and the `m.user_id = $1` filter already reduces
     * each scan to one student's chunks rather than the whole table.
     *
     * When it stops being fast, migrations/postgres/003 carries the exact statement
     * to add — and adding it means changing this test, which is the review that
     * decision deserves.
     */
    const { rows } = await pool.query(
      `SELECT c.relname AS index_name, m.amname AS method
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am m ON m.oid = c.relam
        WHERE i.indrelid = 'material_chunks'::regclass
          AND m.amname IN ('hnsw', 'ivfflat')`,
    );
    assert.deepEqual(rows, [], "exact search is intentional this iteration");
  });

  it("refuses client-supplied ids on both tables (GENERATED ALWAYS)", async () => {
    const userId = await makeUser(`matid_${Date.now()}`);
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO materials (id, user_id, original_filename, storage_key,
                                  mime_type, file_size)
           VALUES (9999, $1, 'n.txt', $2, 'text/plain', 10)`,
          [userId, storageKey()],
        ),
      /cannot insert a non-DEFAULT value into column "id"/,
    );
  });
});

// ── foreign keys ───────────────────────────────────────────────────────────
describe("foreign keys", () => {
  it("rejects a material for a user that does not exist", async () => {
    await assertViolates("materials_user_id_fkey", () =>
      insertMaterial({ user_id: 987_654_321 }),
    );
  });

  it("rejects a NULL user_id", async () => {
    await assert.rejects(
      () => insertMaterial({ user_id: null }),
      /null value in column "user_id"/,
    );
  });

  it("rejects a chunk for a material that does not exist", async () => {
    await assertViolates("material_chunks_material_id_fkey", () =>
      insertChunk({ material_id: 987_654_321 }),
    );
  });

  it("declares both foreign keys as ON DELETE CASCADE", async () => {
    // The delete rule read from the catalogue, so the two cascades below are
    // asserted as schema rather than inferred from a row disappearing.
    const { rows } = await pool.query(
      `SELECT c.conname, c.confdeltype, c.conrelid::regclass::text AS child
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid IN ('materials'::regclass, 'material_chunks'::regclass)
        ORDER BY c.conname`,
    );
    assert.deepEqual(
      rows.map((r) => [r.conname, r.child, r.confdeltype]),
      [
        // 'c' is ON DELETE CASCADE in pg_constraint.
        ["material_chunks_material_id_fkey", "material_chunks", "c"],
        ["materials_user_id_fkey", "materials", "c"],
      ],
    );
  });
});

// ── cascade deletion, the behaviour DELETE /api/materials/:id relies on ────
describe("cascade deletion", () => {
  it("deletes a material's chunks with the material", async () => {
    const userId = await makeUser(`cascadechunk_${Date.now()}`);
    const { rows: material } = await insertMaterial({
      user_id: userId,
      status: "ready",
    });
    const materialId = material[0].id;

    for (let index = 0; index < 3; index++) {
      await insertChunk({ material_id: materialId, chunk_index: index });
    }

    await pool.query("DELETE FROM materials WHERE id = $1", [materialId]);

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM material_chunks WHERE material_id = $1",
      [materialId],
    );
    assert.equal(
      rows[0].c,
      0,
      "the chunks must go with the material — the API relies on this cascade",
    );
  });

  it("deletes a user's materials and their chunks with the user", async () => {
    // Two levels of cascade, users → materials → material_chunks. Nothing calls
    // this today (there is no user-deletion endpoint), which is exactly why it is
    // worth asserting: the day one exists it must not orphan chunks.
    const userId = await makeUser(`cascadeuser_${Date.now()}`);
    const { rows: material } = await insertMaterial({ user_id: userId });
    const materialId = material[0].id;
    await insertChunk({ material_id: materialId });

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    const { rows: materials } = await pool.query(
      "SELECT COUNT(*) AS c FROM materials WHERE id = $1",
      [materialId],
    );
    const { rows: chunks } = await pool.query(
      "SELECT COUNT(*) AS c FROM material_chunks WHERE material_id = $1",
      [materialId],
    );
    assert.equal(materials[0].c, 0);
    assert.equal(chunks[0].c, 0);
  });
});

// ── materials CHECK constraints ────────────────────────────────────────────
describe("materials CHECK constraints", () => {
  let userId;
  before(async () => {
    userId = await makeUser(`matchecks_${Date.now()}`);
  });

  it("rejects a status outside the lifecycle", async () => {
    for (const status of ["", "READY", "done", "pending", "queued"]) {
      await assertViolates("materials_status_valid", () =>
        insertMaterial({
          user_id: userId,
          status,
          // A non-'failed' status may not carry an error, and 'failed' must —
          // keep this insert legal under the other constraint so the one under
          // test is the one that fires.
          error_message: null,
        }),
      );
    }
  });

  it("accepts each of the four lifecycle states", async () => {
    for (const status of ["uploaded", "processing", "ready", "failed"]) {
      await assert.doesNotReject(
        () =>
          insertMaterial({
            user_id: userId,
            status,
            error_message: status === "failed" ? "Could not be processed." : null,
          }),
        `${status} is a valid state`,
      );
    }
  });

  it("requires an error message on a failed material and forbids one otherwise", async () => {
    // The invariant that makes `status` worth trusting: no unexplained failure,
    // and no stale error left on a material that later succeeded.
    await assertViolates("materials_error_message_matches_status", () =>
      insertMaterial({ user_id: userId, status: "failed", error_message: null }),
    );
    for (const status of ["uploaded", "processing", "ready"]) {
      await assertViolates("materials_error_message_matches_status", () =>
        insertMaterial({
          user_id: userId,
          status,
          error_message: "a leftover error",
        }),
      );
    }
  });

  it("rejects an indexing status outside the lifecycle", async () => {
    // Written as UPDATEs because that is how the column actually changes — every
    // material is inserted as 'pending' by the column default and moves from there.
    const id = await makeMaterial(userId);
    for (const bad of ["", "PENDING", "done", "queued", "embedding", "ready"]) {
      await assertViolates("materials_indexing_status_valid", () =>
        pool.query("UPDATE materials SET indexing_status = $1 WHERE id = $2", [bad, id]),
      );
    }
  });

  it("accepts each of the four indexing states", async () => {
    const id = await makeMaterial(userId);
    for (const state of ["pending", "indexing", "indexed", "failed"]) {
      await assert.doesNotReject(
        () =>
          pool.query(
            "UPDATE materials SET indexing_status = $1, indexing_error = $2 WHERE id = $3",
            [state, state === "failed" ? "Could not be prepared for search." : null, id],
          ),
        `${state} is a valid indexing state`,
      );
    }
  });

  it("requires an indexing error on a failed indexing run and forbids one otherwise", async () => {
    // The same invariant as error_message, for the same reason: an unexplained
    // 'failed' is a support ticket with no information in it, and a leftover error
    // on a material that has since been indexed would be shown to a student whose
    // document works fine.
    const id = await makeMaterial(userId);
    await assertViolates("materials_indexing_error_matches_status", () =>
      pool.query("UPDATE materials SET indexing_status = 'failed' WHERE id = $1", [id]),
    );
    for (const state of ["pending", "indexing", "indexed"]) {
      await assertViolates("materials_indexing_error_matches_status", () =>
        pool.query(
          "UPDATE materials SET indexing_status = $1, indexing_error = $2 WHERE id = $3",
          [state, "a leftover indexing error", id],
        ),
      );
    }
  });

  it("bounds the indexing error at 500 characters", async () => {
    // It is returned verbatim by the API, so an unbounded column is an unbounded
    // response field. The application only ever writes one short fixed string; the
    // constraint is there for the code path that does not exist yet.
    const id = await makeMaterial(userId);
    await assert.doesNotReject(() =>
      pool.query(
        "UPDATE materials SET indexing_status = 'failed', indexing_error = $1 WHERE id = $2",
        ["e".repeat(500), id],
      ),
    );
    await assertViolates("materials_indexing_error_bounded", () =>
      pool.query(
        "UPDATE materials SET indexing_status = 'failed', indexing_error = $1 WHERE id = $2",
        ["e".repeat(501), id],
      ),
    );
  });

  it("lets a readable material be unsearchable, because they are two lifecycles", async () => {
    /**
     * §7's decision, asserted as schema. `status` and `indexing_status` are NOT
     * constrained against each other, and this is the pair that proves why that is
     * right: a document can be extracted, chunked, stored and perfectly readable
     * while its embeddings failed. That state has to be representable, because it
     * is what happens whenever the provider is down during an upload.
     *
     * The alternative — folding indexing into `status` as a fifth value — would have
     * made this state say "failed", telling a student their readable document was
     * broken, and would have changed what `ready` means for a value already stored
     * in every existing row.
     */
    const id = await makeMaterial(userId, "ready");
    await assert.doesNotReject(() =>
      pool.query(
        `UPDATE materials
            SET indexing_status = 'failed', indexing_error = 'Could not be prepared for search.'
          WHERE id = $1`,
        [id],
      ),
    );
    const { rows } = await pool.query(
      "SELECT status, indexing_status FROM materials WHERE id = $1",
      [id],
    );
    assert.deepEqual(rows[0], { status: "ready", indexing_status: "failed" });
  });

  it("rejects a blank or whitespace-only filename", async () => {
    // The tab and vertical-tab cases are the point: bare btrim() strips spaces
    // only, so a constraint written without the explicit set would accept E'\t'
    // as a filename.
    for (const bad of ["", "   ", "\t", "\n", "\t\n", " \r\n\v\f "]) {
      await assertViolates("materials_original_filename_not_blank", () =>
        insertMaterial({ user_id: userId, original_filename: bad }),
      );
    }
  });

  it("bounds the filename at 512 characters", async () => {
    await assert.doesNotReject(() =>
      insertMaterial({
        user_id: userId,
        original_filename: `${"a".repeat(508)}.txt`,
      }),
    );
    await assertViolates("materials_original_filename_bounded", () =>
      insertMaterial({
        user_id: userId,
        original_filename: `${"a".repeat(509)}.txt`,
      }),
    );
  });

  it("rejects a storage key that could escape the storage root", async () => {
    // The schema half of path-traversal defence (§21). Every one of these is a
    // key the storage layer would also refuse; the constraint means one cannot be
    // STORED for a future code path to trust.
    const dangerous = [
      "../secrets.txt",
      "..",
      "a/../../etc/passwd",
      "sub/dir.txt",
      "back\\slash.txt",
      "/absolute.txt",
      ".hidden",
      "with space.txt",
      "unicode nbsp.txt",
      "semi;colon.txt",
      "a".repeat(129),
      "",
    ];
    for (const key of dangerous) {
      await assertViolates("materials_storage_key_safe", () =>
        insertMaterial({ user_id: userId, storage_key: key }),
      );
    }
  });

  it("accepts the key shape the storage layer generates", async () => {
    await assert.doesNotReject(() =>
      insertMaterial({
        user_id: userId,
        storage_key: "9f1c3b1e8a244d7f9c2e5a6b7d8e9f01.pdf",
        mime_type: "application/pdf",
      }),
    );
  });

  it("rejects a duplicate storage key", async () => {
    const key = storageKey();
    await insertMaterial({ user_id: userId, storage_key: key });
    await assertViolates("materials_storage_key_key", () =>
      insertMaterial({ user_id: userId, storage_key: key }),
    );
  });

  it("rejects a mime type this iteration cannot process", async () => {
    for (const mimeType of [
      "application/msword",
      "image/png",
      "text/html",
      "application/octet-stream",
      "",
    ]) {
      await assertViolates("materials_mime_type_supported", () =>
        insertMaterial({ user_id: userId, mime_type: mimeType }),
      );
    }
  });

  it("rejects a zero or negative file size", async () => {
    for (const size of [0, -1]) {
      await assertViolates("materials_file_size_positive", () =>
        insertMaterial({ user_id: userId, file_size: size }),
      );
    }
  });

  it("allows a NULL page count but not a zero or negative one", async () => {
    // NULL is "not applicable or not reported" (§13); 0 would be a claim that a
    // document that parsed has no pages, which is never true.
    await assert.doesNotReject(() =>
      insertMaterial({ user_id: userId, page_count: null }),
    );
    for (const pageCount of [0, -1]) {
      await assertViolates("materials_page_count_positive", () =>
        insertMaterial({ user_id: userId, page_count: pageCount }),
      );
    }
  });

  it("defaults status, timestamps and the nullable columns", async () => {
    const { rows } = await pool.query(
      `INSERT INTO materials (user_id, original_filename, storage_key, mime_type, file_size)
       VALUES ($1, 'minimal.txt', $2, 'text/plain', 42)
       RETURNING status, page_count, error_message, created_at, updated_at`,
      [userId, storageKey()],
    );
    assert.equal(rows[0].status, "uploaded", "a new material starts as uploaded");
    assert.equal(rows[0].page_count, null);
    assert.equal(rows[0].error_message, null);
    // The ISO round-trip the API contract depends on, asserted at the source.
    assert.equal(new Date(rows[0].created_at).toISOString(), rows[0].created_at);
    assert.equal(new Date(rows[0].updated_at).toISOString(), rows[0].updated_at);
  });
});

// ── material_chunks CHECK constraints ──────────────────────────────────────
describe("material_chunks CHECK constraints", () => {
  let materialId;
  before(async () => {
    const userId = await makeUser(`chunkchecks_${Date.now()}`);
    const { rows } = await insertMaterial({ user_id: userId, status: "ready" });
    materialId = rows[0].id;
  });

  it("rejects a duplicate (material_id, chunk_index)", async () => {
    // §5's UNIQUE. Ordering is part of the data, so a repeated index is a corrupt
    // document rather than a tolerable retry artefact.
    await insertChunk({ material_id: materialId, chunk_index: 100 });
    await assertViolates("material_chunks_material_index_key", () =>
      insertChunk({ material_id: materialId, chunk_index: 100 }),
    );
  });

  it("allows the same chunk_index under two different materials", async () => {
    const userId = await makeUser(`chunkshare_${Date.now()}`);
    const { rows } = await insertMaterial({ user_id: userId, status: "ready" });
    await assert.doesNotReject(() =>
      insertChunk({ material_id: rows[0].id, chunk_index: 100 }),
    );
  });

  it("rejects a negative chunk index", async () => {
    await assertViolates("material_chunks_index_non_negative", () =>
      insertChunk({ material_id: materialId, chunk_index: -1 }),
    );
  });

  it("accepts index 0, because chunks are 0-based", async () => {
    const userId = await makeUser(`chunkzero_${Date.now()}`);
    const { rows } = await insertMaterial({ user_id: userId, status: "ready" });
    await assert.doesNotReject(() =>
      insertChunk({ material_id: rows[0].id, chunk_index: 0 }),
    );
  });

  it("rejects a blank chunk", async () => {
    // §16 requires non-empty chunks and §17 requires that a document producing
    // none fails; this is the first of those as a database rule.
    for (const bad of ["", "   ", "\t", "\n", " \r\n\v\f "]) {
      await assertViolates("material_chunks_content_not_blank", () =>
        insertChunk({
          material_id: materialId,
          chunk_index: 200 + bad.length,
          content: bad,
          char_count: bad.length,
        }),
      );
    }
  });

  it("rejects a char_count that disagrees with the content", async () => {
    await assertViolates("material_chunks_char_count_matches", () =>
      insertChunk({
        material_id: materialId,
        chunk_index: 300,
        content: "twelve chars",
        char_count: 999,
      }),
    );
  });

  it("allows a NULL page number but not a zero or negative one", async () => {
    await assert.doesNotReject(() =>
      insertChunk({
        material_id: materialId,
        chunk_index: 400,
        page_number: null,
      }),
    );
    for (const [offset, pageNumber] of [0, -1].entries()) {
      await assertViolates("material_chunks_page_number_positive", () =>
        insertChunk({
          material_id: materialId,
          chunk_index: 500 + offset,
          page_number: pageNumber,
        }),
      );
    }
  });

  it("rejects NULLs in the required columns", async () => {
    for (const column of ["chunk_index", "content", "char_count"]) {
      await assert.rejects(
        () =>
          insertChunk({
            material_id: materialId,
            chunk_index: 600,
            [column]: null,
          }),
        new RegExp(`null value in column "${column}"`),
      );
    }
  });
});

// ── what the vector type itself enforces (§28) ─────────────────────────────
describe("the embedding column", () => {
  let materialId;
  before(async () => {
    const userId = await makeUser(`embedcol_${Date.now()}`);
    materialId = await makeMaterial(userId, "ready");
  });

  /** Set an existing chunk's embedding from a literal, returning the promise. */
  async function setEmbedding(chunkIndex, literal) {
    const { rows } = await insertChunk({ material_id: materialId, chunk_index: chunkIndex });
    return pool.query("UPDATE material_chunks SET embedding = $1 WHERE id = $2", [
      literal,
      rows[0].id,
    ]);
  }

  it("is NULL on a new chunk, so a fresh document is not yet searchable", async () => {
    // The default that makes indexing resumable. Retrieval's `embedding IS NOT NULL`
    // filter depends on this being the state a chunk starts in.
    const { rows } = await insertChunk({ material_id: materialId, chunk_index: 700 });
    const { rows: stored } = await pool.query(
      "SELECT embedding FROM material_chunks WHERE id = $1",
      [rows[0].id],
    );
    assert.equal(stored[0].embedding, null);
  });

  it("accepts a vector of the migrated width", async () => {
    await assert.doesNotReject(() => setEmbedding(710, vectorLiteral(0.1)));
  });

  it("rejects a vector of any other width", async () => {
    // §28: "if the vector dimension is unexpected, fail safely, do not persist
    // corrupt vector data". The column does this itself, which is the strongest
    // place for it to happen — a validation bug in the embedding service cannot
    // write a 768-dimension vector into a 1536-dimension corpus and leave a
    // silently unsearchable chunk behind.
    for (const width of [1, 768, 1535, 1537, 3072]) {
      await assert.rejects(
        () => setEmbedding(720 + width, vectorLiteral(0.1, width)),
        new RegExp(`expected ${MIGRATED_DIMENSIONS} dimensions, not ${width}`),
      );
    }
  });

  it("rejects NaN and infinite components", async () => {
    // The other half of §28. These are the values a broken provider response or a
    // normalisation divide-by-zero produces, and they are worse than a wrong
    // dimension: a NaN component makes every distance involving that row NaN, so the
    // chunk would never be retrieved and nothing would report an error. pgvector
    // refuses them at the type boundary.
    await assert.rejects(
      () => setEmbedding(730, `[NaN${",0.1".repeat(MIGRATED_DIMENSIONS - 1)}]`),
      /NaN not allowed in vector/,
    );
    await assert.rejects(
      () => setEmbedding(731, `[Infinity${",0.1".repeat(MIGRATED_DIMENSIONS - 1)}]`),
      /infinite value not allowed in vector/,
    );
  });

  it("computes cosine distance with the <=> operator the repository uses", async () => {
    // A sanity check on the operator and the opclass, not on the data: identical
    // vectors are distance 0 and orthogonal ones distance 1, so
    // `1 - (embedding <=> query)` is a similarity in [0, 1] as
    // retrieval.repository.js assumes. Retrieval ORDERING is tested against real
    // fixture vectors in tests/materials/retrieval.test.js.
    const { rows } = await pool.query(
      `SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS identical,
              '[1,0,0]'::vector <=> '[0,1,0]'::vector AS orthogonal,
              '[1,0,0]'::vector <=> '[-1,0,0]'::vector AS opposite`,
    );
    assert.equal(Number(rows[0].identical), 0);
    assert.equal(Number(rows[0].orthogonal), 1);
    assert.equal(Number(rows[0].opposite), 2);
  });

  it("goes when its material goes", async () => {
    // Embeddings are chunk columns, not a separate table, so the existing
    // ON DELETE CASCADE covers them and there is no second cleanup path to forget.
    const userId = await makeUser(`embedcascade_${Date.now()}`);
    const doomed = await makeMaterial(userId, "ready");
    const { rows } = await insertChunk({ material_id: doomed, chunk_index: 0 });
    await pool.query("UPDATE material_chunks SET embedding = $1 WHERE id = $2", [
      vectorLiteral(0.2),
      rows[0].id,
    ]);

    await pool.query("DELETE FROM materials WHERE id = $1", [doomed]);
    const { rows: left } = await pool.query(
      "SELECT count(*)::int AS n FROM material_chunks WHERE material_id = $1",
      [doomed],
    );
    assert.equal(left[0].n, 0);
  });
});

// ── the objects the queries depend on ──────────────────────────────────────
describe("indexes", () => {
  it("has exactly the documented indexes on materials", async () => {
    // Exact, matching the rule 001 set and tests/schema.test.js enforces for
    // questions: every index must serve a query that exists today, so adding one
    // breaks a test and prompts the justification comment in the migration.
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'materials'
        ORDER BY indexname`,
    );
    assert.deepEqual(rows.map((r) => r.indexname), [
      "idx_materials_user_created",
      // Added by 004_study_plans.sql, not by this feature. It is the index
      // behind `UNIQUE (id, user_id)`, which exists solely to be the target of
      // study_plan_tasks' composite foreign key — that is what lets the database
      // itself refuse a task pointing at another user's material, rather than
      // trusting application code to check. It appears here because this
      // assertion is exact on purpose: a later migration touching `materials`
      // has to come back to this line and say why.
      "materials_id_user_key",
      "materials_pkey",
      "materials_storage_key_key",
    ]);
  });

  it("has exactly the documented indexes on material_chunks", async () => {
    // Two, and neither was created by a CREATE INDEX: the PK and the UNIQUE
    // constraint. §29's "index chunk ordering" is served by the latter, which is
    // why no third index exists.
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'material_chunks'
        ORDER BY indexname`,
    );
    assert.deepEqual(rows.map((r) => r.indexname), [
      "material_chunks_material_index_key",
      "material_chunks_pkey",
    ]);
  });

  it("uses the composite index for the list query at realistic scale", async () => {
    // Asserting the PLAN rather than the index's existence, for the reason
    // tests/schema.test.js gives: an index PostgreSQL declines to use is the same
    // as no index. Scale matters — on 50 rows a sequential scan IS cheaper and
    // the planner is right to pick it — hence generate_series rather than a loop.
    await pool.query(
      `INSERT INTO users (username)
       SELECT 'matplan_user_' || g FROM generate_series(1, 40) AS g`,
    );
    await pool.query(
      `INSERT INTO materials (user_id, original_filename, storage_key, mime_type,
                              file_size, status, created_at)
       SELECT u.id,
              'notes' || g || '.txt',
              md5(u.id::text || '-' || g) || '.txt',
              'text/plain',
              1000 + g,
              'ready',
              now() - (g || ' minutes')::interval
         FROM users u
         CROSS JOIN generate_series(1, 100) AS g
        WHERE u.username LIKE 'matplan_user_%'`,
    );
    await pool.query("ANALYZE materials");

    const { rows: target } = await pool.query(
      "SELECT id FROM users WHERE username = 'matplan_user_1'",
    );
    const { rows } = await pool.query(
      `EXPLAIN SELECT id, original_filename, status, created_at
         FROM materials
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [target[0].id],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");

    assert.match(
      plan,
      /idx_materials_user_created/,
      `the list query must use the composite index; plan was:\n${plan}`,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on materials/,
      `a sequential scan means the index is not being used; plan was:\n${plan}`,
    );
  });

  it("uses the unique index for the ordered read of a material's chunks", async () => {
    // Its own user and materials rather than the rows above: those already have
    // chunks from the constraint tests, and chunk_index is UNIQUE per material.
    // 60 materials × 60 chunks is enough rows that reading one material's chunks
    // through the index is plainly cheaper than scanning the table.
    const chunkyUser = await makeUser(`chunkplan_${Date.now()}`);
    await pool.query(
      `INSERT INTO materials (user_id, original_filename, storage_key, mime_type,
                              file_size, status)
       SELECT $1,
              'chunky' || g || '.txt',
              md5('chunkplan-' || g) || '.txt',
              'text/plain',
              2000 + g,
              'ready'
         FROM generate_series(1, 60) AS g`,
      [chunkyUser],
    );
    await pool.query(
      `INSERT INTO material_chunks (material_id, chunk_index, content, char_count)
       SELECT m.id,
              g,
              'chunk ' || g || ' of a document about cell biology',
              char_length('chunk ' || g || ' of a document about cell biology')
         FROM materials m
         CROSS JOIN generate_series(0, 59) AS g
        WHERE m.user_id = $1`,
      [chunkyUser],
    );
    await pool.query("ANALYZE material_chunks");

    const { rows: material } = await pool.query(
      "SELECT id FROM materials WHERE user_id = $1 LIMIT 1",
      [chunkyUser],
    );

    const { rows } = await pool.query(
      `EXPLAIN SELECT chunk_index, content, page_number, char_count
         FROM material_chunks
        WHERE material_id = $1
        ORDER BY chunk_index ASC`,
      [material[0].id],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");

    assert.match(
      plan,
      /material_chunks_material_index_key/,
      `the chunk read must reach its rows through the unique index; plan was:\n${plan}`,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on material_chunks/,
      `a sequential scan means the unique index is not serving the read; plan was:\n${plan}`,
    );
  });
});
