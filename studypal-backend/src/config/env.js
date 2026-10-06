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

/**
 * The same, for SP-V2-006's exam tables.
 *
 * EXAM_DB_MAX_QUESTION_COUNT is exams_question_count_bounded,
 * EXAM_DB_MAX_TEXT_CHARS is exams_subject_bounded and exams_title_bounded, and
 * EXAM_DB_MAX_QUESTION_CHARS is exam_questions_text_bounded and
 * exam_questions_explanation_bounded — all in
 * migrations/postgres/005_exams.sql. A configuration above any of them means an
 * exam that validates, costs a Gemini call, and then fails on INSERT.
 */
const EXAM_DB_MAX_QUESTION_COUNT = 100;
const EXAM_DB_MAX_TEXT_CHARS = 200;
const EXAM_DB_MAX_QUESTION_CHARS = 2000;

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

  /**
   * AI-generated exams (SP-V2-006).
   *
   * Same arrangement as `plan` above, and for the same reason §10 gives about
   * the pass threshold: "do not hardcode the threshold in multiple places".
   * Every number the exam path uses to accept, refuse or grade lives here, so
   * the grader, the validator and the tests all read one value.
   *
   * Retrieval settings are absent for the reason they are absent from `plan`: a
   * material-grounded exam uses config.rag.topK and config.rag.similarityThreshold
   * unchanged, because §14 is explicit that this feature must reuse SP-V2-004's
   * retrieval rather than grow a second vector search.
   */
  exam: Object.freeze({
    /**
     * The percentage at or above which an attempt passes (§10).
     *
     * The single source of truth for pass/fail. src/exams/grader.js is the only
     * module that reads it, every other layer reads the `passed` boolean the
     * grader computed, and the value is stored on the attempt row — so changing
     * this changes what FUTURE attempts mean and leaves past results as they
     * were graded, which is the honest behaviour for a stored result.
     *
     * At-or-above, not above: 70 with a threshold of 70 passes.
     */
    passingPercentage: int("STUDYPAL_EXAM_PASSING_PERCENTAGE", 70),

    /**
     * Questions one exam may be asked to contain (§2's "configurable question
     * count").
     *
     * The minimum is 1 because a zero-question exam is not an exam and the
     * exams_question_count_positive CHECK refuses it anyway. The maximum bounds
     * the work one POST commissions: every question is output tokens the model
     * must generate in a single response, and a 500-question request is a way to
     * make one HTTP call cost a lot of money and then time out. It also matches
     * the exams_question_count_bounded CHECK, so validation refuses with a 400
     * what the database would otherwise refuse with a 500.
     */
    minQuestions: int("STUDYPAL_EXAM_MIN_QUESTIONS", 1),
    maxQuestions: int("STUDYPAL_EXAM_MAX_QUESTIONS", 50),

    /** Questions generated when a request does not say. */
    defaultQuestionCount: int("STUDYPAL_EXAM_DEFAULT_QUESTIONS", 10),

    /**
     * Topics one request may name. Same reasoning as plan.maxTopics: each topic
     * is a line in the prompt the model must cover.
     */
    maxTopics: int("STUDYPAL_EXAM_MAX_TOPICS", 20),

    /**
     * Longest accepted subject, and longest accepted single topic.
     *
     * Matches the exams_subject_bounded and exams_title_bounded CHECK
     * constraints in migrations/postgres/005_exams.sql. Raising this alone makes
     * the API accept something the database then refuses — after Gemini has been
     * called and paid for.
     */
    maxTextChars: int("STUDYPAL_EXAM_MAX_TEXT_CHARS", 200),

    /**
     * Longest accepted question text and explanation from the model.
     *
     * Applied to the RESPONSE, not the request, and it matches the
     * exam_questions_text_bounded and exam_questions_explanation_bounded CHECKs.
     * The validator refuses an over-long question rather than truncating it: a
     * question cut off mid-sentence is unanswerable, and persisting one would
     * mean a graded exam nobody can sit.
     */
    maxQuestionChars: int("STUDYPAL_EXAM_MAX_QUESTION_CHARS", 2000),

    /**
     * Materials one exam may be grounded in. Each costs an ownership check, a
     * retrieval round trip and a share of the context budget.
     */
    maxMaterials: int("STUDYPAL_EXAM_MAX_MATERIALS", 10),

    /**
     * Characters of retrieved material context placed in one generation prompt.
     *
     * The same 6000 as the study-plan budget and for the same reason: the
     * remainder of the prompt — the requested topics, the question-type rules,
     * the response schema — is what should be steering the output, and whole
     * documents must never be sent.
     */
    maxContextChars: int("STUDYPAL_EXAM_MAX_CONTEXT_CHARS", 6000),

    /**
     * Extra generation attempts when the model's response is unusable (§8).
     *
     * SP-V2-005 fixed this at one retry in a module constant; §8 asks for the
     * exam equivalent to be a choice ("either retry using the existing AI retry
     * abstraction or return a controlled error — never persist an incomplete
     * exam"), so it is configurable here and defaults to the same behaviour: two
     * attempts in total.
     *
     * It covers every way a SUCCESSFUL call can produce content the validator
     * refuses — malformed structure, an unsupported type, an invalid
     * correctAnswer, and §8's wrong question count. All of them are sampling
     * outcomes that a second call often fixes.
     *
     * It does NOT cover a provider FAILURE. A 503, a timeout or an auth
     * rejection will be the same the second time, and retrying turns one outage
     * into two calls per request; src/exams/exam-generator.js therefore throws
     * on the first provider error, exactly as the study-plan generator does.
     * Setting this to a large number cannot cause a retry storm against a failing
     * provider — only against a model that keeps answering badly.
     */
    generationRetries: int("STUDYPAL_EXAM_GENERATION_RETRIES", 1),
  }),

  /**
   * SP-V2-007 — learning analytics.
   *
   * §9 asks for "named constants" for the weak-area rule. They live here rather
   * than in the module for the reason §10 of SP-V2-006 gives about the pass
   * threshold: a number that decides an outcome should have exactly one
   * definition, and a deployment should be able to move it without a code
   * change. src/analytics/analytics.metrics.js is the only module that reads
   * these; every other layer consumes what it returns.
   *
   * NOTHING HERE CHANGES STORED DATA. Analytics is read-only (§CRITICAL
   * ARCHITECTURAL RULE), so lowering the weak-area threshold reclassifies what
   * the next request reports and rewrites nothing — unlike
   * `exam.passingPercentage`, whose effect is frozen into each attempt row at
   * submission. That asymmetry is why these can be tuned freely and that one
   * cannot.
   */
  analytics: Object.freeze({
    /**
     * §9's evidence floor: the fewest answered questions a topic needs before
     * it may be called weak.
     *
     * Three is the specified default, and the reason to have a floor at all is
     * that accuracy over one or two questions is noise — a single unlucky
     * guess would otherwise brand a topic at 0%. Raising this makes the
     * weak-area list shorter and better evidenced; lowering it to 1 would make
     * every missed question a weakness.
     */
    minTopicAttempts: Math.max(3, int("STUDYPAL_ANALYTICS_MIN_TOPIC_ATTEMPTS", 3)),

    /**
     * §9's accuracy threshold, as a percentage.
     *
     * STRICTLY below this counts as weak: 59.99 is weak, exactly 60 is not.
     * The comparison is `<` in one place (src/analytics/analytics.metrics.js)
     * and §22's test matrix pins all three sides of it.
     */
    weakTopicAccuracyThreshold: Math.max(0, Math.min(100, int(
      "STUDYPAL_ANALYTICS_WEAK_ACCURACY_THRESHOLD",
      60,
    ))),

    /**
     * §5's history size, and the ceiling a client may ask for.
     *
     * `historyLimit` is what an unqualified request returns; `maxHistoryLimit`
     * is the clamp on `?limit=`. §5 is explicit that the limit must not be
     * unbounded and client-controlled: a validated, clamped parameter is the
     * middle position between ignoring the client and letting one request ask
     * for every attempt a user has ever made.
     */
    historyLimit: Math.max(1, Math.min(50, int("STUDYPAL_ANALYTICS_HISTORY_LIMIT", 10))),
    maxHistoryLimit: Math.max(1, Math.min(50, int("STUDYPAL_ANALYTICS_MAX_HISTORY_LIMIT", 50))),

    /**
     * §6's trend windows, in completed attempts.
     *
     * `trendWindow` is the largest window compared; `minTrendWindow` is the
     * smallest window that may be compared at all. Two, not one, because §6
     * says "do not infer a trend from one attempt" — so a user needs at least
     * four completed attempts before a direction is reported.
     *
     * The windows are always EQUAL in size (see compareRecentPerformance): the
     * implementation shrinks both rather than comparing a five-attempt average
     * against a one-attempt average, which would be arithmetic dressed up as a
     * comparison.
     */
    trendWindow: Math.max(2, Math.min(50, int("STUDYPAL_ANALYTICS_TREND_WINDOW", 5))),
    minTrendWindow: Math.max(2, int("STUDYPAL_ANALYTICS_MIN_TREND_WINDOW", 2)),

    /**
     * Rows returned by the topic and material breakdowns.
     *
     * A bound rather than a page, because these are aggregates over one user's
     * own history and the realistic count is tens. It exists so a user with an
     * unusual amount of data cannot make one request build an unbounded
     * response, not because pagination is expected.
     */
    breakdownLimit: int("STUDYPAL_ANALYTICS_BREAKDOWN_LIMIT", 100),
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

  if (config.exam.passingPercentage > 100) {
    warnings.push(
      `STUDYPAL_EXAM_PASSING_PERCENTAGE=${config.exam.passingPercentage} is above 100, ` +
        "so no attempt can ever pass — every result will be `passed: false` " +
        "regardless of score.",
    );
  }

  if (config.exam.minQuestions > config.exam.maxQuestions) {
    warnings.push(
      `STUDYPAL_EXAM_MIN_QUESTIONS=${config.exam.minQuestions} exceeds ` +
        `STUDYPAL_EXAM_MAX_QUESTIONS=${config.exam.maxQuestions}, so no question ` +
        "count can satisfy both and POST /api/exams will reject every request " +
        "with a 400.",
    );
  }

  if (
    config.exam.defaultQuestionCount < config.exam.minQuestions ||
    config.exam.defaultQuestionCount > config.exam.maxQuestions
  ) {
    warnings.push(
      `STUDYPAL_EXAM_DEFAULT_QUESTIONS=${config.exam.defaultQuestionCount} is outside ` +
        `the accepted range ${config.exam.minQuestions}-${config.exam.maxQuestions}, so a ` +
        "request that omits questionCount is rejected by the validator that " +
        "supplied the default.",
    );
  }

  if (config.exam.maxQuestions > EXAM_DB_MAX_QUESTION_COUNT) {
    warnings.push(
      `STUDYPAL_EXAM_MAX_QUESTIONS=${config.exam.maxQuestions} is above the ` +
        `exams_question_count_bounded CHECK (${EXAM_DB_MAX_QUESTION_COUNT}). An accepted ` +
        "request fails on INSERT, after Gemini has already been called and paid for.",
    );
  }

  if (config.exam.maxTextChars > EXAM_DB_MAX_TEXT_CHARS) {
    warnings.push(
      `STUDYPAL_EXAM_MAX_TEXT_CHARS=${config.exam.maxTextChars} is above the ` +
        `exams_subject_bounded CHECK (${EXAM_DB_MAX_TEXT_CHARS}). An accepted subject ` +
        "or topic fails on INSERT, after the generation has been paid for.",
    );
  }

  if (config.exam.maxQuestionChars > EXAM_DB_MAX_QUESTION_CHARS) {
    warnings.push(
      `STUDYPAL_EXAM_MAX_QUESTION_CHARS=${config.exam.maxQuestionChars} is above the ` +
        `exam_questions_text_bounded CHECK (${EXAM_DB_MAX_QUESTION_CHARS}). A question ` +
        "the validator accepts fails on INSERT, rolling back the whole exam.",
    );
  }

  // ── SP-V2-007 analytics ──
  //
  // None of these can corrupt stored data — analytics only reads — so each
  // warns about a REPORT that would be misleading rather than about a write
  // that would fail.

  if (config.analytics.minTopicAttempts < 1) {
    warnings.push(
      `STUDYPAL_ANALYTICS_MIN_TOPIC_ATTEMPTS=${config.analytics.minTopicAttempts} is ` +
        "below 1, so a topic with no answered questions would qualify as weak. " +
        "SP-V2-007 §9 requires an evidence floor of at least one attempt.",
    );
  }

  if (
    config.analytics.weakTopicAccuracyThreshold < 0 ||
    config.analytics.weakTopicAccuracyThreshold > 100
  ) {
    warnings.push(
      `STUDYPAL_ANALYTICS_WEAK_ACCURACY_THRESHOLD=${config.analytics.weakTopicAccuracyThreshold} ` +
        "is outside 0-100. Accuracy is a percentage, so a threshold outside that " +
        "range makes every topic weak or none of them.",
    );
  }

  if (config.analytics.historyLimit > config.analytics.maxHistoryLimit) {
    warnings.push(
      `STUDYPAL_ANALYTICS_HISTORY_LIMIT=${config.analytics.historyLimit} exceeds ` +
        `STUDYPAL_ANALYTICS_MAX_HISTORY_LIMIT=${config.analytics.maxHistoryLimit}, so the ` +
        "default history is larger than the largest value a client may ask for.",
    );
  }

  if (config.analytics.minTrendWindow < 2) {
    warnings.push(
      `STUDYPAL_ANALYTICS_MIN_TREND_WINDOW=${config.analytics.minTrendWindow} is below 2. ` +
        "SP-V2-007 §6 is explicit that a trend must not be inferred from one attempt.",
    );
  }

  if (config.analytics.trendWindow < config.analytics.minTrendWindow) {
    warnings.push(
      `STUDYPAL_ANALYTICS_TREND_WINDOW=${config.analytics.trendWindow} is below ` +
        `STUDYPAL_ANALYTICS_MIN_TREND_WINDOW=${config.analytics.minTrendWindow}, so no window ` +
        "size satisfies both and a trend can never be reported.",
    );
  }

  if (config.cors.allowAll) {    warnings.push(
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
