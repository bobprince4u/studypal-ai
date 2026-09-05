/**
 * How this application reads PostgreSQL values.
 *
 * pg's type parsers are GLOBAL — `types.setTypeParser` mutates a process-wide
 * registry, not a pool. That is convenient for the app, which has one pool, and
 * a trap for anything that opens a second one: a pool created without this
 * module loaded gets pg's defaults, so `COUNT(*)` arrives as the string "1" and
 * a timestamp as a JS Date. Those are exactly the two shapes the API contract
 * forbids, and the failure is silent.
 *
 * So the registration lives here, in one importable function, rather than as a
 * side effect of importing the pool. src/config/database.js calls it; so does
 * anything else that builds its own client (the migration tooling, the test
 * helpers). Calling it more than once is harmless.
 */

import pg from "pg";

const { types } = pg;

/**
 * Normalise TIMESTAMPTZ/TIMESTAMP text to an ISO-8601 string.
 *
 * The API contract is that `created_at` round-trips exactly:
 * `new Date(created_at).toISOString() === created_at`. PostgreSQL sends
 * `2026-09-05 11:22:33.456+00`, which `new Date()` accepts but which is not
 * itself ISO-8601, and pg's default JS Date would serialise via toJSON to
 * millisecond precision anyway. Converting here means every layer above sees the
 * same string shape SQLite produced.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
export function toIso(value) {
  if (value === null) return null;

  // Two things make the wire format unparseable by `new Date()`: the space
  // instead of a T, and a two-digit offset ("+00"), which ES requires to be
  // "+00:00". A bare timestamp with no offset is read as UTC, which is correct —
  // the column is TIMESTAMPTZ and the session TimeZone is pinned to UTC.
  let text = value.replace(" ", "T");
  if (/[+-]\d{2}$/.test(text)) text += ":00";
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += "Z";

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

let registered = false;

/**
 * Install the parsers. Idempotent, so every entrypoint can call it unconditionally.
 */
export function registerTypeParsers() {
  if (registered) return;
  registered = true;

  /**
   * BIGINT (oid 20) as a JS number rather than pg's default string.
   *
   * Only COUNT(*) results and our own identity keys are bigint here, and both
   * are far below Number.MAX_SAFE_INTEGER. The contract tests assert
   * `total_questions` and `topics[].count` are numbers, and a string would be a
   * visible API change. Keeping the coercion in one place beats a parseInt at
   * every call site.
   */
  types.setTypeParser(types.builtins.INT8, (value) =>
    value === null ? null : Number(value),
  );

  types.setTypeParser(types.builtins.TIMESTAMPTZ, toIso);
  types.setTypeParser(types.builtins.TIMESTAMP, toIso);
}
