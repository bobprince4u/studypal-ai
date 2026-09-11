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

/**
 * Parse a similarity threshold: a number in [0, 1].
 *
 * `int()` cannot be reused for this, and not only because it rejects fractions —
 * it rejects 0, which is a meaningful value here (accept every retrieved chunk
 * regardless of score). A separate parser also keeps the error message
 * specific: "expected a number between 0 and 1" tells you the domain, whereas
 * "expected a positive integer" would be actively misleading for a threshold.
 */
function ratio(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `Invalid ${name}: expected a number between 0 and 1 inclusive, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Parse the embedding dimensionality, rejecting values the model cannot produce.
 *
 * gemini-embedding-001 supports Matryoshka output between 128 and 3072. A value
 * outside that range is not a preference, it is a request the provider will
 * reject on every call — so this throws at startup rather than at the first
 * upload. The check is against the *model's* range; whether the value matches
 * the migrated column width is a separate question that configWarnings() raises,
 * because only a migration can answer it.
 */
function dimensions(name, fallback) {
  const n = int(name, fallback);
  if (n < 128 || n > 3072) {
    throw new Error(
      `Invalid ${name}: gemini-embedding-001 supports 128 to 3072 dimensions, got ${n}. ` +
        "Note that changing this from the migrated width also requires a migration " +
        "and re-embedding every chunk — see migrations/postgres/003_material_embeddings.sql.",
    );
  }
  return n;
}

/**
 * The width `material_chunks.embedding` was actually created with, in
 * migrations/postgres/003_material_embeddings.sql.
 *
 * Duplicated here on purpose, as the one thing this module knows about the
 * schema, so that a mismatch is reported at startup by a process that has not
 * yet tried to insert anything. PostgreSQL would otherwise report it as
 * `expected 1536 dimensions, not 768` on every chunk of every upload, from deep
 * inside the indexing path, where it reads like a bug rather than a setting.
 */
const MIGRATED_EMBEDDING_DIMENSIONS = 1536;

/**
 * The ceilings migrations/postgres/004_study_plans.sql actually enforces.
 *
 * Same purpose as MIGRATED_EMBEDDING_DIMENSIONS above: this module's one piece
 * of schema knowledge, held so that a configuration which the database would
 * reject is reported at startup rather than as a constraint violation on the
 * first plan anyone tries to create. A CHECK failure surfaces as a 500 from
 * inside the persistence layer, where it reads as a bug in the code rather than
 * as a number someone set too high.
 */
const PLAN_DB_MAX_DAILY_MINUTES = 1440;
const PLAN_DB_MAX_TEXT_CHARS = 200;

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

  /**
   * Retrieval-augmented generation: embeddings and similarity search.
   *
   * ONE authoritative place for every value the RAG path depends on (§29). The
   * model name in particular appears nowhere else in `src/` — not in the client,
   * not in a repository, not in a prompt — because a second copy of it is how a
   * corpus ends up with vectors from two different models in one column, which
   * is silent, unrecoverable nonsense: cosine distance between them is a number,
   * it is just not a distance.
   */
  rag: Object.freeze({
    /**
     * The embedding model. `gemini-embedding-001`, not `gemini-embedding-2`, and
     * this is not a "newer is better" oversight.
     *
     * embedding-001 returns ONE VECTOR PER INPUT STRING. embedding-2, given a
     * list of inputs, returns a SINGLE AGGREGATED embedding for the whole list.
     * Batching chunks through embedding-2 would therefore store one vector
     * describing the concatenation of every chunk — every row identical, every
     * similarity score meaningless — and nothing about the response shape says
     * so. A test asserting "results were returned" would pass.
     *
     * embedding-001 also supports the taskType enum, which embedding-2 dropped.
     * That matters: documents are embedded as RETRIEVAL_DOCUMENT and questions
     * as RETRIEVAL_QUERY, which is what makes an interrogative sentence land
     * near the declarative passage that answers it instead of near other
     * questions. See src/ai/embedding.service.js.
     */
    embeddingModel: process.env.STUDYPAL_EMBEDDING_MODEL || "gemini-embedding-001",

    /**
     * Output dimensionality, and the width of `material_chunks.embedding`.
     *
     * These two numbers MUST agree. They are checked against each other at
     * startup — see configWarnings() — and asserted by
     * tests/materials/embeddings.test.js, because a mismatch produces a
     * PostgreSQL error on every single insert and nothing before that point
     * would notice.
     *
     * 1536 rather than the model's native 3072 because pgvector's ANN indexes
     * cap at 2000 dimensions, and the model is Matryoshka-trained so the
     * truncation is supported (MTEB 68.2 → 68.17). Full reasoning in
     * migrations/postgres/003_material_embeddings.sql.
     *
     * CHANGING THIS INVALIDATES EVERY STORED VECTOR. Not just the column width:
     * a 1536-truncation and a 3072 vector describe different spaces, so they
     * cannot be compared even after padding. It needs a migration and a
     * re-index of every chunk, which is why it lives beside the model name.
     */
    embeddingDimensions: dimensions(
      "STUDYPAL_EMBEDDING_DIM",
      MIGRATED_EMBEDDING_DIMENSIONS,
    ),
    /**
     * Chunks per embedContent request. Configurable per §10 because provider
     * batch limits are a provider's business and may change without our
     * releasing anything.
     *
     * 32 is conservative on purpose: a batch is all-or-nothing, so a large batch
     * turns one transient failure into a lot of re-work, and the request body
     * grows by ~1.8 KB per chunk.
     */
    embeddingBatchSize: int("STUDYPAL_EMBEDDING_BATCH_SIZE", 32),

    /** Chunks retrieved per question, when the request does not ask for fewer. */
    topK: int("STUDYPAL_RAG_TOP_K", 5),

    /**
     * The ceiling a request cannot exceed (§13). A client may ask for fewer
     * chunks than `topK`; it may not ask for 10,000 and turn one question into a
     * table scan plus a prompt the size of the corpus. Requests above this are
     * clamped, not rejected — the parameter is a hint, not a contract.
     */
    maxTopK: int("STUDYPAL_RAG_MAX_TOP_K", 20),

    /**
     * Minimum cosine similarity for a chunk to count as evidence, where
     * similarity = 1 - cosine_distance.
     *
     * 0.5 is a starting point, not a law, and §13 is explicit that no threshold
     * is universally correct — it depends on the model, the chunk size and the
     * subject matter. It is set low enough that a genuinely relevant passage
     * phrased differently from the question still qualifies, and high enough
     * that an unrelated question returns nothing rather than the least-unrelated
     * chunk in the document. The consequence of "nothing" is an honest "your
     * materials do not cover this", which is the correct answer to a question
     * the materials do not cover.
     */
    similarityThreshold: ratio("STUDYPAL_RAG_SIMILARITY_THRESHOLD", 0.5),

    /**
     * Hard ceiling on retrieved characters placed in one prompt (§18).
     *
     * 12000 ≈ 6-7 chunks at the current 1800-char chunk size, so it binds only
     * when topK is raised well above its default — it is a backstop against a
     * pathological request, not a routine truncation. Characters rather than
     * tokens: the tokenizer is the provider's, the budget has to be enforced
     * before the request leaves, and a character count is exact where a token
     * estimate is a guess. src/materials/context-builder.js drops whole chunks
     * at the boundary rather than cutting one mid-sentence.
     */
    maxContextChars: int("STUDYPAL_RAG_MAX_CONTEXT_CHARS", 12_000),

    /**
     * Longest accepted question (§14). An enormous "question" is not a query —
     * embedding models truncate their input anyway, so the tail would silently
     * not participate in the search while still being billed for.
     */
    maxQuestionChars: int("STUDYPAL_RAG_MAX_QUESTION_CHARS", 2000),
  }),

  /**
   * AI-generated study plans (SP-V2-005).
   *
   * Every number the study-plan path uses to accept or refuse a request lives
   * here, for the reason §48 gives: the alternative is the same literal written
   * into a validator, a normalizer and a test, where changing it means finding
   * all three. What is NOT here is anything the model decides — there is no
   * knob for how many tasks a day should have or how long one should be,
   * because those are pedagogical judgements the generator makes within these
   * bounds, not settings.
   *
   * Retrieval settings are deliberately absent too. A material-grounded plan
   * uses config.rag.topK and config.rag.similarityThreshold unchanged, because
   * §15 is explicit that this feature must reuse the existing retrieval service
   * rather than grow a second one — and a second set of tuning knobs is how a
   * second implementation starts.
   */
  plan: Object.freeze({
    /**
     * Topics one request may name (§10). 20 is well past any real exam syllabus
     * at this granularity, and the point of the limit is the prompt: every topic
     * is a line the model must plan around, and a request with 500 of them is
     * not a study plan, it is a way to make one HTTP call cost a lot of tokens.
     */
    maxTopics: int("STUDYPAL_PLAN_MAX_TOPICS", 20),

    /**
     * Longest accepted subject, and longest accepted single topic.
     *
     * Matches the study_plans_subject_bounded and study_plan_tasks_topic_bounded
     * CHECK constraints in migrations/postgres/004_study_plans.sql — the same
     * arrangement as materialFilenameLength: validation rejects an over-long
     * value with a message that says which field, and the constraint catches a
     * code path that skipped validation. Changing this alone makes the API
     * accept something the database then refuses with a 500.
     */
    maxTextChars: int("STUDYPAL_PLAN_MAX_TEXT_CHARS", 200),

    /**
     * The daily study budget the API will accept, in minutes (§10).
     *
     * The minimum exists because a plan is built by packing tasks into daily
     * budgets, and a budget below the shortest sensible study session produces
     * either zero tasks or a schedule of two-minute fragments. The maximum is
     * policy, not physics: the CHECK constraint's ceiling is 1440 because that
     * is how many minutes a day has, whereas 720 is a statement that twelve
     * hours of daily revision is past the point where more schedule helps.
     *
     * §10's examples land on either side of these on purpose: -100 and 0 fail
     * int()'s positivity check, 999999 fails this maximum.
     */
    minDailyMinutes: int("STUDYPAL_PLAN_MIN_DAILY_MINUTES", 10),
    maxDailyMinutes: int("STUDYPAL_PLAN_MAX_DAILY_MINUTES", 720),

    /**
     * Materials one plan may be grounded in. Each one costs an ownership check,
     * a retrieval round trip and a share of the context budget, so this bounds
     * the work a single POST can commission — not just the size of an array.
     */
    maxMaterials: int("STUDYPAL_PLAN_MAX_MATERIALS", 10),

    /**
     * How far ahead an exam date may be, in days (§10's "compatible with the
     * start date").
     *
     * Without a ceiling, an exam date in 2124 asks the scheduler to enumerate
     * every study date for a century — tens of thousands of dates, built and
     * sorted before a single task exists. A year is longer than any exam anyone
     * plans daily revision for, and the failure it prevents is quiet: the
     * request succeeds, slowly, and produces a plan with a five-figure gap in
     * the middle.
     */
    maxHorizonDays: int("STUDYPAL_PLAN_MAX_HORIZON_DAYS", 365),

    /**
     * Tasks one plan may contain (§51's "cap the number of tasks").
     *
     * Applied to the model's output, not to the request, and it is the reason a
     * plan cannot become an unbounded INSERT: the validator refuses a response
     * with more than this many tasks rather than trimming it, because a plan
     * that was designed as 400 tasks and persisted as its first 200 is a
     * different plan than the one the model reasoned about.
     */
    maxTasks: int("STUDYPAL_PLAN_MAX_TASKS", 200),

    /**
     * Characters of retrieved material context placed in one planning prompt.
     *
     * Half of config.rag.maxContextChars, and lower for a reason rather than by
     * accident. A chat answer is grounded in the passage it quotes, so more
     * context is more evidence; a study plan needs only enough of each material
     * to know what it covers, and the rest of the prompt — the learner's goals,
     * the instructions, the response schema — is what should be steering the
     * output. §14 is explicit that whole documents must never be sent, and this
     * is the number that makes that structural.
     */
    maxContextChars: int("STUDYPAL_PLAN_MAX_CONTEXT_CHARS", 6000),
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
    warnings.push(
      "GEMINI_API_KEY is not set — uploaded materials will be stored, extracted " +
        "and chunked, but not embedded, so they stay indexing_status=failed and " +
        "POST /api/materials/chat has nothing to retrieve.",
    );
  }

  if (config.rag.embeddingDimensions !== MIGRATED_EMBEDDING_DIMENSIONS) {
    warnings.push(
      `STUDYPAL_EMBEDDING_DIM=${config.rag.embeddingDimensions} but ` +
        `material_chunks.embedding was migrated as vector(${MIGRATED_EMBEDDING_DIMENSIONS}). ` +
        "Every embedding insert will fail until a migration widens the column, and " +
        "existing vectors are not comparable with the new ones — they need " +
        "re-generating, not padding.",
    );
  }

  if (config.rag.topK > config.rag.maxTopK) {
    warnings.push(
      `STUDYPAL_RAG_TOP_K=${config.rag.topK} exceeds STUDYPAL_RAG_MAX_TOP_K=` +
        `${config.rag.maxTopK}, so the default retrieval size is clamped to the ` +
        "maximum. Raise the maximum if the larger default is intended.",
    );
  }

  if (config.plan.minDailyMinutes > config.plan.maxDailyMinutes) {
    warnings.push(
      `STUDYPAL_PLAN_MIN_DAILY_MINUTES=${config.plan.minDailyMinutes} exceeds ` +
        `STUDYPAL_PLAN_MAX_DAILY_MINUTES=${config.plan.maxDailyMinutes}, so no ` +
        "value of dailyMinutes can satisfy both and POST /api/study-plans will " +
        "reject every request with a 400.",
    );
  }

  if (config.plan.maxDailyMinutes > PLAN_DB_MAX_DAILY_MINUTES) {
    warnings.push(
      `STUDYPAL_PLAN_MAX_DAILY_MINUTES=${config.plan.maxDailyMinutes} is above the ` +
        `study_plans_daily_minutes_bounded CHECK (${PLAN_DB_MAX_DAILY_MINUTES}, the ` +
        "number of minutes in a day). Validation would accept a value the database " +
        "then refuses, turning a 400 into a 500.",
    );
  }

  if (config.plan.maxTextChars > PLAN_DB_MAX_TEXT_CHARS) {
    warnings.push(
      `STUDYPAL_PLAN_MAX_TEXT_CHARS=${config.plan.maxTextChars} is above the ` +
        `study_plans_subject_bounded CHECK (${PLAN_DB_MAX_TEXT_CHARS}). An accepted ` +
        "subject or topic longer than that fails on INSERT, after Gemini has " +
        "already been called and paid for.",
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
