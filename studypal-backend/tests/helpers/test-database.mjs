/**
 * Test database isolation.
 *
 * Before SP-V2-002 each test got its own SQLite file in a temp directory, so
 * isolation was free. PostgreSQL is a shared server, so isolation now has to be
 * arranged — and arranged carefully, because the setup here is destructive.
 *
 * THE GUARD
 * ---------
 * Nothing in this file touches a database whose name does not look like a test
 * database. `assertTestDatabase()` runs before every destructive operation and
 * throws otherwise. STUDYPAL_TEST_DATABASE_URL is also the ONLY source of the
 * connection string under NODE_ENV=test — src/config/env.js refuses to fall back
 * to DATABASE_URL — so `npm test` cannot reach the developer's working database
 * even if DATABASE_URL is the only variable set. Both mechanisms have to be
 * defeated deliberately for `npm test` to destroy real data.
 *
 * THE STRATEGY
 * ------------
 * One template database is migrated once per run. Each test process then gets its
 * own database CREATEd from that template, which is a file copy inside
 * PostgreSQL — far cheaper than re-running migrations, and gives each suite a
 * private schema with no cross-talk. Every per-run database is named
 * `<base>_run_<pid>_<n>` so a crashed run's leftovers are identifiable, and
 * `dropStaleTestDatabases()` clears them.
 *
 * THE LOCK
 * --------
 * `node --test` runs each test FILE in its own process, so the template is shared
 * by processes that know nothing about each other. Two things then collide: two
 * processes resetting the template at once (PostgreSQL reports a duplicate key on
 * pg_namespace, because both are creating schema `public`), and one process
 * cloning the template while another holds a connection to it (`CREATE DATABASE
 * … TEMPLATE` requires the source to have no other sessions). A per-process cache
 * cannot prevent either. Both operations are therefore taken under a PostgreSQL
 * advisory lock keyed on the base database name — cross-process by construction,
 * and released automatically if a test process dies.
 *
 * PostgreSQL is real here. Nothing is mocked: a mocked database cannot tell you
 * that a CHECK constraint rejects a row or that a migration applies cleanly,
 * which is most of what these tests are for. Gemini is still faked, by
 * tests/helpers/fake-gemini.mjs — the provider is a paid third party, the
 * database is not.
 */

import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { registerTypeParsers } from "../../src/config/pg-types.js";

const { Pool } = pg;

/**
 * Read values the way the application does.
 *
 * pg's type parsers are process-global but are installed by
 * src/config/database.js, which a test that opens its own Pool never imports.
 * Without this, a test would see COUNT(*) as the string "1" and a timestamp as a
 * Date — pg's defaults, not the app's — and would then assert against the wrong
 * shapes. pg-types.js has no config dependency, so importing it here is safe
 * even before any environment is set up.
 */
registerTypeParsers();

const BACKEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Load the same .env files the application does, in the same precedence order.
 *
 * The test RUNNER process needs STUDYPAL_TEST_DATABASE_URL before it can
 * provision anything, and unlike the servers it spawns it is not started by
 * server.js, so nothing else has loaded it. dotenv never overwrites a variable
 * that is already set, so an explicit environment variable still wins — which is
 * how CI supplies its own database.
 */
dotenv.config({
  path: [path.join(BACKEND_ROOT, ".env.local"), path.join(BACKEND_ROOT, ".env")],
  quiet: true,
});

/** The test connection string. Required; never defaulted to DATABASE_URL. */
export function testDatabaseUrl() {
  const url = process.env.STUDYPAL_TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "STUDYPAL_TEST_DATABASE_URL is not set.\n\n" +
        "The test suite needs its own PostgreSQL database because it drops and " +
        "recreates schemas. It will not borrow DATABASE_URL.\n\n" +
        "  npm run db:up\n" +
        "  createdb studypal_test   # or see README\n" +
        "  STUDYPAL_TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5434/studypal_test\n",
    );
  }
  return url;
}

/** Database name from a connection string. */
export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Replace the database name in a connection string, keeping credentials. */
function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

/** A connection string safe to put in an error message. */
function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable url>";
  }
}

/**
 * Names this helper is willing to destroy.
 *
 * Deliberately narrow. "studypal" does not match; "studypal_test" does. This is
 * the check standing between `npm test` and a developer's working data, so it
 * errs toward refusing.
 */
function looksLikeTestDatabase(name) {
  return /(^|[_-])test($|[_-])|_test\b|^test/i.test(name);
}

/**
 * Throw unless `url` names something that is obviously a test database.
 *
 * Called at the top of every function here that drops, truncates or recreates.
 * @param {string} url
 */
export function assertTestDatabase(url) {
  const name = databaseNameOf(url);
  if (!looksLikeTestDatabase(name)) {
    throw new Error(
      `Refusing to run destructive test setup against database "${name}" ` +
        `(${redact(url)}).\n\n` +
        `The name must contain "test" — this check exists so a mistyped ` +
        `STUDYPAL_TEST_DATABASE_URL cannot wipe a development or production ` +
        `database. Point it at e.g. "${name}_test" instead.`,
    );
  }
  return name;
}

/**
 * Connect to the `postgres` maintenance database.
 *
 * CREATE/DROP DATABASE cannot run while connected to the database in question,
 * so administrative work goes through this one.
 */
function adminPool(url) {
  return new Pool({
    connectionString: withDatabase(url, "postgres"),
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
}

let sequence = 0;

/**
 * Create a private, migrated database and return its connection string.
 *
 * The first call migrates the base test database, which then acts as a template.
 * Every call after that copies it, so migration cost is paid once per run rather
 * than once per suite.
 *
 * @param {object} [options]
 * @param {string} [options.label] included in the name, to make a leftover
 *   database traceable to the suite that made it
 * @returns {Promise<{url: string, name: string, drop: () => Promise<void>}>}
 */
export async function createIsolatedDatabase({ label = "suite" } = {}) {
  const baseUrl = testDatabaseUrl();
  const baseName = assertTestDatabase(baseUrl);

  await ensureTemplateMigrated(baseUrl);

  // Postgres identifiers cap at 63 bytes, so the label is truncated rather than
  // silently mangled.
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 12);
  const name = `${baseName}_run_${process.pid}_${++sequence}_${safeLabel}`.slice(
    0,
    63,
  );
  const url = withDatabase(baseUrl, name);

  // Under the lock: CREATE DATABASE … TEMPLATE fails outright if any other
  // session is connected to the template, and with three test files running in
  // parallel processes that is otherwise a routine occurrence rather than a rare
  // race.
  await withTemplateLock(baseUrl, async (admin) => {
    // TEMPLATE copies the already-migrated schema. Identifiers cannot be bind
    // parameters in DDL, so they are quoted by quoteIdent() — the names are
    // generated here, never user input, and are constrained to [a-z0-9_].
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    await admin.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(baseName)}`,
    );
  });

  return {
    url,
    name,
    async drop() {
      const pool = adminPool(baseUrl);
      try {
        await pool.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
        );
      } finally {
        await pool.end();
      }
    },
  };
}

/**
 * Quote an identifier for DDL.
 *
 * DDL cannot use bind parameters, so this is the correct escaping for the one
 * place that needs it. Every name passed here is generated by this file from
 * [a-z0-9_] characters — no user input reaches it — and the assertion below
 * makes that a checked property rather than a comment.
 */
function quoteIdent(name) {
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`Unsafe database identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * A stable 64-bit key for the advisory lock, derived from the base database name.
 *
 * Keyed on the name rather than a constant so two checkouts pointed at different
 * test databases on one PostgreSQL server do not block each other.
 */
function lockKey(baseName) {
  const digest = crypto.createHash("sha256").update(baseName).digest();
  // Signed 64-bit, which is what pg_advisory_lock(bigint) takes. asIntN keeps it
  // in range instead of wrapping unpredictably.
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * Run `fn` while holding the cross-process advisory lock on the template.
 *
 * `pg_advisory_lock` is session-scoped: it is released by the explicit unlock
 * below and, if this process dies mid-test, by PostgreSQL when the connection
 * closes. That is the property a lock file or an in-process mutex would not have.
 *
 * @param {string} baseUrl
 * @param {(admin: import("pg").Pool) => Promise<void>} fn given the SAME
 *   connection that holds the lock, so the work happens inside it
 */
async function withTemplateLock(baseUrl, fn) {
  const baseName = assertTestDatabase(baseUrl);
  // max: 1 so the lock and the work are guaranteed to share a connection —
  // advisory locks belong to a session, not to a pool.
  const admin = adminPool(baseUrl);
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [lockKey(baseName).toString()]);
    try {
      await fn(admin);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [
        lockKey(baseName).toString(),
      ]).catch(() => {});
    }
  } finally {
    await admin.end();
  }
}

let templateReady = null;

/**
 * Migrate the base test database, once per RUN rather than once per process.
 *
 * Two layers, because there are two kinds of concurrency:
 *   • the promise cache stops repeat work inside one process
 *   • the advisory lock stops parallel test FILES, which are separate processes,
 *     from resetting the same template at the same time — that collision shows up
 *     as "duplicate key value violates unique constraint pg_namespace_nspname_index"
 *     when two DROP/CREATE SCHEMA pairs interleave
 *
 * Inside the lock the work is skipped if another process already did it: the
 * template is only reset when it has no schema_migrations table or has rows that
 * disagree with the files on disk. Re-migrating an already-correct template would
 * be harmless but would also serialise every suite behind a needless reset.
 */
function ensureTemplateMigrated(baseUrl) {
  templateReady ??= (async () => {
    assertTestDatabase(baseUrl);
    await ensureDatabaseExists(baseUrl);

    // Imported lazily: importing the migrator pulls in src/config/database.js,
    // which reads config — and this helper is also used by tooling that runs
    // before the app's environment is set up.
    const { migrate, migrationStatus } = await import("../../src/db/migrator.js");

    await withTemplateLock(baseUrl, async () => {
      const pool = new Pool({ connectionString: baseUrl, max: 2 });
      try {
        if (await templateIsCurrent(pool, migrationStatus)) return;
        // Reset, not merely migrate: rows left by a previous run would be copied
        // into every per-suite database, and a changed migration file means the
        // existing schema no longer matches the repository.
        await resetSchema(pool);
        await migrate({ pool, quiet: true });
      } finally {
        await pool.end();
      }
    });
  })();

  return templateReady;
}

/**
 * Is the template already migrated to exactly what is on disk, and empty?
 *
 * Answers "has a sibling process already done this?" without trusting a flag: it
 * asks the database. Anything unexpected returns false, so the caller resets —
 * the expensive-but-correct branch.
 */
async function templateIsCurrent(pool, migrationStatus) {
  try {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS tracked,
              to_regclass('public.users') IS NOT NULL AS has_users,
              to_regclass('public.questions') IS NOT NULL AS has_questions`,
    );
    if (!rows[0].tracked || !rows[0].has_users || !rows[0].has_questions) {
      return false;
    }

    const status = await migrationStatus({ pool });
    if (status.pending.length > 0) return false;
    if (status.changed.length > 0) return false;
    if (status.orphaned.length > 0) return false;

    // A template with rows in it would copy them into every clone, and the
    // suites assert on empty tables.
    const { rows: counts } = await pool.query(
      "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM questions) AS total",
    );
    return Number(counts[0].total) === 0;
  } catch {
    return false;
  }
}

/** CREATE the base test database if it is not there yet. */
async function ensureDatabaseExists(url) {
  const name = assertTestDatabase(url);
  const admin = adminPool(url);
  try {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Drop and recreate the public schema — the destructive operation this whole
 * file's guard exists for.
 *
 * DROP SCHEMA CASCADE rather than TRUNCATE: it also removes schema_migrations,
 * so the migration tests genuinely start from an empty database and can assert
 * that migrating creates the tables.
 *
 * @param {import("pg").Pool} pool connected to a database that passed the guard
 */
export async function resetSchema(pool) {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/**
 * Remove databases left behind by crashed runs.
 *
 * Matches only `<base>_run_%`, never the base database itself, and never
 * anything outside the guard.
 *
 * @returns {Promise<string[]>} names dropped
 */
export async function dropStaleTestDatabases() {
  const baseUrl = testDatabaseUrl();
  const baseName = assertTestDatabase(baseUrl);

  const admin = adminPool(baseUrl);
  const dropped = [];
  try {
    const { rows } = await admin.query(
      "SELECT datname FROM pg_database WHERE datname LIKE $1",
      [`${baseName}_run_%`],
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
      dropped.push(datname);
    }
  } finally {
    await admin.end();
  }
  return dropped;
}
