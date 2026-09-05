/**
 * Migration runner tests.
 *
 * Against real PostgreSQL. Nothing here is mocked: the point of a migration test
 * is that the SQL applies to an actual server, that the tracking table records
 * it, and that running it twice is a no-op — none of which a fake can tell you.
 *
 * Each test provisions its own empty database, so a failure cannot leave another
 * test's schema behind. tests/helpers/test-database.mjs refuses to touch a
 * database whose name does not look like a test database.
 *
 *   node --test tests/migrations.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import pg from "pg";

import {
  migrate,
  migrationStatus,
  readMigrations,
} from "../src/db/migrator.js";
import {
  assertTestDatabase,
  createIsolatedDatabase,
  resetSchema,
  testDatabaseUrl,
} from "./helpers/test-database.mjs";

const { Pool } = pg;

/** Databases and pools opened by a test, torn down after the suite. */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
});

/**
 * An EMPTY database plus a pool onto it.
 *
 * createIsolatedDatabase() hands back an already-migrated clone, so the schema
 * is dropped again here: these tests need to watch migrating happen.
 */
async function emptyDatabase(label) {
  const database = await createIsolatedDatabase({ label });
  const pool = new Pool({ connectionString: database.url, max: 2 });
  cleanups.push(async () => {
    await pool.end();
    await database.drop();
  });
  await resetSchema(pool);
  return { database, pool };
}

const tableNames = async (pool) => {
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return rows.map((row) => row.tablename);
};

// ── applying from scratch ──────────────────────────────────────────────────
describe("migrate() on a fresh database", () => {
  it("creates the schema and records what it applied", async () => {
    const { pool } = await emptyDatabase("fresh");

    assert.deepEqual(await tableNames(pool), [], "must start empty");

    const onDisk = await readMigrations();
    assert.ok(onDisk.length > 0, "there must be migrations to apply");

    const result = await migrate({ pool, quiet: true });

    assert.deepEqual(
      result.applied,
      onDisk.map((m) => m.filename),
      "every migration on disk must be applied, in order",
    );
    assert.deepEqual(result.skipped, []);

    assert.deepEqual(await tableNames(pool), [
      "questions",
      "schema_migrations",
      "users",
    ]);

    const { rows } = await pool.query(
      "SELECT filename, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY filename",
    );
    assert.equal(rows.length, onDisk.length);
    for (const row of rows) {
      assert.equal(typeof row.checksum, "string");
      assert.ok(row.checksum.length > 0, "a checksum must be recorded");
      assert.ok(row.applied_at, "applied_at must be recorded");
      assert.equal(typeof row.duration_ms, "number");
    }
  });

  it("returns the migrations on disk in numeric order", async () => {
    // The ordering rule only becomes visible once the numbering passes 9 —
    // 010 must follow 009, which a lexical sort gets right and a numeric sort
    // also gets right, whereas 10 vs 9 separates them. With a single migration
    // in the directory this asserts the invariant rather than the interesting
    // case; it starts doing real work the moment a second migration lands.
    const sequence = (f) => Number.parseInt(/^(\d+)/.exec(f)?.[1] ?? "0", 10);
    const filenames = (await readMigrations()).map((m) => m.filename);

    assert.ok(filenames.length > 0);
    assert.deepEqual(
      filenames,
      [...filenames].sort((a, b) => sequence(a) - sequence(b)),
      "readMigrations() must return numerically ascending filenames",
    );
    for (const name of filenames) {
      assert.match(
        name,
        /^\d+_.+\.sql$/,
        "every migration needs a numeric prefix, or its position is undefined",
      );
    }
  });
});

// ── idempotency ────────────────────────────────────────────────────────────
describe("migrate() is idempotent", () => {
  it("applies nothing on a second run", async () => {
    const { pool } = await emptyDatabase("twice");

    const first = await migrate({ pool, quiet: true });
    const second = await migrate({ pool, quiet: true });

    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, [], "a second run must apply nothing");
    assert.deepEqual(second.skipped, first.applied);

    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM schema_migrations");
    assert.equal(
      rows[0].c,
      first.applied.length,
      "no duplicate tracking rows",
    );
  });

  it("does not disturb existing data", async () => {
    const { pool } = await emptyDatabase("data");
    await migrate({ pool, quiet: true });

    await pool.query("INSERT INTO users (username) VALUES ($1)", ["ada"]);
    await migrate({ pool, quiet: true });

    const { rows } = await pool.query("SELECT username FROM users");
    assert.deepEqual(rows, [{ username: "ada" }]);
  });
});

// ── failure handling ───────────────────────────────────────────────────────
describe("migrate() reports failure clearly", () => {
  it("rolls back a failing migration, records nothing, and names the file", async () => {
    const { pool } = await emptyDatabase("failing");

    // A throwaway migrations directory, not the real one: writing a broken file
    // into migrations/postgres/ would break every other suite running now.
    //
    // The second statement is invalid. If DDL were not transactional — or if the
    // runner did not wrap each file — `doomed` would survive the failure.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studypal-broken-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(dir, "001_ok.sql"),
      "CREATE TABLE fine (id BIGINT);",
    );
    await fs.writeFile(
      path.join(dir, "002_broken.sql"),
      "CREATE TABLE doomed (id BIGINT);\nCREATE TABLE doomed_two (id BIGINT) THIS IS NOT SQL;\n",
    );

    await assert.rejects(
      () => migrate({ pool, dir, quiet: true }),
      (err) => {
        // The filename is the whole point: a bare syntax error from pg does not
        // say which of the files it came from.
        assert.match(err.message, /002_broken\.sql/);
        assert.match(err.message, /at character \d+/);
        assert.ok(err.cause, "the pg error must be kept as the cause");
        return true;
      },
    );

    const tables = await tableNames(pool);
    assert.ok(
      tables.includes("fine"),
      "the migration that succeeded before the failure must stay applied",
    );
    assert.ok(
      !tables.includes("doomed"),
      "the failing file's own first statement must be rolled back",
    );

    const { rows } = await pool.query(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    assert.deepEqual(
      rows.map((r) => r.filename),
      ["001_ok.sql"],
      "only the migration that committed may be recorded",
    );

    // Re-running resumes at the failed file rather than skipping it.
    const status = await migrationStatus({ pool, dir });
    assert.deepEqual(status.pending, ["002_broken.sql"]);
  });

  it("refuses to migrate when an applied migration has been edited", async () => {
    const { pool } = await emptyDatabase("tamper");
    await migrate({ pool, quiet: true });

    // Simulate an edit by corrupting the stored checksum: equivalent to the file
    // changing under a database that already applied the old version.
    const [first] = await readMigrations();
    await pool.query(
      "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE filename = $1",
      [first.filename],
    );

    const status = await migrationStatus({ pool });
    assert.deepEqual(status.changed, [first.filename]);

    await assert.rejects(
      () => migrate({ pool, quiet: true }),
      /have been modified/,
    );
  });

  it("reports a tracking row with no file on disk", async () => {
    const { pool } = await emptyDatabase("orphan");
    await migrate({ pool, quiet: true });

    await pool.query(
      `INSERT INTO schema_migrations (filename, checksum, duration_ms)
       VALUES ('999_from_the_future.sql', 'abc123', 1)`,
    );

    const status = await migrationStatus({ pool });
    assert.deepEqual(status.orphaned, ["999_from_the_future.sql"]);
  });
});

// ── status reporting ───────────────────────────────────────────────────────
describe("migrationStatus()", () => {
  it("lists everything as pending before migrating, applied after", async () => {
    const { pool } = await emptyDatabase("status");

    const before = await migrationStatus({ pool });
    assert.ok(before.pending.length > 0);
    assert.ok(before.items.every((item) => !item.applied));
    assert.deepEqual(before.changed, []);
    assert.deepEqual(before.orphaned, []);

    await migrate({ pool, quiet: true });

    const afterStatus = await migrationStatus({ pool });
    assert.deepEqual(afterStatus.pending, []);
    assert.ok(afterStatus.items.every((item) => item.applied));
    assert.ok(
      afterStatus.items.every((item) => typeof item.appliedAt === "string"),
      "appliedAt must be an ISO string, as everywhere else in this codebase",
    );
  });
});

// ── the application works against a freshly migrated database ──────────────
describe("the app runs on a database created only by migrations", () => {
  it("serves every endpoint with no schema bootstrap of its own", async () => {
    // Nothing in src/ creates tables any more; if the app depended on an
    // implicit bootstrap, these calls would fail against a migrations-only
    // database. (The harness's clone is exactly that.)
    const { startServer, askForm, testUser } = await import(
      "./helpers/server-harness.mjs"
    );
    const server = await startServer({ label: "postmig" });
    cleanups.push(() => server.stop());

    const username = testUser("mig");

    assert.equal((await server.request("GET", "/health")).body.status, "ok");
    assert.equal(
      (await server.request("POST", "/api/session", { json: { username } }))
        .status,
      200,
    );
    assert.equal(
      (
        await server.request("POST", "/api/ask", {
          form: askForm({ username, question: "does the schema work?" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await server.request("GET", `/api/history/${username}`)).body.length,
      1,
    );
    assert.equal(
      (await server.request("GET", `/api/progress/${username}`)).body
        .total_questions,
      1,
    );
  });
});

// ── the safety guard ───────────────────────────────────────────────────────
describe("test database safety guard", () => {
  it("accepts the configured test database", () => {
    const url = testDatabaseUrl();
    assert.doesNotThrow(() => assertTestDatabase(url));
  });

  it("refuses a database that is not named like a test database", () => {
    for (const name of ["studypal", "postgres", "production", "studypal_prod"]) {
      assert.throws(
        () => assertTestDatabase(`postgresql://u:p@127.0.0.1:5432/${name}`),
        /Refusing to run destructive test setup/,
        `${name} must be refused`,
      );
    }
  });

  it("never puts the password in the refusal message", () => {
    try {
      assertTestDatabase("postgresql://user:sup3rsecret@127.0.0.1:5432/realdb");
      assert.fail("should have thrown");
    } catch (err) {
      assert.doesNotMatch(err.message, /sup3rsecret/);
      assert.match(err.message, /\*\*\*/);
    }
  });
});
