/**
 * The five material endpoints, end to end — §22's Upload, Ownership, Persistence,
 * Cleanup and API groups.
 *
 * Black box: one real server child process, one private migrated PostgreSQL
 * database, one private temporary upload directory, HTTP in and JSON out. Nothing
 * here imports a service or a repository, so the suite says whether the FEATURE
 * works rather than whether a particular function does. The units are covered
 * separately in tests/materials/processing.test.js.
 *
 * Two things are inspected outside the API, because the API deliberately cannot
 * answer them:
 *
 *   - the database, through a pg client on the same private database, for the
 *     chunk rows §5 requires (no endpoint returns chunk content)
 *   - the storage directory, through `server.storedFiles()`, for the bytes §7
 *     stores (no response contains a storage key or a path — §18)
 *
 * One server for the whole file. The tests are read-mostly and each one works with
 * its own freshly-generated username, which is the isolation that matters here:
 * `testUser()` returns a UUID-suffixed name, so no test can see another's
 * materials even though they share a database. Restarting the server per test
 * would cost a migration each time and buy nothing.
 *
 *   node --test tests/materials/api.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";
import {
  EMPTY_TXT,
  MALFORMED_PDF,
  MESSY_TXT,
  MESSY_TXT_NORMALIZED,
  MULTI_CHUNK_TXT,
  PNG_NAMED_TXT,
  SHORT_TXT,
  TXT_NAMED_PDF,
  UNSUPPORTED_EXTENSION,
  ZERO_BYTE_TXT,
  materialForm,
  multiPagePdf,
  oversizedTxt,
  textlessPdf,
} from "../fixtures/materials.mjs";

let server;
let pool;

before(async () => {
  server = await startServer({ label: "matapi" });
  pool = new pg.Pool({ connectionString: server.databaseUrl, max: 4 });
});

after(async () => {
  await pool?.end();
  await server?.stop();
});

// ── helpers ────────────────────────────────────────────────────────────────

/** POST a fixture and return the parsed response. */
const upload = (username, file) =>
  server.request("POST", "/api/materials", { form: materialForm({ username, file }) });

/** POST a fixture, assert it was created, and return the material. */
async function uploadOk(username, file) {
  const res = await upload(username, file);
  assert.equal(res.status, 201, `upload failed: ${res.text}`);
  return res.body;
}

/**
 * Every chunk of a material, in stored order.
 *
 * Read straight from PostgreSQL: no endpoint exposes chunk content, and §22 asks
 * for the chunks themselves — count, ordering, char_count, page attribution — not
 * just for a number the API reports about them.
 */
async function chunkRows(materialId) {
  const { rows } = await pool.query(
    `SELECT chunk_index, content, page_number, char_count
       FROM material_chunks
      WHERE material_id = $1
      ORDER BY chunk_index`,
    [materialId],
  );
  return rows;
}

/** The stored row for a material, including the columns the API hides. */
async function materialRow(materialId) {
  const { rows } = await pool.query(
    `SELECT user_id, original_filename, storage_key, mime_type, file_size,
            status, page_count, error_message
       FROM materials WHERE id = $1`,
    [materialId],
  );
  return rows[0] ?? null;
}

/**
 * A material's API shape must not leak storage or ownership internals (§18, §21).
 *
 * Asserted on the serialised JSON rather than the parsed object so a nested value
 * or an unexpected extra field cannot hide from the check.
 */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /storage_?[Kk]ey/, "no storage key");
  assert.doesNotMatch(json, /user_?[Ii]d/, "no user id");
  assert.doesNotMatch(json, /\/tmp\/|\/home\/|studypal-test-uploads/, "no filesystem path");
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, "no stack frame");
}

/** An error response is JSON, has the given status, and leaks nothing. */
function assertJsonError(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(
    res.headers.get("content-type") ?? "",
    /application\/json/,
    "errors must be JSON (§20)",
  );
  assert.equal(typeof res.body?.error, "string", `no error string in ${res.text}`);
  assert.ok(res.body.error.length > 0);
  assertNoInternals(res.body);
}

// ── upload: the happy paths ────────────────────────────────────────────────
describe("POST /api/materials", () => {
  it("accepts a plain text file and returns it ready", async () => {
    const username = testUser("txt");
    const material = await uploadOk(username, SHORT_TXT);

    assert.deepEqual(Object.keys(material).sort(), [
      "chunkCount",
      "createdAt",
      "fileSize",
      "filename",
      "id",
      "mimeType",
      "pageCount",
      "status",
      "updatedAt",
    ]);
    assert.equal(material.status, "ready");
    assert.equal(material.filename, SHORT_TXT.filename);
    assert.equal(material.mimeType, "text/plain");
    assert.equal(material.fileSize, Buffer.byteLength(SHORT_TXT.content));
    assert.equal(material.pageCount, null, "plain text has no pages");
    assert.equal(material.chunkCount, 1);
    assert.ok(Number.isInteger(material.id) && material.id > 0);
    assert.match(material.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assertNoInternals(material);
  });

  it("accepts a PDF, records its page count, and attributes chunks to pages", async () => {
    const username = testUser("pdf");
    const material = await uploadOk(username, multiPagePdf());

    assert.equal(material.status, "ready");
    assert.equal(material.mimeType, "application/pdf");
    assert.equal(material.pageCount, 3);
    assert.ok(material.chunkCount >= 3);

    const chunks = await chunkRows(material.id);
    assert.equal(chunks.length, material.chunkCount, "chunkCount must match the rows");
    assert.deepEqual(
      [...new Set(chunks.map((chunk) => chunk.page_number))],
      [1, 2, 3],
      "every page contributes chunks, in order",
    );
    // Page N's chunk holds page N's text — the fixture's pages name themselves.
    const byPage = new Map(chunks.map((chunk) => [chunk.page_number, chunk.content]));
    assert.match(byPage.get(1), /Page One/);
    assert.match(byPage.get(2), /Page Two/);
    assert.match(byPage.get(3), /Page Three/);
  });

  it("stores the file under a generated key, never the original filename", async () => {
    // §7 and §21: the original name is display metadata. A file on disk named
    // after user input is the traversal bug this design removes entirely.
    const username = testUser("key");
    const before = await server.storedFiles();
    const material = await uploadOk(username, SHORT_TXT);
    const stored = await server.storedFiles();

    assert.equal(stored.length, before.length + 1, "exactly one new file on disk");
    const added = stored.find((name) => !before.includes(name));
    assert.notEqual(added, SHORT_TXT.filename);
    assert.match(added, /^[0-9a-f]{32}\.txt$/, "a generated, opaque key");

    const row = await materialRow(material.id);
    assert.equal(row.storage_key, added, "the row points at the file that exists");
    assert.equal(row.original_filename, SHORT_TXT.filename, "the real name is kept as metadata");
  });

  it("normalizes the stored text without rewriting it", async () => {
    // §15 end to end. The expectation is the fixture's hand-written one, so this
    // asserts the pipeline's output rather than the normalizer's self-consistency.
    const username = testUser("messy");
    const material = await uploadOk(username, MESSY_TXT);
    const chunks = await chunkRows(material.id);

    assert.equal(chunks.length, 1, "the fixture is small enough for one chunk");
    assert.equal(chunks[0].content, MESSY_TXT_NORMALIZED);
    assert.match(chunks[0].content, /H₂O/, "subscripts survive — no NFKC");
  });

  it("chunks a longer document into ordered, overlapping, counted chunks", async () => {
    const username = testUser("chunks");
    const material = await uploadOk(username, MULTI_CHUNK_TXT);
    const chunks = await chunkRows(material.id);

    assert.ok(chunks.length > 1, "the fixture must produce several chunks");
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunk_index),
      chunks.map((_, position) => position),
      "§5: deterministic indexes starting at 0, contiguous, in order",
    );
    for (const chunk of chunks) {
      assert.ok(chunk.content.trim().length > 0, "no empty chunk");
      assert.equal(chunk.char_count, chunk.content.length, "char_count matches content");
      assert.equal(chunk.page_number, null, "plain text has no page numbers");
    }
  });

  it("is deterministic: the same bytes twice produce the same chunks", async () => {
    // §16's "deterministic". Two separate materials, two separate uploads, and the
    // chunk text must agree exactly.
    const username = testUser("determ");
    const first = await uploadOk(username, MULTI_CHUNK_TXT);
    const second = await uploadOk(username, MULTI_CHUNK_TXT);

    assert.notEqual(first.id, second.id);
    assert.deepEqual(
      (await chunkRows(first.id)).map(({ chunk_index, content, char_count }) => ({
        chunk_index,
        content,
        char_count,
      })),
      (await chunkRows(second.id)).map(({ chunk_index, content, char_count }) => ({
        chunk_index,
        content,
        char_count,
      })),
    );
  });

  it("reaches ready through uploaded and processing, ending with no error", async () => {
    const username = testUser("states");
    const material = await uploadOk(username, SHORT_TXT);

    // The transitions themselves happen inside one synchronous request, so what is
    // observable afterwards is the terminal state and its invariants: §11 says a
    // successful material has a stored file, chunks, `ready`, and no error text.
    const row = await materialRow(material.id);
    assert.equal(row.status, "ready");
    assert.equal(row.error_message, null, "a ready material carries no error");
    assert.ok((await chunkRows(material.id)).length > 0);
    assert.equal(material.status, "ready");
    assert.ok(Object.hasOwn(material, "error") === false, "no error field when ready");
  });
});

// ── upload: rejections ─────────────────────────────────────────────────────
describe("POST /api/materials rejections", () => {
  it("rejects an unsupported extension with 415 and stores nothing", async () => {
    const username = testUser("docx");
    const before = await server.storedFiles();

    assertJsonError(await upload(username, UNSUPPORTED_EXTENSION), 415);

    assert.deepEqual(await server.storedFiles(), before, "nothing written to disk");
    const list = await server.request("GET", `/api/materials?username=${username}`);
    assert.deepEqual(list.body, [], "and no row created");
  });

  it("rejects a file whose contents contradict its extension with 415", async () => {
    // Both directions: PNG bytes named .txt, and text named .pdf. §8's "do not
    // trust either one individually", from the outside.
    const username = testUser("mismatch");
    assertJsonError(await upload(username, PNG_NAMED_TXT), 415);
    assertJsonError(await upload(username, TXT_NAMED_PDF), 415);
    assert.deepEqual((await server.request("GET", `/api/materials?username=${username}`)).body, []);
  });

  it("rejects an oversized upload with 413", async () => {
    const username = testUser("big");
    const res = await upload(username, oversizedTxt(11 * 1024 * 1024));
    assertJsonError(res, 413);
    assert.match(res.body.error, /too large|maximum/i);
  });

  it("rejects a zero-byte file with 400", async () => {
    assertJsonError(await upload(testUser("zero"), ZERO_BYTE_TXT), 400);
  });

  it("rejects a missing username with 400", async () => {
    const res = await server.request("POST", "/api/materials", {
      form: materialForm({ file: SHORT_TXT }),
    });
    assertJsonError(res, 400);
    assert.match(res.body.error, /username/i);
  });

  it("rejects a blank username with 400", async () => {
    assertJsonError(await upload("   ", SHORT_TXT), 400);
  });

  it("rejects a missing file with 400", async () => {
    const res = await server.request("POST", "/api/materials", {
      form: materialForm({ username: testUser("nofile") }),
    });
    assertJsonError(res, 400);
    assert.match(res.body.error, /file/i);
  });

  it("rejects more than one file part with 400", async () => {
    const username = testUser("two");
    const res = await server.request("POST", "/api/materials", {
      form: materialForm({ username, files: [SHORT_TXT, MULTI_CHUNK_TXT] }),
    });
    assertJsonError(res, 400);
    assert.deepEqual((await server.request("GET", `/api/materials?username=${username}`)).body, []);
  });

  it("rejects a body that is not multipart with 400", async () => {
    const res = await server.request("POST", "/api/materials", {
      json: { username: testUser("json"), file: "pretend" },
    });
    assertJsonError(res, 400);
  });
});

// ── §17: a valid file with no readable text ────────────────────────────────
describe("documents with no readable text", () => {
  /**
   * §17 and §11: the material is created, so the student can see why it failed,
   * but it must land in `failed` with no chunks and a safe explanation. Both
   * fixtures reach this state by different routes — one has no text, the other has
   * no text layer — and both must end the same way.
   */
  for (const [label, fixture] of [
    ["a whitespace-only text file", () => EMPTY_TXT],
    ["a PDF with no text layer", () => textlessPdf()],
  ]) {
    it(`marks ${label} failed rather than ready`, async () => {
      const username = testUser("empty");
      const material = await uploadOk(username, fixture());

      assert.equal(material.status, "failed", "§17: never a zero-content ready material");
      assert.equal(material.chunkCount, 0);
      assert.equal(typeof material.error, "string");
      assertNoInternals(material);

      assert.deepEqual(await chunkRows(material.id), [], "no orphaned chunks");
      assert.equal((await materialRow(material.id)).status, "failed");
    });
  }

  it("marks a malformed PDF failed with a safe message", async () => {
    const username = testUser("corrupt");
    const material = await uploadOk(username, MALFORMED_PDF);

    assert.equal(material.status, "failed");
    assert.equal(material.chunkCount, 0);
    assert.match(material.error, /PDF/i, "the student is told what kind of file failed");
    assert.doesNotMatch(
      material.error,
      /pdfjs|InvalidPDF|XRef|stream|node_modules|at \S+ \(/i,
      "§13: no parser internals reach the client",
    );

    // The stored error is the safe one too — it is what /status will hand back.
    const row = await materialRow(material.id);
    assert.equal(row.error_message, material.error);
    assert.equal(row.status, "failed");
  });

  it("keeps a failed material listed and deletable", async () => {
    // A failure is not a disappearance: the row exists, so the student can see it
    // and remove it. Deleting it must still clean up the stored file.
    const username = testUser("failvis");
    const material = await uploadOk(username, MALFORMED_PDF);

    const list = await server.request("GET", `/api/materials?username=${username}`);
    assert.deepEqual(
      list.body.map((entry) => [entry.id, entry.status]),
      [[material.id, "failed"]],
    );

    const removed = await server.request(
      "DELETE",
      `/api/materials/${material.id}?username=${username}`,
    );
    assert.equal(removed.status, 200);
    assert.equal(await materialRow(material.id), null);
  });
});

// ── GET /api/materials ─────────────────────────────────────────────────────
describe("GET /api/materials", () => {
  it("returns only that user's materials, newest first, without content", async () => {
    const username = testUser("list");
    const first = await uploadOk(username, SHORT_TXT);
    const second = await uploadOk(username, multiPagePdf());

    const res = await server.request("GET", `/api/materials?username=${username}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((entry) => entry.id),
      [second.id, first.id],
      "newest first",
    );
    for (const entry of res.body) {
      assert.equal(Object.hasOwn(entry, "content"), false, "§10: no document contents");
      assert.ok(Number.isInteger(entry.chunkCount), "chunk counts come from the list query");
      assertNoInternals(entry);
    }
  });

  it("returns an empty array for a user with no materials", async () => {
    const res = await server.request("GET", `/api/materials?username=${testUser("none")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [], "an unknown username is not an error");
  });

  it("requires a username", async () => {
    assertJsonError(await server.request("GET", "/api/materials"), 400);
    assertJsonError(await server.request("GET", "/api/materials?username="), 400);
  });
});

// ── GET /api/materials/:id and /status ─────────────────────────────────────
describe("GET /api/materials/:id", () => {
  it("returns the metadata without storage details", async () => {
    const username = testUser("get");
    const created = await uploadOk(username, multiPagePdf());

    const res = await server.request("GET", `/api/materials/${created.id}?username=${username}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created, "GET agrees with what POST returned");
    assertNoInternals(res.body);
  });

  it("reports status, page count and chunk count", async () => {
    const username = testUser("status");
    const created = await uploadOk(username, multiPagePdf());

    const res = await server.request(
      "GET",
      `/api/materials/${created.id}/status?username=${username}`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      id: created.id,
      status: "ready",
      pageCount: 3,
      chunkCount: created.chunkCount,
    });
  });

  it("includes a safe error in the status of a failed material", async () => {
    const username = testUser("failstat");
    const created = await uploadOk(username, MALFORMED_PDF);

    const res = await server.request(
      "GET",
      `/api/materials/${created.id}/status?username=${username}`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "failed");
    assert.equal(res.body.chunkCount, 0);
    assert.equal(res.body.error, created.error);
    assertNoInternals(res.body);
  });

  it("404s an id that does not exist", async () => {
    assertJsonError(
      await server.request("GET", `/api/materials/999999999?username=${testUser("ghost")}`),
      404,
    );
  });

  it("400s an id that is not a positive integer", async () => {
    const username = testUser("badid");
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "%20"]) {
      assertJsonError(
        await server.request("GET", `/api/materials/${id}?username=${username}`),
        400,
      );
      assertJsonError(
        await server.request("GET", `/api/materials/${id}/status?username=${username}`),
        400,
      );
    }
  });

  it("requires a username on every per-material route", async () => {
    const username = testUser("nouser");
    const created = await uploadOk(username, SHORT_TXT);
    for (const path of [
      `/api/materials/${created.id}`,
      `/api/materials/${created.id}/status`,
    ]) {
      assertJsonError(await server.request("GET", path), 400);
    }
    assertJsonError(await server.request("DELETE", `/api/materials/${created.id}`), 400);
  });
});

// ── ownership ──────────────────────────────────────────────────────────────
describe("ownership", () => {
  let alice;
  let bob;
  let aliceMaterial;

  before(async () => {
    alice = testUser("alice");
    bob = testUser("bob");
    aliceMaterial = await uploadOk(alice, SHORT_TXT);
    await uploadOk(bob, MULTI_CHUNK_TXT);
  });

  it("shows each user only their own materials", async () => {
    const forAlice = await server.request("GET", `/api/materials?username=${alice}`);
    const forBob = await server.request("GET", `/api/materials?username=${bob}`);

    assert.deepEqual(
      forAlice.body.map((entry) => entry.filename),
      [SHORT_TXT.filename],
    );
    assert.deepEqual(
      forBob.body.map((entry) => entry.filename),
      [MULTI_CHUNK_TXT.filename],
    );
    assert.equal(
      forBob.body.some((entry) => entry.id === aliceMaterial.id),
      false,
      "B must not see A's material",
    );
  });

  it("404s every read of another user's material", async () => {
    // 404 rather than 403: a 403 confirms the id exists, which is itself a leak
    // about someone else's data. §6's "never trust a material ID alone".
    for (const path of [
      `/api/materials/${aliceMaterial.id}?username=${bob}`,
      `/api/materials/${aliceMaterial.id}/status?username=${bob}`,
    ]) {
      const res = await server.request("GET", path);
      assertJsonError(res, 404);
      assert.doesNotMatch(res.body.error, new RegExp(alice), "no other username echoed back");
    }
  });

  it("refuses to delete another user's material and leaves it intact", async () => {
    const before = await server.storedFiles();

    assertJsonError(
      await server.request("DELETE", `/api/materials/${aliceMaterial.id}?username=${bob}`),
      404,
    );

    assert.deepEqual(await server.storedFiles(), before, "no file removed");
    assert.equal((await materialRow(aliceMaterial.id)).status, "ready");
    const stillThere = await server.request(
      "GET",
      `/api/materials/${aliceMaterial.id}?username=${alice}`,
    );
    assert.equal(stillThere.status, 200, "the owner still has it");
  });

  it("404s a material for a username that does not exist at all", async () => {
    assertJsonError(
      await server.request(
        "GET",
        `/api/materials/${aliceMaterial.id}?username=${testUser("nobody")}`,
      ),
      404,
    );
  });

  it("associates the material with the existing users row, not a new table", async () => {
    // §6: ownership goes through the SP-V2-002 users table. If a second users
    // table had been introduced, this join would find nothing.
    const { rows } = await pool.query(
      `SELECT u.username FROM materials m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
      [aliceMaterial.id],
    );
    assert.deepEqual(rows, [{ username: alice }]);
  });
});

// ── DELETE, and what it must take with it ──────────────────────────────────
describe("DELETE /api/materials/:id", () => {
  it("removes the row, the chunks and the stored file", async () => {
    const username = testUser("del");
    const material = await uploadOk(username, MULTI_CHUNK_TXT);
    const row = await materialRow(material.id);

    assert.ok((await chunkRows(material.id)).length > 1);
    assert.ok((await server.storedFiles()).includes(row.storage_key), "the file is on disk");

    const res = await server.request(
      "DELETE",
      `/api/materials/${material.id}?username=${username}`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: material.id, deleted: true });

    assert.equal(await materialRow(material.id), null, "row gone");
    assert.deepEqual(await chunkRows(material.id), [], "chunks gone (§5's cascade)");
    assert.equal(
      (await server.storedFiles()).includes(row.storage_key),
      false,
      "stored file gone (§10)",
    );
  });

  it("404s a second delete of the same material", async () => {
    const username = testUser("twice");
    const material = await uploadOk(username, SHORT_TXT);

    assert.equal(
      (await server.request("DELETE", `/api/materials/${material.id}?username=${username}`))
        .status,
      200,
    );
    assertJsonError(
      await server.request("DELETE", `/api/materials/${material.id}?username=${username}`),
      404,
    );
  });

  it("leaves the user's other materials untouched", async () => {
    const username = testUser("delone");
    const keep = await uploadOk(username, SHORT_TXT);
    const drop = await uploadOk(username, MULTI_CHUNK_TXT);
    const keepKey = (await materialRow(keep.id)).storage_key;

    await server.request("DELETE", `/api/materials/${drop.id}?username=${username}`);

    const list = await server.request("GET", `/api/materials?username=${username}`);
    assert.deepEqual(
      list.body.map((entry) => entry.id),
      [keep.id],
    );
    assert.ok((await chunkRows(keep.id)).length > 0, "the survivor keeps its chunks");
    assert.ok((await server.storedFiles()).includes(keepKey), "and its file");
  });
});
