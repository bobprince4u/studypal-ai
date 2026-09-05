/**
 * Migration runner.
 *
 * Hand-written rather than delegated to node-pg-migrate / Umzug / Knex, because
 * what a migration framework adds beyond this file is a rollback DSL, a
 * JavaScript migration format and a CLI — and this project wants none of them.
 * The whole mechanism is: read the .sql files, compare against a tracking table,
 * apply the missing ones in order, inside transactions. That is one file and no
 * new dependency, and nothing about how the schema is created is hidden behind
 * someone else's abstraction.
 *
 * FORWARD-ONLY. There are no down migrations and no rollback command. A wrong
 * migration is corrected by writing the next one, which is what actually happens
 * in practice — a down migration that has never been executed is not a safety
 * net, it is untested code that gets run for the first time during an incident.
 * Recovering from a destructive migration is a restore-from-backup problem, and
 * a rollback script does not solve it either.
 *
 * Guarantees:
 *   • deterministic order — filenames are sorted, and the numeric prefix is
 *     compared as a number so 010 sorts after 009 rather than lexically
 *   • applied exactly once — recorded in schema_migrations, skipped thereafter
 *   • all-or-nothing per migration — each file runs in its own transaction, so a
 *     failure half-way leaves no partial schema and no tracking row
 *   • tamper-evident — the checksum of each applied file is stored and rechecked,
 *     so editing a migration that has already run is an error rather than a
 *     silent divergence between environments
 *   • loud failure — the file, the message and the PostgreSQL error position are
 *     reported, and the caller exits non-zero
 *
 * Every function takes an optional `pool`, defaulting to the application pool.
 * That is what lets the tests migrate a throwaway database in-process against
 * real PostgreSQL rather than mocking any of this.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../utils/logger.js";

/**
 * The application pool, imported lazily.
 *
 * A top-level `import { getPool }` would evaluate src/config/env.js as a side
 * effect of importing this module, which means the runner could not be used
 * against an explicitly supplied pool without a fully configured environment.
 * The test helper provisions databases before any application config exists, so
 * the dependency is resolved only when it is actually needed.
 */
async function defaultPool() {
  const { getPool } = await import("../config/database.js");
  return getPool();
}

/**
 * Where the PostgreSQL migrations live. `migrations/legacy-sqlite/` is a sibling
 * and is never read — see the header of the file in it.
 *
 * Resolved from this module's own location rather than from config, so the
 * runner has no dependency on environment parsing.
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "postgres",
);

/**
 * The tracking table.
 *
 * Created outside the migration sequence — a migration cannot record itself
 * before the table that records it exists. IF NOT EXISTS makes it idempotent.
 *
 * `checksum` is what turns this from a list of names into a verifiable record:
 * without it, an edited migration would be silently skipped on every machine
 * that had already run the old version.
 */
const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INTEGER NOT NULL
  )
`;

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/** Leading number in a filename, for numeric rather than lexical ordering. */
function sequence(filename) {
  const match = /^(\d+)/.exec(filename);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Every migration on disk, in the order it must be applied.
 *
 * @param {string} [dir=MIGRATIONS_DIR] directory to read. Overridden only by the
 *   tests, which need a directory containing a deliberately broken migration to
 *   exercise the failure path — writing one into the real directory would break
 *   every other suite running at the same time.
 * @returns {Promise<Array<{filename: string, sql: string, checksum: string}>>}
 */
export async function readMigrations(dir = MIGRATIONS_DIR) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No migrations directory at ${dir}`);
    }
    throw err;
  }

  const files = entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => sequence(a) - sequence(b) || a.localeCompare(b));

  return Promise.all(
    files.map(async (filename) => {
      const sql = await fs.readFile(path.join(dir, filename), "utf8");
      return { filename, sql, checksum: checksum(sql) };
    }),
  );
}

/** Rows already in schema_migrations, keyed by filename. */
async function appliedMigrations(pool) {
  await pool.query(TRACKING_TABLE_DDL);
  const { rows } = await pool.query(
    "SELECT filename, checksum, applied_at FROM schema_migrations",
  );
  return new Map(rows.map((row) => [row.filename, row]));
}

/**
 * What has run, what has not, and whether anything was edited after the fact.
 * Used by `npm run migrate:status`, by the startup check, and by the tests.
 *
 * @param {{pool?: import("pg").Pool, dir?: string}} [options]
 */
export async function migrationStatus({ pool, dir } = {}) {
  const target = pool ?? (await defaultPool());
  const [onDisk, applied] = await Promise.all([
    readMigrations(dir),
    appliedMigrations(target),
  ]);

  const items = onDisk.map((migration) => {
    const record = applied.get(migration.filename);
    return {
      filename: migration.filename,
      applied: Boolean(record),
      appliedAt: record?.applied_at ?? null,
      // An applied migration whose file no longer hashes the same was edited
      // after it ran. Every database that already applied it now differs from
      // what the file claims, so this is reported rather than tolerated.
      changed: Boolean(record) && record.checksum !== migration.checksum,
    };
  });

  // A row in the table with no file on disk: a deleted migration, or a database
  // migrated by a newer checkout than this one.
  const orphaned = [...applied.keys()].filter(
    (filename) => !onDisk.some((m) => m.filename === filename),
  );

  return {
    items,
    orphaned,
    pending: items.filter((item) => !item.applied).map((item) => item.filename),
    changed: items.filter((item) => item.changed).map((item) => item.filename),
  };
}

/**
 * Apply every pending migration, in order.
 *
 * Idempotent: running it twice applies nothing the second time.
 *
 * @param {{pool?: import("pg").Pool, quiet?: boolean, dir?: string}} [options]
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 * @throws {Error} if a migration fails, or if an applied one was edited
 */
export async function migrate({ pool, quiet = false, dir } = {}) {
  const target = pool ?? (await defaultPool());
  const onDisk = await readMigrations(dir);
  const applied = await appliedMigrations(target);

  // Checked before anything runs: a modified migration means this database and
  // the repository disagree about the schema, and applying further migrations on
  // top of that would compound the divergence.
  const edited = onDisk.filter((migration) => {
    const record = applied.get(migration.filename);
    return record && record.checksum !== migration.checksum;
  });
  if (edited.length > 0) {
    throw new Error(
      `Already-applied migration(s) have been modified: ` +
        `${edited.map((m) => m.filename).join(", ")}. ` +
        `A migration is immutable once it has run — this database has the old ` +
        `version and the file now says something different. Revert the file and ` +
        `write a new migration for the change.`,
    );
  }

  const result = { applied: [], skipped: [] };

  for (const migration of onDisk) {
    if (applied.has(migration.filename)) {
      result.skipped.push(migration.filename);
      continue;
    }

    // Its own client and its own transaction. PostgreSQL supports transactional
    // DDL, so a syntax error on the last statement of a file rolls back the
    // tables the earlier statements created.
    const client = await target.connect();
    const startedAt = Date.now();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      const durationMs = Date.now() - startedAt;
      // The tracking row is written in the same transaction as the DDL, so
      // "schema changed" and "migration recorded" cannot come apart.
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms)
         VALUES ($1, $2, $3)`,
        [migration.filename, migration.checksum, durationMs],
      );
      await client.query("COMMIT");

      result.applied.push(migration.filename);
      if (!quiet) {
        logger.info(`migration applied: ${migration.filename} (${durationMs}ms)`);
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // `position` is a character offset into the SQL; it is what makes a syntax
      // error findable. Wrapped rather than rethrown so the failing filename is
      // always part of the message.
      const where = err.position ? ` at character ${err.position}` : "";
      throw new Error(
        `Migration ${migration.filename} failed${where}: ${err.message}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  return result;
}
