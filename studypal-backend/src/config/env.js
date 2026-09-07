/**
 * Centralised, validated configuration.
 *
 * This is the ONLY module that reads process.env. Everything else imports the
 * frozen `config` object below, so there is a single place to see what the
 * service can be tuned with and what its defaults are.
 *
 * Loading order for .env files mirrors the Next.js convention: `.env.local`
 * wins over `.env`. The pre-refactor server used `import "dotenv/config"`,
 * which reads ONLY `.env` — while the repository actually ships `.env.local`.
 * The effect was that GEMINI_API_KEY silently stayed undefined unless it was
 * exported in the shell (recorded as A12 in docs/current-architecture.md).
 */

import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Earlier entries take precedence; dotenv never overwrites an already-set var,
// so a real environment variable always beats a file.
dotenv.config({
  path: [
    path.join(BACKEND_ROOT, ".env.local"),
    path.join(BACKEND_ROOT, ".env"),
  ],
  quiet: true,
});

/** Parse an integer env var, falling back when unset or unparseable. */
function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Split a comma-separated env var into a trimmed, de-duplicated list. */
function list(name) {
  return [
    ...new Set(
      (process.env[name] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

const nodeEnv = process.env.NODE_ENV || "development";

// ── storage directory ─────────────────────────────────────────────────────────

/**
 * Where uploaded materials are written.
 *
 * Resolved against BACKEND_ROOT rather than process.cwd(): the server can be
 * started from anywhere, and a relative path that moved with the working
 * directory would silently split one deployment's uploads across two
 * directories. An absolute STUDYPAL_STORAGE_DIR is honoured as given, which is
 * how a deployment points this at a mounted volume.
 *
 * The default is `<backend>/data/uploads` — outside every source directory and
 * excluded by .gitignore, so uploads can never be committed and are never mixed
 * in with code.
 *
 * Nothing is created here. Reading configuration must not have filesystem side
 * effects; src/storage/local-storage.service.js creates the directory when it
 * first needs to write, which is also the only place that touches the disk.
 */
function resolveStorageDir() {
  const raw = process.env.STUDYPAL_STORAGE_DIR?.trim();
  if (raw) return path.resolve(BACKEND_ROOT, raw);

  // Under NODE_ENV=test the default moves out of the repository entirely, for
  // the same reason STUDYPAL_TEST_DATABASE_URL is mandatory: a test run must not
  // be able to write into a developer's real data even if the harness forgets to
  // configure it. The suite sets this variable explicitly per server; this is
  // the backstop if something ever does not.
  if (nodeEnv === "test") {
    return path.join(os.tmpdir(), "studypal-test-uploads");
  }

  return path.join(BACKEND_ROOT, "data", "uploads");
}

// ── database URL ──────────────────────────────────────────────────────────────

/**
 * Resolve the PostgreSQL connection string.
 *
 * Under NODE_ENV=test only STUDYPAL_TEST_DATABASE_URL is consulted, and it is
 * mandatory. DATABASE_URL is not a fallback there: the test suite truncates and
 * re-migrates whatever it connects to, so silently borrowing the development
 * URL would destroy the developer's data. Failing to start is the safe outcome.
 *
 * There is no SQLite fallback anywhere. PostgreSQL is the only database.
 */
function resolveDatabaseUrl() {
  if (nodeEnv === "test") {
    const url = process.env.STUDYPAL_TEST_DATABASE_URL?.trim();
    if (!url) {
      throw new Error(
        "STUDYPAL_TEST_DATABASE_URL is required when NODE_ENV=test. " +
          "It must point at a database that exists only for tests — the suite " +
          "drops and recreates its schema. DATABASE_URL is deliberately not " +
          "used as a fallback.",
      );
    }
    return url;
  }

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. StudyPal stores everything in PostgreSQL and " +
        "has no local-file fallback. Example: " +
        "postgresql://user:password@127.0.0.1:5434/studypal " +
        "(see .env.example and compose.yaml).",
    );
  }
  return url;
}

const databaseUrl = resolveDatabaseUrl();

/** Parse a connection string, tolerating values libpq accepts but URL does not. */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * A connection string with the password removed.
 *
 * Every log line, error message and health payload that mentions the database
 * uses this. The raw URL is never written anywhere: it carries a credential.
 */
function redactUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return "<unparseable DATABASE_URL>";
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}

/** Database name from the URL path, or "" when it cannot be determined. */
function databaseName(url) {
  return decodeURIComponent(parseUrl(url)?.pathname.replace(/^\//, "") ?? "");
}

/**
 * Whether this URL names something that is obviously a throwaway test database.
 *
 * Used as a guard, never as a convenience: destructive setup refuses to run
 * unless the name matches. A developer database called `studypal` fails the
 * check, which is the entire point.
 */
function looksLikeTestDatabase(url) {
  return /(^|[_-])test($|[_-])|_test$|^test/i.test(databaseName(url));
}

/**
 * TLS for the connection. Off by default because local development runs over
 * loopback to a container; managed providers need DB_SSL=true.
 *
 * DB_SSL_REJECT_UNAUTHORIZED=false exists for providers that present a
 * self-signed certificate. It weakens the connection, so it is opt-in and
 * reported by configWarnings().
 */
const sslEnabled = /^(1|true|yes|require)$/i.test(process.env.DB_SSL ?? "");
const sslRejectUnauthorized = !/^(0|false|no)$/i.test(
  process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "",
);
const sslConfig = sslEnabled
  ? Object.freeze({ rejectUnauthorized: sslRejectUnauthorized })
  : false;

/**
 * Origins permitted by CORS.
 *
 * When this list is EMPTY the server keeps the pre-refactor behaviour of
 * reflecting any origin (`Access-Control-Allow-Origin: *`) and logs a warning
 * at startup. That default is deliberate: tightening CORS silently would break
 * whatever frontend deployment is currently live, and this iteration values
 * backward compatibility over architectural purity.
 */
const corsOrigins = [
  ...new Set(
    [process.env.FRONTEND_URL?.trim(), ...list("CORS_ORIGINS")].filter(Boolean),
  ),
];

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === "production",
  isTest: nodeEnv === "test",

  port: int("PORT", 4000),

  backendRoot: BACKEND_ROOT,

  storage: Object.freeze({
    /**
     * Absolute directory holding uploaded materials. Always absolute, always
     * outside the source tree, never created as a side effect of reading config.
     */
    dir: resolveStorageDir(),
  }),

  database: Object.freeze({
    /**
     * PostgreSQL connection string. Under NODE_ENV=test the test-only variable
     * is required and DATABASE_URL is ignored entirely, so `npm test` cannot
     * reach the developer's working database even by accident.
     */
    url: databaseUrl,
    /** Same URL with the password replaced — the only form safe to log. */
    safeUrl: redactUrl(databaseUrl),
    /** Parsed for messages and for the test-database safety check. */
    name: databaseName(databaseUrl),
    ssl: sslConfig,
    pool: Object.freeze({
      /** Small on purpose: SQLite had one writer, and Node is single-threaded. */
      max: int("DB_POOL_MAX", 10),
      idleTimeoutMillis: int("DB_IDLE_TIMEOUT_MS", 30_000),
      /** Fail a request rather than queue forever behind an unreachable host. */
      connectionTimeoutMillis: int("DB_CONNECT_TIMEOUT_MS", 5_000),
    }),
    /** Guard for destructive test setup; see tests/helpers/test-database.mjs. */
    isTestUrl: looksLikeTestDatabase(databaseUrl),
  }),

  cors: Object.freeze({
    origins: Object.freeze(corsOrigins),
    /** No configured origins ⇒ permissive, as before. */
    allowAll: corsOrigins.length === 0,
  }),

  ai: Object.freeze({
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
    /**
     * Request timeout in ms. Defaults to 0 = no timeout, which is what the
     * pre-refactor server did. Left off by default so this refactor does not
     * change how long a legitimate slow generation may take; see
     * docs/security-baseline.md for why it is nonetheless recommended.
     */
    timeoutMs: int("AI_TIMEOUT_MS", 0),
  }),

  limits: Object.freeze({
    /** Express default was 100kb; preserved so the 413 boundary is unchanged. */
    jsonBody: process.env.JSON_BODY_LIMIT || "100kb",
    /** Pre-refactor: unlimited (memoryStorage with no limits). */
    uploadBytes: int("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    /** Pre-refactor: unbounded. 200 is far above any real name or student id. */
    usernameLength: int("MAX_USERNAME_LENGTH", 200),
    /** Both hardcoded in the pre-refactor SQL; same values, now visible. */
    historyItems: int("HISTORY_LIMIT", 30),
    progressTopics: int("PROGRESS_TOPICS_LIMIT", 6),
    /** Characters of extracted document text forwarded to the model. */
    documentTextChars: int("DOCUMENT_TEXT_CHARS", 4000),

    /**
     * Maximum size of an uploaded study material, in bytes.
     *
     * Separate from `uploadBytes` (which bounds a /api/ask attachment) because
     * the two endpoints have different jobs: an attachment is inlined into one
     * prompt, whereas a material is stored, extracted and chunked. They share
     * the same 10 MB default, so nothing changes unless a deployment sets this
     * — but a deployment that wants 50 MB textbooks should not have to raise the
     * limit on prompt attachments to get them.
     */
    materialUploadBytes: int(
      "MAX_MATERIAL_BYTES",
      int("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    ),

    /** Items returned by GET /api/materials. */
    materialListItems: int("MATERIAL_LIST_LIMIT", 100),

    /**
     * Longest `original_filename` accepted. Matches the
     * materials_original_filename_bounded CHECK constraint in
     * migrations/postgres/002_materials.sql — validation rejects an over-long
     * name with a useful message, the constraint stops a code path that skips
     * validation.
     */
    materialFilenameLength: int("MAX_MATERIAL_FILENAME_LENGTH", 512),
  }),

  logLevel: process.env.LOG_LEVEL || (nodeEnv === "test" ? "silent" : "info"),
});

/**
 * Warnings for configuration that works but should not ship as-is.
 * Returned rather than logged so the caller controls output.
 */
export function configWarnings() {
  const warnings = [];

  if (!config.ai.apiKey) {
    warnings.push(
      "GEMINI_API_KEY is not set — POST /api/ask will fail with 500. " +
        "Other endpoints and GET /health are unaffected.",
    );
  }

  if (config.cors.allowAll) {
    warnings.push(
      "CORS is open to all origins. Set FRONTEND_URL or CORS_ORIGINS " +
        "(comma-separated) to restrict it.",
    );
  }

  if (config.isProduction && !config.database.ssl) {
    warnings.push(
      "Database TLS is disabled (DB_SSL is unset) while NODE_ENV=production. " +
        "Credentials and student data cross the network in the clear unless the " +
        "connection is already inside a private network or a local socket.",
    );
  }

  if (config.database.ssl && !config.database.ssl.rejectUnauthorized) {
    warnings.push(
      "DB_SSL_REJECT_UNAUTHORIZED=false — the database certificate is not " +
        "verified, so TLS protects against passive eavesdropping only.",
    );
  }

  if (config.isProduction && config.database.isTestUrl) {
    warnings.push(
      `Database "${config.database.name}" is named like a test database while ` +
        "NODE_ENV=production. Check DATABASE_URL points where you intend.",
    );
  }

  return warnings;
}
