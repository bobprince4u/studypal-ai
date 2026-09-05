/**
 * PostgreSQL connection pool.
 *
 * Replaces the better-sqlite3 file handle from SP-V2-001. There is no SQLite
 * fallback: if PostgreSQL is unreachable the server still starts and serves
 * GET /health as `degraded` (503), while the data endpoints fail with a 500.
 * That choice is documented in docs/database-architecture.md — a crash loop on
 * a transient database blip would be worse than a service that reports its own
 * state to an orchestrator.
 *
 * Everything above this module talks to `query()` / `withTransaction()`; nothing
 * else imports `pg`. Schema creation is NOT done here — it belongs to the
 * migration runner (`npm run migrate`), so a running server never mutates DDL.
 */

import pg from "pg";

import { config } from "./env.js";
import { registerTypeParsers } from "./pg-types.js";
import { logger } from "../utils/logger.js";

const { Pool } = pg;

// BIGINT as a number, TIMESTAMPTZ as an ISO-8601 string. See pg-types.js: the
// registry pg keeps is global, so this lives in its own module and every
// entrypoint that opens a pool calls it — otherwise a second pool silently
// returns counts as strings and timestamps as Dates.
registerTypeParsers();

let pool = null;

/**
 * The process-wide connection pool, created on first use.
 *
 * One pool per process, never one connection per request: a new TCP connection
 * and PostgreSQL backend per HTTP request would dominate the latency of every
 * endpoint and exhaust `max_connections` under trivial load.
 *
 * @returns {import("pg").Pool}
 */
export function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    max: config.database.pool.max,
    idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.pool.connectionTimeoutMillis,
    application_name: "studypal-backend",
    // Pin the session time zone so TIMESTAMPTZ always comes back with a +00
    // offset regardless of the server's or the container's local zone. Without
    // it, the same row renders differently on two machines.
    options: "-c timezone=UTC",
  });

  /**
   * An idle client erroring (server restart, network drop, admin terminating
   * the backend) emits 'error' on the pool. Without this listener that is an
   * unhandled 'error' event, which takes the whole process down — so the
   * database restarting would kill the API. pg discards the broken client and
   * the next query gets a fresh one; logging is all that is needed.
   */
  pool.on("error", (err) => {
    logger.error(`idle database client error: ${err.message}`);
  });

  // Safe to log: the password is redacted in config.
  logger.info(`database pool ready → ${config.database.safeUrl}`);
  return pool;
}

/**
 * Run a parameterised query.
 *
 * `values` are always sent as bind parameters — no caller builds SQL by
 * concatenating user input, and none may start. See docs/security-baseline.md.
 *
 * @param {string} sql
 * @param {Array<unknown>} [values]
 * @returns {Promise<import("pg").QueryResult>}
 */
export function query(sql, values = []) {
  return getPool().query(sql, values);
}

/**
 * Run `fn` inside a single transaction on one dedicated client.
 *
 * Used deliberately, not everywhere: a lone INSERT or SELECT is already atomic,
 * and wrapping it adds two round trips for nothing. This exists for the cases
 * that genuinely need it — currently the migration runner and the upsert-then-
 * insert in the question service.
 *
 * @template T
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // Best-effort: if the connection itself died, ROLLBACK will fail too and
    // the original error is the one worth propagating.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool. Used by graceful shutdown and by tests. */
export async function closeDatabase() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/**
 * Cheap liveness probe for GET /health. Deliberately does not touch Gemini.
 *
 * The error message is returned for the caller to LOG, never to serialise: a
 * connection error can contain the host, port and user.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function checkDatabaseHealth() {
  try {
    await query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
