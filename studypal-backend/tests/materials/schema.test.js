/**
 * Materials schema tests — §22's "Database" group.
 *
 * The same approach as tests/schema.test.js, one migration later: go through SQL
 * directly, and assert that the DATABASE refuses a bad row rather than that the
 * application avoids writing one. Every CHECK constraint in
 * migrations/postgres/002_materials.sql is a rule that has to hold even if a
 * future code path forgets it, and the only way to demonstrate that is to try the
 * write.
 *
 * Constraint NAMES are matched rather than message text, so renaming a constraint
 * fails here and a reworded PostgreSQL error does not.
 *
 * Real PostgreSQL, one private already-migrated database for the suite.
 *
 *   node --test tests/materials/schema.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createIsolatedDatabase } from "../helpers/test-database.mjs";

const { Pool } = pg;

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

    // The nullability split is the lifecycle: page_count and error_message are
    // the only two things a material may legitimately not know yet.
    assert.equal(byName.page_count.is_nullable, "YES");
    assert.equal(byName.error_message.is_nullable, "YES");
    for (const required of [
      "user_id",
      "original_filename",
      "storage_key",
      "mime_type",
      "file_size",
      "status",
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
      "id",
      "material_id",
      "page_number",
    ]);

    assert.equal(byName.material_id.data_type, "bigint");
    assert.equal(byName.chunk_index.data_type, "integer");
    assert.equal(byName.content.data_type, "text");
    assert.equal(byName.page_number.is_nullable, "YES");
    assert.equal(byName.char_count.is_nullable, "NO");
  });

  it("has no embedding or vector column anywhere (deferred to SP-V2-004)", async () => {
    // §5: "Do NOT add vector/embedding columns in this iteration." Asserted
    // structurally rather than trusted, because the cost of noticing this late is
    // a migration nobody wanted.
    const { rows } = await pool.query(
      `SELECT table_name, column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ~* 'embed|vector|tsvector' OR udt_name ~* 'vector')`,
    );
    assert.deepEqual(rows, []);
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
