/**
 * What the server does with what the model returns — SP-V2-006 §7, §8, §13, §14.
 *
 * One file, one server per test — twenty-four of them, across the fake
 * provider's seventeen exam modes. tests/helpers/server-harness.mjs fixes a
 * child's environment at spawn, and FAKE_EXAM_MODE is read from the
 * environment, so a mode cannot be switched inside a running process. Each test
 * starts its own server and stops it in the same block. That is the reason this
 * file exists separately from tests/exams/api.test.js rather than a preference
 * about file size.
 *
 * WHAT IS BEING ASSERTED, IN ONE SENTENCE: §7's "do NOT trust Gemini merely
 * because it returned JSON" and §13's "never leave half-generated exams" are the
 * same claim from two directions, and every rejection case below checks both —
 * the status the learner sees, and that `exams` and `exam_questions` are still
 * empty afterwards.
 *
 * THE SECOND HALF IS THE POINT. A validator that refuses everything would pass
 * every rejection test in this file. So the accepting modes — `valid`,
 * `all-mcq`, `all-boolean`, `invent-source`, `long-text` and `retry-once` — are
 * here in the same describe blocks, asserting that well-formed output IS
 * persisted, that a paper of one type is not mistaken for a malformed one, that
 * merely verbose text is shortened rather than refused, and that a dropped
 * source reference costs the question rather than the exam.
 *
 * COUNTING WRITES, NOT JUST READING STATUS. §13's transaction is invisible from
 * a single response: a server that inserted an exam, failed on question four and
 * returned 500 looks identical to one that never opened a transaction. The
 * difference is in the table, which is why every case here queries it.
 *
 *   node --test tests/exams/generation.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";
import { CANNED_EXAM_TITLE } from "../helpers/fake-gemini.mjs";
import { fakeEmbedding } from "../fixtures/vectors.mjs";

/** Every rejection in this file reaches the learner as this exact 500 (§15). */
const GENERATION_FAILED = "AI exam generation failed";

/**
 * Run `body` against a server pinned to one FAKE_EXAM_MODE.
 *
 * The server and its database are created per call and torn down in `finally`,
 * so a failing assertion cannot leave a process behind — with seventeen of these
 * in one file, a leak would exhaust the connection limit rather than fail one
 * test.
 *
 * `probe` is everything a case needs: the HTTP surface, the database, and a
 * ready-made user.
 */
async function withMode(mode, body) {
  const server = await startServer({
    label: `exam-gen-${mode}`,
    env: { FAKE_EXAM_MODE: mode },
  });
  const pool = new pg.Pool({ connectionString: server.databaseUrl, max: 4 });

  try {
    const username = testUser(`gen-${mode}`);
    await pool.query("INSERT INTO users (username) VALUES ($1)", [username]);

    await body({
      server,
      pool,
      username,

      /** POST /api/exams with sensible defaults, overridable per case. */
      create: (overrides = {}) =>
        server.request("POST", "/api/exams", {
          json: {
            username,
            subject: "Biology",
            topics: ["Photosynthesis"],
            questionCount: 4,
            ...overrides,
          },
        }),

      /** How many exams and questions exist. §13's assertion, both tables. */
      async counts() {
        const { rows } = await pool.query(
          `SELECT (SELECT COUNT(*)::int FROM exams) AS exams,
                  (SELECT COUNT(*)::int FROM exam_questions) AS questions`,
        );
        return rows[0];
      },

      /** An indexed material, for the source-traceability cases. */
      async material(content = "Photosynthesis occurs in the chloroplast.") {
        const { rows } = await pool.query(
          `INSERT INTO materials
                  (user_id, original_filename, storage_key, mime_type, file_size,
                   status, indexing_status)
           VALUES ((SELECT id FROM users WHERE username = $1),
                   'source.pdf', $2, 'application/pdf', 2048, 'ready', 'indexed')
           RETURNING id`,
          [username, `exam-gen-${mode}-${Date.now()}.pdf`],
        );
        const materialId = rows[0].id;
        await pool.query(
          `INSERT INTO material_chunks
                  (material_id, chunk_index, content, char_count, embedding)
           VALUES ($1, 0, $2, char_length($2), $3::vector)`,
          [materialId, content, `[${fakeEmbedding(content).join(",")}]`],
        );
        return materialId;
      },
    });
  } finally {
    await pool.end();
    await server.stop();
  }
}

/**
 * A rejection: the documented 500, and an empty database after it.
 *
 * Both halves matter. The status alone would pass against a server that
 * persisted a broken exam and then threw; the counts alone would pass against
 * one that silently returned 200 with no exam.
 */
async function assertRejected(probe, note) {
  const res = await probe.create();

  assert.equal(res.status, 500, `${note}: expected 500, got ${res.status}: ${res.text}`);
  assert.equal(res.body?.error, GENERATION_FAILED, note);

  // §15: the refusal says what failed, not how. No provider name, no model, no
  // fragment of the response that was refused — which may contain the learner's
  // own document text.
  const json = JSON.stringify(res.body);
  assert.doesNotMatch(json, /gemini|google|generativelanguage/i, `${note}: provider`);
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, `${note}: stack`);
  assert.doesNotMatch(json, /photosynthesis/i, `${note}: echoed content`);

  assert.deepEqual(
    await probe.counts(),
    { exams: 0, questions: 0 },
    `${note}: §13 — nothing may be persisted for a refused generation`,
  );
}

/** An acceptance: 201, the requested number of questions, and rows to match. */
async function assertAccepted(probe, { questionCount = 4, ...overrides } = {}) {
  const res = await probe.create({ questionCount, ...overrides });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.text}`);
  assert.equal(res.body.questions.length, questionCount);
  assert.deepEqual(await probe.counts(), { exams: 1, questions: questionCount });
  return res.body;
}

// ── §7: it has to be JSON, and then it has to be an exam ────────────────────

describe("output that is not a usable exam is refused (§7)", () => {
  it("refuses prose", async () => {
    await withMode("prose", async (probe) => {
      await assertRejected(probe, "prose");
    });
  });

  it("refuses an exam with no questions", async () => {
    // Schema-valid JSON — `questions` is present and is an array. §7's point
    // exactly: the shape being right is not the same as the content being usable.
    await withMode("empty-questions", async (probe) => {
      await assertRejected(probe, "empty-questions");
    });
  });

  it("refuses an exam with no title", async () => {
    await withMode("no-title", async (probe) => {
      await assertRejected(probe, "no-title");
    });
  });

  it("refuses a question with no text", async () => {
    await withMode("empty-question-text", async (probe) => {
      await assertRejected(probe, "empty-question-text");
    });
  });

  it("refuses a question with no explanation", async () => {
    await withMode("no-explanation", async (probe) => {
      await assertRejected(probe, "no-explanation");
    });
  });
});

// ── §8: the question-quality rules ──────────────────────────────────────────

describe("question quality is validated before persistence (§8)", () => {
  it("refuses a paper one question short", async () => {
    // §8: "Question count must equal the requested count." Not trimmed to fit,
    // not accepted short — the learner asked for four.
    await withMode("too-few", async (probe) => {
      await assertRejected(probe, "too-few");
    });
  });

  it("refuses a paper one question long", async () => {
    await withMode("too-many", async (probe) => {
      await assertRejected(probe, "too-many");
    });
  });

  it("refuses a question type §2 does not allow", async () => {
    await withMode("bad-type", async (probe) => {
      await assertRejected(probe, "bad-type");
    });
  });

  it("refuses multiple choice with three options", async () => {
    await withMode("three-options", async (probe) => {
      await assertRejected(probe, "three-options");
    });
  });

  it("refuses multiple choice with a duplicated option id", async () => {
    // §8's "unique ids". A duplicate would make the answer ambiguous at exactly
    // the moment it matters — the grader compares one string to one key.
    await withMode("duplicate-options", async (probe) => {
      await assertRejected(probe, "duplicate-options");
    });
  });

  it("refuses a key that names an option the question does not have", async () => {
    // The most important rejection in the file. An exam whose key is "Z" when the
    // options are A-D is one nobody can pass, and every failure would look like
    // the learner's.
    await withMode("answer-not-an-option", async (probe) => {
      await assertRejected(probe, "answer-not-an-option");
    });
  });
});

// ── §8's other branch: well-formed output is persisted ──────────────────────

describe("well-formed output is accepted and persisted (§8, §13)", () => {
  it("accepts the default mixed paper and stores every question", async () => {
    await withMode("valid", async (probe) => {
      const exam = await assertAccepted(probe, { questionCount: 6 });

      assert.equal(exam.title, CANNED_EXAM_TITLE);
      assert.deepEqual(
        exam.questions.map((question) => question.order),
        [1, 2, 3, 4, 5, 6],
      );

      // The key was stored for all six, and no question was left keyless — the
      // column is NOT NULL, so this also proves the insert covered every row.
      const { rows } = await probe.pool.query(
        `SELECT COUNT(*)::int AS keyed FROM exam_questions
          WHERE correct_answer <> '' AND explanation IS NOT NULL`,
      );
      assert.equal(rows[0].keyed, 6);
    });
  });

  it("accepts an all-multiple-choice paper", async () => {
    // A paper of one type is not a malformed one. Without this, a validator that
    // required alternating types would pass every other test here.
    await withMode("all-mcq", async (probe) => {
      const exam = await assertAccepted(probe, {
        questionTypes: ["multiple_choice"],
      });
      for (const question of exam.questions) {
        assert.equal(question.type, "multiple_choice");
        assert.equal(question.options.length, 4);
      }
    });
  });

  it("accepts an all-true-false paper", async () => {
    await withMode("all-boolean", async (probe) => {
      const exam = await assertAccepted(probe, { questionTypes: ["true_false"] });
      for (const question of exam.questions) {
        assert.equal(question.type, "true_false");
        assert.deepEqual(
          question.options.map((option) => option.id),
          ["true", "false"],
        );
      }
    });
  });

  it("accepts a single-question exam", async () => {
    await withMode("valid", async (probe) => {
      await assertAccepted(probe, { questionCount: 1 });
    });
  });

  it("accepts the largest exam the configuration allows", async () => {
    // The count check is an equality, so the boundary is worth walking: 50 in,
    // 50 out, 50 rows.
    await withMode("valid", async (probe) => {
      const exam = await assertAccepted(probe, { questionCount: 50 });
      assert.equal(exam.questionCount, 50);
    });
  });

  it("clamps over-long text rather than refusing the exam", async () => {
    // A 600-character title and 5000-character questions. Verbose output is not
    // malformed output: the questions are answerable, and refusing the paper
    // would deny a learner an exam over formatting. So it is shortened to the
    // configured bounds — which are also the CHECK constraints' bounds, so the
    // INSERT that follows cannot fail on length.
    //
    // This is the one case in the file where the stored value differs from what
    // the model sent, which is why it asserts the lengths rather than only the
    // status.
    await withMode("long-text", async (probe) => {
      const exam = await assertAccepted(probe);

      assert.ok(
        exam.title.length <= 200,
        `title was ${exam.title.length} chars, over config.exam.maxTextChars`,
      );
      for (const question of exam.questions) {
        assert.ok(
          question.question.length <= 2000,
          `question was ${question.question.length} chars, over maxQuestionChars`,
        );
      }

      // And what reached the database is within the constraints, not merely
      // within them in the response.
      const { rows } = await probe.pool.query(
        `SELECT MAX(char_length(question_text))::int AS longest_question,
                MAX(char_length(explanation))::int AS longest_explanation
           FROM exam_questions`,
      );
      assert.ok(rows[0].longest_question <= 2000);
      assert.ok(rows[0].longest_explanation <= 2000);
    });
  });
});

// ── §14: a source reference the prompt never contained ──────────────────────

describe("invented source references are dropped, not persisted (§14)", () => {
  it("keeps the questions and forgets the citation", async () => {
    // §14 is traceability, and a reference to `[Source 99]` when the prompt held
    // one source traces to nothing. Dropping the whole exam would be the wrong
    // trade — the questions are usable, and a wrong provenance claim is worse
    // than none.
    await withMode("invent-source", async (probe) => {
      const materialId = await probe.material();
      const res = await probe.create({ materialIds: [materialId] });

      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.questions.length, 4);

      for (const question of res.body.questions) {
        assert.equal(
          question.sourceMaterialId,
          null,
          "an unresolvable reference must not become a material id",
        );
      }

      const { rows } = await probe.pool.query(
        `SELECT COUNT(*)::int AS traced FROM exam_questions
          WHERE source_material_id IS NOT NULL OR source_chunk_id IS NOT NULL`,
      );
      assert.equal(rows[0].traced, 0, "and must not be stored either");

      // The exam still records what it was generated from, which is a property
      // of the request rather than of the model's citation.
      assert.equal(res.body.sourceType, "material");
      assert.deepEqual(res.body.materialIds, [materialId]);
    });
  });

  it("resolves a real source reference to the material and the chunk", async () => {
    // The counterpart. Without it, "drops invented references" would also be
    // satisfied by a server that dropped all of them.
    await withMode("valid", async (probe) => {
      const materialId = await probe.material();
      const res = await probe.create({ materialIds: [materialId] });

      assert.equal(res.status, 201, res.text);
      for (const question of res.body.questions) {
        assert.equal(question.sourceMaterialId, materialId);
      }

      const { rows } = await probe.pool.query(
        `SELECT COUNT(*)::int AS traced FROM exam_questions
          WHERE source_material_id = $1 AND source_chunk_id IS NOT NULL`,
        [materialId],
      );
      assert.equal(rows[0].traced, 4, "§14: both halves of the trail");
    });
  });
});

// ── §8's retry ──────────────────────────────────────────────────────────────

describe("unusable output is retried once, and only once (§8, §13)", () => {
  it("recovers on the second attempt and writes exactly one exam", async () => {
    // `retry-once` refuses the first call and succeeds on the second. The
    // interesting assertion is not that the request succeeded — it is that one
    // exam exists rather than two. A generator that persisted before validating
    // would leave the first attempt behind.
    await withMode("retry-once", async (probe) => {
      const exam = await assertAccepted(probe);

      assert.equal(exam.title, CANNED_EXAM_TITLE);
      assert.equal(exam.status, "ready");

      const { rows } = await probe.pool.query(
        "SELECT COUNT(*)::int AS n FROM exams",
      );
      assert.equal(rows[0].n, 1, "§13: one exam, not one per attempt");
    });
  });

  it("gives up rather than retrying forever", async () => {
    // `prose` fails every call. What this asserts is that the request terminates
    // with the documented error at all — an unbounded retry would hang the
    // request until the harness's timeout instead.
    await withMode("prose", async (probe) => {
      const started = Date.now();
      await assertRejected(probe, "prose (bounded)");
      assert.ok(
        Date.now() - started < 15_000,
        "the retry bound must terminate the request",
      );
    });
  });
});

// ── §13: the transaction, seen from the table ───────────────────────────────

describe("a refused generation leaves nothing behind (§13)", () => {
  it("leaves no exam, no question and a usable server", async () => {
    // Several refusals in a row against one server: if a failed generation
    // leaked a transaction or a connection, the later requests would hang or
    // fail differently rather than returning the same clean 500.
    await withMode("too-few", async (probe) => {
      for (const questionCount of [2, 5, 9]) {
        const res = await probe.create({ questionCount });
        assert.equal(res.status, 500, res.text);
        assert.equal(res.body.error, GENERATION_FAILED);
      }

      assert.deepEqual(await probe.counts(), { exams: 0, questions: 0 });

      // And the connection pool is still healthy.
      const { rows } = await probe.pool.query("SELECT 1 AS ok");
      assert.equal(rows[0].ok, 1);
    });
  });

  it("does not consume the learner's material or leave an attempt", async () => {
    await withMode("answer-not-an-option", async (probe) => {
      const materialId = await probe.material();
      const res = await probe.create({ materialIds: [materialId] });
      assert.equal(res.status, 500, res.text);

      const { rows } = await probe.pool.query(
        `SELECT (SELECT COUNT(*)::int FROM exams) AS exams,
                (SELECT COUNT(*)::int FROM exam_attempts) AS attempts,
                (SELECT COUNT(*)::int FROM material_chunks
                  WHERE material_id = $1) AS chunks,
                (SELECT status FROM materials WHERE id = $1) AS material_status`,
        [materialId],
      );
      assert.deepEqual(rows[0], {
        exams: 0,
        attempts: 0,
        chunks: 1,
        material_status: "ready",
      });
    });
  });

  it("stays available for a later, well-formed generation", async () => {
    // The most practical version of §13: a learner whose first generation was
    // refused can try again. Run on `retry-once`, whose first call fails and
    // whose second succeeds, so one server shows both outcomes in sequence.
    await withMode("retry-once", async (probe) => {
      const first = await probe.create();
      assert.equal(first.status, 201, first.text);

      const second = await probe.create({ questionCount: 2 });
      assert.equal(second.status, 201, second.text);
      assert.equal(second.body.questions.length, 2);

      assert.deepEqual(await probe.counts(), { exams: 2, questions: 6 });
    });
  });
});
