/**
 * Schema constraint tests.
 *
 * The migration tests assert that the schema gets created; these assert that it
 * is worth creating. Every constraint here is a rule the SQLite schema did not
 * enforce, so each test is the difference between the old database and the new
 * one — a blank username, an orphaned question, a `has_file` that disagrees with
 * its filename, an `answer` that is a JSON string rather than an object. All of
 * those were storable before.
 *
 * These go through SQL directly rather than the HTTP API on purpose: the point is
 * that the DATABASE refuses them, so a future code path that skips the request
 * validator still cannot write an unusable row. The API-level behaviour is
 * covered by tests/baseline/contract.test.js.
 *
 * Real PostgreSQL, one private database for the suite.
 *
 *   node --test tests/schema.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createIsolatedDatabase } from "./helpers/test-database.mjs";

const { Pool } = pg;

let database;
let pool;

before(async () => {
  // Already migrated by the helper, which is what this suite wants to inspect.
  database = await createIsolatedDatabase({ label: "schema" });
  pool = new Pool({ connectionString: database.url, max: 4 });
});

after(async () => {
  await pool?.end();
  await database?.drop();
});

/** Insert a user and return its id. */
async function makeUser(username) {
  const { rows } = await pool.query(
    "INSERT INTO users (username) VALUES ($1) RETURNING id",
    [username],
  );
  return rows[0].id;
}

/** A minimal valid answer object, as the model produces. */
const ANSWER = {
  explanation: "text",
  topic: "Biology",
  practice_questions: [],
  encouragement: "Keep going!",
};

/** Insert a question, overriding any column. Returns the pg result or throws. */
function insertQuestion(overrides = {}) {
  const row = {
    question: "a question",
    answer: JSON.stringify(ANSWER),
    topic: "Biology",
    has_file: false,
    filename: null,
    ...overrides,
  };
  return pool.query(
    `INSERT INTO questions (user_id, question, answer, topic, has_file, filename)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
    [row.user_id, row.question, row.answer, row.topic, row.has_file, row.filename],
  );
}

/**
 * Assert that a write fails with a named constraint.
 *
 * Matching the constraint NAME rather than the message text is what makes these
 * tests about the schema: renaming a constraint should fail here, and a reworded
 * PostgreSQL error should not.
 */
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

// ── users ──────────────────────────────────────────────────────────────────
describe("users", () => {
  it("rejects a duplicate username", async () => {
    const username = `dup_${Date.now()}`;
    await makeUser(username);
    await assertViolates("users_username_key", () => makeUser(username));
  });

  it("treats usernames as case- and whitespace-sensitive", async () => {
    // Not an endorsement — it documents that UNIQUE(username) is a byte
    // comparison, so "Ada" and "ada" are two accounts. The API relies on this
    // (it upserts on the raw value); a future case-insensitive login needs a
    // migration, not a code change.
    const base = `case_${Date.now()}`;
    await makeUser(base);
    await makeUser(base.toUpperCase());
    await makeUser(`${base} `);

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM users WHERE lower(btrim(username)) = lower($1)",
      [base],
    );
    assert.equal(rows[0].c, 3);
  });

  it("rejects a blank or whitespace-only username", async () => {
    // The tab and newline cases are the ones that matter: bare btrim() strips
    // SPACES ONLY, so the first version of this constraint accepted E'\t' as a
    // non-blank username. The migration now names the character set explicitly.
    for (const bad of ["", "   ", "\t", "\n", "\t\n", " \r\n\v\f "]) {
      await assertViolates("users_username_not_blank", () => makeUser(bad));
    }
  });

  it("accepts a username that is only letters from the whitespace escapes", async () => {
    // The trim set is written with E'' escapes, and E'' has no \v — spelling it
    // that way silently put a literal "v" in the set, so the username "v" was
    // rejected as blank. These are the letters near that mistake.
    for (const good of ["v", "n", "t", "r", "f", "vvv", "nrf"]) {
      await assert.doesNotReject(
        () => makeUser(`${good}_${Date.now()}_${Math.random()}`),
        `"${good}" is an ordinary username`,
      );
      await assert.doesNotReject(
        () => makeUser(good + Date.now()),
        `"${good}" must not be treated as whitespace`,
      );
    }
  });

  it("rejects a NULL username", async () => {
    await assert.rejects(
      () => pool.query("INSERT INTO users (username) VALUES (NULL)"),
      /null value in column "username"/,
    );
  });

  it("allows many NULL emails but only one of any given address", async () => {
    // Nullable-unique. Two users with no email must be fine; two with the same
    // address must not, or a future login-by-email finds duplicates already
    // committed.
    await makeUser(`nomail_a_${Date.now()}`);
    await makeUser(`nomail_b_${Date.now()}`);

    const email = `ada_${Date.now()}@example.test`;
    await pool.query("INSERT INTO users (username, email) VALUES ($1, $2)", [
      `mail_a_${Date.now()}`,
      email,
    ]);
    await assertViolates("users_email_key", () =>
      pool.query("INSERT INTO users (username, email) VALUES ($1, $2)", [
        `mail_b_${Date.now()}`,
        email,
      ]),
    );
  });

  it("refuses an id supplied by the client (GENERATED ALWAYS)", async () => {
    // ALWAYS, not BY DEFAULT: an INSERT that sets its own id would leave the
    // sequence behind the table and the next generated id would collide.
    await assert.rejects(
      () =>
        pool.query("INSERT INTO users (id, username) VALUES (9999, $1)", [
          `forced_${Date.now()}`,
        ]),
      /cannot insert a non-DEFAULT value into column "id"/,
    );
  });

  it("defaults created_at and updated_at to now()", async () => {
    const { rows } = await pool.query(
      "INSERT INTO users (username) VALUES ($1) RETURNING created_at, updated_at",
      [`stamped_${Date.now()}`],
    );
    const { created_at: createdAt, updated_at: updatedAt } = rows[0];
    // The ISO round-trip the API contract depends on, asserted at the source.
    assert.equal(new Date(createdAt).toISOString(), createdAt);
    assert.equal(new Date(updatedAt).toISOString(), updatedAt);
    assert.ok(Math.abs(Date.now() - Date.parse(createdAt)) < 60_000);
  });
});

// ── questions: the foreign key ─────────────────────────────────────────────
describe("questions.user_id", () => {
  it("rejects a question for a user that does not exist", async () => {
    // The whole reason the column is user_id and not username: the old schema
    // happily stored history for a user with no row.
    await assertViolates("questions_user_id_fkey", () =>
      insertQuestion({ user_id: 987_654_321 }),
    );
  });

  it("rejects a NULL user_id", async () => {
    await assert.rejects(
      () => insertQuestion({ user_id: null }),
      /null value in column "user_id"/,
    );
  });

  it("deletes a user's questions with the user (ON DELETE CASCADE)", async () => {
    const userId = await makeUser(`cascade_${Date.now()}`);
    await insertQuestion({ user_id: userId });
    await insertQuestion({ user_id: userId });

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM questions WHERE user_id = $1",
      [userId],
    );
    assert.equal(rows[0].c, 0, "the questions must go with the user");
  });

  it("refuses to delete a user when the questions would be orphaned", async () => {
    // Sanity check on the CASCADE above: with RESTRICT semantics this would
    // throw. It passing is what proves the delete above was a cascade rather
    // than a table that happened to be empty.
    const userId = await makeUser(`keep_${Date.now()}`);
    const { rows } = await insertQuestion({ user_id: userId });
    assert.ok(rows[0].id);
    await assert.doesNotReject(() =>
      pool.query("DELETE FROM users WHERE id = $1", [userId]),
    );
  });
});

// ── questions: CHECK constraints ───────────────────────────────────────────
describe("questions CHECK constraints", () => {
  let userId;
  before(async () => {
    userId = await makeUser(`checks_${Date.now()}`);
  });

  it("rejects a blank question", async () => {
    for (const bad of ["", "   ", "\t", "\n", " \r\n\v\f "]) {
      await assertViolates("questions_question_not_blank", () =>
        insertQuestion({ user_id: userId, question: bad }),
      );
    }
  });

  it("rejects an answer that is not a JSON object", async () => {
    // The double-encoding bug this constraint exists to catch: passing an
    // already-stringified JSON string as jsonb stores a JSON *string*, and every
    // reader then gets text where it expected an object.
    const notObjects = [
      JSON.stringify(JSON.stringify(ANSWER)), // double-encoded
      JSON.stringify("just a string"),
      JSON.stringify([ANSWER]),
      JSON.stringify(42),
      JSON.stringify(null),
    ];
    for (const answer of notObjects) {
      await assertViolates("questions_answer_is_object", () =>
        insertQuestion({ user_id: userId, answer }),
      );
    }
  });

  it("accepts an answer object and returns it parsed, not as text", async () => {
    const { rows: inserted } = await insertQuestion({ user_id: userId });
    const { rows } = await pool.query(
      "SELECT answer FROM questions WHERE id = $1",
      [inserted[0].id],
    );
    assert.deepEqual(
      rows[0].answer,
      ANSWER,
      "JSONB must come back as an object — no JSON.parse anywhere above this",
    );
  });

  it("rejects has_file=true with no filename", async () => {
    await assertViolates("questions_filename_matches_has_file", () =>
      insertQuestion({ user_id: userId, has_file: true, filename: null }),
    );
  });

  it("rejects a filename with has_file=false", async () => {
    await assertViolates("questions_filename_matches_has_file", () =>
      insertQuestion({ user_id: userId, has_file: false, filename: "notes.txt" }),
    );
  });

  it("accepts the two states that agree", async () => {
    await assert.doesNotReject(() =>
      insertQuestion({ user_id: userId, has_file: true, filename: "notes.txt" }),
    );
    await assert.doesNotReject(() =>
      insertQuestion({ user_id: userId, has_file: false, filename: null }),
    );
  });

  it("defaults topic and has_file so a minimal insert is still valid", async () => {
    const { rows } = await pool.query(
      `INSERT INTO questions (user_id, question, answer)
       VALUES ($1, 'minimal', $2::jsonb)
       RETURNING topic, has_file, filename, created_at`,
      [userId, JSON.stringify(ANSWER)],
    );
    assert.equal(rows[0].topic, "Study Topic");
    assert.equal(rows[0].has_file, false, "has_file must be a boolean, not 0/1");
    assert.equal(rows[0].filename, null);
    assert.equal(new Date(rows[0].created_at).toISOString(), rows[0].created_at);
  });

  it("rejects a NULL question or answer", async () => {
    await assert.rejects(
      () => insertQuestion({ user_id: userId, question: null }),
      /null value in column "question"/,
    );
    await assert.rejects(
      () => insertQuestion({ user_id: userId, answer: null }),
      /null value in column "answer"/,
    );
  });
});

// ── the objects the queries depend on ──────────────────────────────────────
describe("indexes", () => {
  it("has the two documented indexes and no others on questions", async () => {
    // Each index costs write throughput, so the spec asks for a justification per
    // index. This asserts the list, which means adding one without a reason
    // breaks a test and prompts the comment in the migration.
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'questions'
        ORDER BY indexname`,
    );
    assert.deepEqual(
      rows.map((r) => r.indexname),
      ["idx_questions_user_created", "idx_questions_user_topic", "questions_pkey"],
    );
  });

  it("uses the composite index for the history query at realistic scale", async () => {
    // The A9 index SP-V2-001 deferred. Asserting the PLAN rather than the index's
    // existence is what shows it is reachable by the query the app actually runs:
    // an index PostgreSQL declines to use is the same as no index.
    //
    // Scale matters, and is the whole reason for generate_series here rather than
    // a loop of inserts. On a table of 50 rows a sequential scan IS the cheaper
    // plan and the planner is right to choose it, so a small fixture would test
    // the planner's cost model rather than the index. A few thousand rows across
    // several users puts the query in the regime the index exists for.
    await pool.query(
      `INSERT INTO users (username)
       SELECT 'plan_user_' || g FROM generate_series(1, 40) AS g`,
    );
    await pool.query(
      `INSERT INTO questions (user_id, question, answer, topic, created_at)
       SELECT u.id,
              'q' || g,
              $1::jsonb,
              'Topic ' || (g % 7),
              now() - (g || ' minutes')::interval
         FROM users u
         CROSS JOIN generate_series(1, 100) AS g
        WHERE u.username LIKE 'plan_user_%'`,
      [JSON.stringify(ANSWER)],
    );
    // Without fresh statistics the planner is choosing from stale row estimates,
    // which is a different thing from choosing badly.
    await pool.query("ANALYZE questions");

    const { rows: target } = await pool.query(
      "SELECT id FROM users WHERE username = 'plan_user_1'",
    );
    const { rows } = await pool.query(
      `EXPLAIN SELECT id, question, answer, topic, has_file, filename, created_at
         FROM questions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 30`,
      [target[0].id],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");

    assert.match(
      plan,
      /idx_questions_user_created/,
      `the history query must use the composite index; plan was:\n${plan}`,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on questions/,
      `a sequential scan means the index is not being used; plan was:\n${plan}`,
    );
  });

  it("uses an index for the progress topic breakdown", async () => {
    // Depends on the rows inserted by the test above, which is why it follows it.
    const { rows: target } = await pool.query(
      "SELECT id FROM users WHERE username = 'plan_user_2'",
    );
    const { rows } = await pool.query(
      `EXPLAIN SELECT topic, COUNT(*) AS count
         FROM questions
        WHERE user_id = $1
        GROUP BY topic
        ORDER BY count DESC, topic ASC
        LIMIT 6`,
      [target[0].id],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    // A bitmap index scan counts: the user's rows are found through the index
    // rather than by reading the table. Which of the two index-scan strategies
    // PostgreSQL picks depends on how clustered the rows are, and pinning that
    // would be asserting the planner's internals rather than our schema.
    assert.match(
      plan,
      /Index Scan using idx_questions_user_|Index Only Scan using idx_questions_user_|Bitmap Index Scan on idx_questions_user_/,
      `the progress query must reach its rows through an index; plan was:\n${plan}`,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on questions/,
      `a sequential scan means neither index helped; plan was:\n${plan}`,
    );
  });
});

// ── nothing speculative ────────────────────────────────────────────────────
describe("scope", () => {
  it("creates only the tables this iteration needs", async () => {
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    assert.deepEqual(
      rows.map((r) => r.tablename),
      ["questions", "schema_migrations", "users"],
      "SP-V2-002 is the data foundation only — no V2 feature tables yet",
    );
  });

  it("has not created the tables reserved for later tickets", async () => {
    // Named explicitly so a premature `CREATE TABLE materials` fails here rather
    // than shipping an empty table nothing reads.
    const reserved = [
      "materials",
      "material_chunks",
      "study_plans",
      "study_plan_tasks",
      "exams",
      "exam_questions",
      "exam_attempts",
      "attempt_answers",
      "learning_events",
      "sessions", // replaced by `users`
    ];
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
      [reserved],
    );
    assert.deepEqual(rows, []);
  });

  it("has no SQLite remnant and no extension beyond the default", async () => {
    const { rows } = await pool.query(
      "SELECT extname FROM pg_extension ORDER BY extname",
    );
    assert.deepEqual(
      rows.map((r) => r.extname),
      ["plpgsql"],
      "no pgvector yet — that belongs to a later ticket",
    );
  });
});
