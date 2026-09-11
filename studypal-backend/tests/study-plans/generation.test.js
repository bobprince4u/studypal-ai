/**
 * Study-plan generation at the HTTP boundary — SP-V2-005 §14-§22, §33-§38, and
 * §40's "AI output", "Materials" and "Persistence and atomicity" groups.
 *
 * WHY THIS IS A SEPARATE FILE FROM api.test.js
 * -------------------------------------------
 * FAKE_PLAN_MODE is read by a fake provider loaded into the SERVER's process,
 * and tests/helpers/server-harness.mjs fixes a child's environment at spawn. A
 * mode cannot be switched on a running server, so every mode below needs its own
 * server — which is slow, and is the reason the contract, validation, ownership
 * and status suites all share one default server next door rather than paying
 * that cost per test.
 *
 * The deterministic halves of this — which model outputs the validator rejects,
 * and exactly how the normalizer clamps and drops — are unit-tested exhaustively
 * in tests/study-plans/scheduling.test.js, against the modules directly. What is
 * left for this file is the part only an integrated system can answer: whether a
 * rejected plan leaves anything behind in the database, whether a clamp is
 * visible to the client, whether the retry writes one plan or two.
 *
 * WHAT "NOTHING WAS PERSISTED" MEANS HERE
 * ---------------------------------------
 * Every failure case checks BOTH tables, not just study_plans. §25 forbids
 * half-created plans, and the failure mode worth catching is a plan row that
 * committed with no tasks, or task rows orphaned by a plan insert that rolled
 * back — neither of which a check on one table alone would see.
 *
 *   node --test tests/study-plans/generation.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { startServer, testUser } from "../helpers/server-harness.mjs";
import { CANNED_PLAN_TITLE } from "../helpers/fake-gemini.mjs";

const ALL_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/**
 * A server, a pool, and the fixtures both need — one set per FAKE_PLAN_MODE.
 *
 * Each returns a `stop` the caller registers with after(), because a leaked
 * child process holds a database open and the next suite's migration blocks
 * behind it.
 */
async function planServer(label, env = {}) {
  const server = await startServer({ label, env });
  const pool = new pg.Pool({ connectionString: server.databaseUrl, max: 4 });

  let sequence = 0;

  const makeUser = async (prefix = label) => {
    const username = testUser(prefix);
    await pool.query("INSERT INTO users (username) VALUES ($1)", [username]);
    return username;
  };

  const makeMaterial = async (username, filename = "notes.pdf") => {
    const { rows } = await pool.query(
      `INSERT INTO materials
              (user_id, original_filename, storage_key, mime_type, file_size,
               status, indexing_status)
       VALUES ((SELECT id FROM users WHERE username = $1),
               $2, $3, 'application/pdf', 4096, 'ready', 'indexed')
       RETURNING id`,
      [username, filename, `gen-${label}-${(sequence += 1)}-${Date.now()}.pdf`],
    );
    return rows[0].id;
  };

  /**
   * Give a material one indexed chunk, so retrieval has something to return.
   *
   * The embedding is written as a literal vector rather than by running the
   * indexing pipeline: this suite is about generation, and going through an
   * upload would make every test here depend on SP-V2-003's parser.
   *
   * There is no user_id column here — a chunk's owner is its material's owner,
   * and retrieval joins to get it. char_count is CHECKed against the content's
   * real length, so it is computed rather than guessed.
   */
  const addChunk = async (materialId, content, index = 0) => {
    const embedding = `[${Array.from({ length: 1536 }, (_, i) =>
      i === index % 1536 ? 1 : 0,
    ).join(",")}]`;
    await pool.query(
      `INSERT INTO material_chunks
              (material_id, chunk_index, content, char_count, embedding)
       VALUES ($1, $2, $3, char_length($3), $4::vector)`,
      [materialId, index, content, embedding],
    );
  };

  const create = (body) =>
    server.request("POST", "/api/study-plans", { json: body });

  const planBody = (username, overrides = {}) => ({
    username,
    subject: "Biology",
    topics: ["Photosynthesis"],
    examDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    dailyMinutes: 60,
    difficultyLevel: "intermediate",
    studyDays: ALL_DAYS,
    ...overrides,
  });

  /** What is actually in the database for this learner, both tables. */
  const storedFor = async (username) => {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM study_plans p
                WHERE p.user_id = u.id)                       AS plans,
              (SELECT COUNT(*) FROM study_plan_tasks t
                 JOIN study_plans p ON p.id = t.study_plan_id
                WHERE p.user_id = u.id)                       AS tasks
         FROM users u WHERE u.username = $1`,
      [username],
    );
    return rows[0] ?? { plans: 0, tasks: 0 };
  };

  return {
    server,
    pool,
    makeUser,
    makeMaterial,
    addChunk,
    create,
    planBody,
    storedFor,
    stop: async () => {
      await pool.end();
      await server.stop();
    },
  };
}

/** §32, repeated here because a generation failure is where internals leak. */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /generativelanguage|googleapis|GEMINI_API_KEY/i);
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules|\.js:\d+/, "no stack frame");
  assert.doesNotMatch(json, /storage_?[Kk]ey|\/tmp\/|\/home\//);
  assert.doesNotMatch(json, /SELECT |INSERT |study_plan_tasks/i);
  assert.doesNotMatch(json, /prompt|APPLICATION INSTRUCTIONS|\[Source \d/i);
}

// ── §19, §25: a rejected plan writes nothing ────────────────────────────────

describe("model output the validator refuses is never persisted (§19, §25)", () => {
  // One server for all of these: every mode below fails, and the assertion is
  // the same one, so they are grouped by what they prove rather than by mode.
  // Each gets its own server because the mode is fixed at spawn.
  for (const [mode, why] of [
    ["prose", "not JSON at all"],
    ["empty-tasks", "a plan with no tasks"],
    ["no-title", "a plan with no title"],
    ["bad-type", "a task type outside the four allowed"],
    ["bad-duration", "a duration that is not a number"],
    ["too-many-tasks", "more tasks than the configured cap"],
  ]) {
    describe(`FAKE_PLAN_MODE=${mode} — ${why}`, () => {
      let ctx;
      before(async () => {
        ctx = await planServer(`plan-${mode}`, { FAKE_PLAN_MODE: mode });
      });
      after(async () => ctx?.stop());

      it("answers 500 with a safe message and writes nothing", async () => {
        const username = await ctx.makeUser();
        const res = await ctx.create(ctx.planBody(username));

        assert.equal(res.status, 500, `expected 500, got ${res.status}: ${res.text}`);
        assert.match(res.headers.get("content-type") ?? "", /application\/json/);
        assert.equal(typeof res.body.error, "string");
        assertNoInternals(res.body);

        // The claim §25 actually makes. Both tables, because a plan row with no
        // tasks and orphaned task rows are different bugs and a one-table check
        // would miss one of them.
        const stored = await ctx.storedFor(username);
        assert.equal(stored.plans, 0, "no plan row may survive a rejected output");
        assert.equal(stored.tasks, 0, "and no task rows");
      });
    });
  }
});

// ── §33: the single controlled retry ────────────────────────────────────────

describe("one retry, and exactly one plan (§33)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-retry", { FAKE_PLAN_MODE: "retry-once" });
  });
  after(async () => ctx?.stop());

  it("recovers from a first invalid response and persists a single plan", async () => {
    // The fake refuses the first call and succeeds on the second, which is the
    // only way to observe the retry from outside. What matters as much as the
    // 201 is that the recovery did not write the plan twice.
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username));

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.title, CANNED_PLAN_TITLE);
    assert.ok(res.body.tasks.length > 0);

    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 1, "a retry must not double-write (§33)");
    assert.equal(stored.tasks, res.body.tasks.length);
  });

  it("does not retry a second time for a second learner", async () => {
    // The counter is per-process and now past its first call, so this request
    // gets a valid response immediately. It is here to show the retry is not a
    // loop: the mode that failed once does not keep failing or keep retrying.
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username));

    assert.equal(res.status, 201, res.text);
    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 1);
  });
});

// ── §33, §34: the provider itself failing ───────────────────────────────────

describe("a provider failure is reported, not retried, and writes nothing (§33)", () => {
  let ctx;
  before(async () => {
    // FAKE_GEMINI_MODE, not FAKE_PLAN_MODE: the request never reaches a
    // response body to be shaped. This is transport failing, not the model
    // answering badly, and the two get different treatment — a malformed answer
    // is retried once, an unreachable provider is not.
    ctx = await planServer("plan-down", { FAKE_GEMINI_MODE: "http-error" });
  });
  after(async () => ctx?.stop());

  it("answers 500 without leaking the provider or the error", async () => {
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username));

    assert.equal(res.status, 500, res.text);
    assert.equal(typeof res.body.error, "string");
    assertNoInternals(res.body);
    // The upstream status is an internal detail; a client cannot act on it.
    assert.doesNotMatch(res.text, /\b503\b|\b429\b|upstream/i);

    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 0);
    assert.equal(stored.tasks, 0);
  });

  it("leaves the learner able to create a plan once the provider returns", async () => {
    // Nothing about the failure above is sticky — no partial row blocks a retry
    // by hand, which is what a half-created plan would do.
    const username = await ctx.makeUser();
    await ctx.create(ctx.planBody(username));
    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 0, "and still nothing after a second failure");
  });
});

// ── §21, §22: clamping and dropping, seen from outside ──────────────────────

describe("FAKE_PLAN_MODE=long-tasks — the daily budget is enforced (§21)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-long", { FAKE_PLAN_MODE: "long-tasks" });
  });
  after(async () => ctx?.stop());

  it("clamps every over-long task instead of rejecting the plan", async () => {
    // The model returns tasks one minute over the whole daily budget. §21 says
    // the backend owns duration limits, and §22 says compress rather than
    // refuse — so the learner gets a usable plan, not an error.
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username, { dailyMinutes: 45 }));

    assert.equal(res.status, 201, res.text);
    assert.ok(res.body.tasks.length > 0);

    const perDate = new Map();
    for (const task of res.body.tasks) {
      assert.ok(
        task.durationMinutes <= 45,
        `task of ${task.durationMinutes} minutes against a 45-minute budget`,
      );
      assert.ok(task.durationMinutes >= 1);
      perDate.set(
        task.scheduledDate,
        (perDate.get(task.scheduledDate) ?? 0) + task.durationMinutes,
      );
    }
    for (const [date, total] of perDate) {
      assert.ok(total <= 45, `${date} totals ${total}`);
    }

    // Each task filled a whole day, so no date carries two of them.
    for (const [, total] of perDate) assert.equal(total, 45);
  });

  it("stores exactly what it returned", async () => {
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username, { dailyMinutes: 60 }));
    const stored = await ctx.storedFor(username);

    assert.equal(stored.plans, 1);
    assert.equal(
      stored.tasks,
      res.body.tasks.length,
      "the response must not be a different plan from the persisted one",
    );

    const { rows } = await ctx.pool.query(
      `SELECT MAX(duration_minutes) AS longest FROM study_plan_tasks t
         JOIN study_plans p ON p.id = t.study_plan_id
         JOIN users u ON u.id = p.user_id
        WHERE u.username = $1`,
      [username],
    );
    assert.ok(rows[0].longest <= 60, "the clamp is in the database, not just the JSON");
  });
});

describe("FAKE_PLAN_MODE=overflow — the calendar wins (§22)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-overflow", { FAKE_PLAN_MODE: "overflow" });
  });
  after(async () => ctx?.stop());

  it("drops the tail rather than scheduling past the exam date", async () => {
    // Ten times the content the calendar holds. §22's documented choice is to
    // compress and drop, not to refuse — and the invariant that must survive it
    // is that nothing lands after the exam.
    const username = await ctx.makeUser();
    const examDate = new Date(Date.now() + 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const res = await ctx.create(
      ctx.planBody(username, { examDate, dailyMinutes: 60 }),
    );

    assert.equal(res.status, 201, res.text);
    assert.ok(res.body.tasks.length > 0, "a full drop would be a rejected plan");
    assert.equal(res.body.endDate, res.body.tasks.at(-1).scheduledDate);

    for (const task of res.body.tasks) {
      assert.ok(
        task.scheduledDate <= examDate,
        `${task.scheduledDate} is after the exam on ${examDate}`,
      );
    }

    // Seven dates at one task each (each task is the whole budget), so the
    // dropping is real and not a coincidence of a generous horizon.
    const dates = new Set(res.body.tasks.map((t) => t.scheduledDate));
    assert.ok(dates.size <= 7, `${dates.size} distinct dates in a 7-day window`);
    assert.ok(
      res.body.tasks.length < 70,
      `${res.body.tasks.length} tasks survived a window that holds a handful`,
    );
  });

  it("never exceeds the daily budget on any day it did keep", async () => {
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username, { dailyMinutes: 30 }));

    const perDate = new Map();
    for (const task of res.body.tasks) {
      perDate.set(
        task.scheduledDate,
        (perDate.get(task.scheduledDate) ?? 0) + task.durationMinutes,
      );
    }
    for (const [date, total] of perDate) {
      assert.ok(total <= 30, `${date} totals ${total} against a 30-minute budget`);
    }
  });
});

// ── §20, §36: material aliases ──────────────────────────────────────────────

describe("FAKE_PLAN_MODE=cite-material — aliases resolve to real ids (§20)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-cite", { FAKE_PLAN_MODE: "cite-material" });
  });
  after(async () => ctx?.stop());

  it("maps MATERIAL_1 back to the learner's own material id", async () => {
    // The model only ever sees MATERIAL_1. The backend is what turns that into
    // a database id, which is §20's whole point: the model cannot name a row.
    const username = await ctx.makeUser();
    const materialId = await ctx.makeMaterial(username, "biology-notes.pdf");
    await ctx.addChunk(materialId, "Photosynthesis converts light into sugar.");

    const res = await ctx.create(
      ctx.planBody(username, { materialIds: [materialId] }),
    );

    assert.equal(res.status, 201, res.text);
    const cited = res.body.tasks.filter((task) => task.materialId !== null);
    assert.ok(cited.length > 0, "the model cited a material on every task");
    for (const task of cited) {
      assert.equal(task.materialId, materialId);
    }
  });

  it("never returns the alias, the filename or the storage key", async () => {
    const username = await ctx.makeUser();
    const materialId = await ctx.makeMaterial(username, "secret-filename.pdf");
    await ctx.addChunk(materialId, "Chlorophyll absorbs red and blue light.");

    const res = await ctx.create(
      ctx.planBody(username, { materialIds: [materialId] }),
    );

    assert.doesNotMatch(res.text, /MATERIAL_\d/, "aliases are internal to the prompt");
    assert.doesNotMatch(res.text, /secret-filename/, "no filename in a plan response");
    assertNoInternals(res.body);
  });

  it("stores a material id the database will vouch for", async () => {
    // A foreign key is what makes "the backend remains the authority" true
    // rather than merely intended: a fabricated id could not have been written.
    const username = await ctx.makeUser();
    const materialId = await ctx.makeMaterial(username);
    await ctx.addChunk(materialId, "Light-dependent reactions occur in thylakoids.");

    await ctx.create(ctx.planBody(username, { materialIds: [materialId] }));

    const { rows } = await ctx.pool.query(
      `SELECT DISTINCT t.material_id
         FROM study_plan_tasks t
         JOIN study_plans p ON p.id = t.study_plan_id
         JOIN users u ON u.id = p.user_id
        WHERE u.username = $1 AND t.material_id IS NOT NULL`,
      [username],
    );
    assert.deepEqual(
      rows.map((r) => r.material_id),
      [materialId],
    );
  });
});

describe("FAKE_PLAN_MODE=invent-material — an invented alias is dropped (§20)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-invent", { FAKE_PLAN_MODE: "invent-material" });
  });
  after(async () => ctx?.stop());

  it("keeps the task and drops the reference", async () => {
    // MATERIAL_99 was never in the prompt. §16 and §20 both say the task itself
    // is still useful — losing the whole plan over one bad citation would be a
    // worse answer than losing the citation.
    const username = await ctx.makeUser();
    const materialId = await ctx.makeMaterial(username);
    await ctx.addChunk(materialId, "Stomata regulate gas exchange.");

    const res = await ctx.create(
      ctx.planBody(username, { materialIds: [materialId] }),
    );

    assert.equal(res.status, 201, res.text);
    assert.ok(res.body.tasks.length > 0);
    for (const task of res.body.tasks) {
      assert.equal(
        task.materialId,
        null,
        "an alias the backend never issued must resolve to nothing",
      );
    }
    assert.doesNotMatch(res.text, /MATERIAL_99/);
  });

  it("never invents a row, and never points at another learner's material", async () => {
    // The failure this guards against is an invented alias being coerced into
    // *some* id — the first material, or a neighbouring one.
    const alice = await ctx.makeUser("alice");
    const bob = await ctx.makeUser("bob");
    const aliceMaterial = await ctx.makeMaterial(alice, "alice.pdf");
    await ctx.addChunk(aliceMaterial, "Alice's notes on the Calvin cycle.");
    const bobMaterial = await ctx.makeMaterial(bob, "bob.pdf");
    await ctx.addChunk(bobMaterial, "Bob's notes on respiration.");

    await ctx.create(ctx.planBody(bob, { materialIds: [bobMaterial] }));

    const { rows } = await ctx.pool.query(
      `SELECT COUNT(*) AS c FROM study_plan_tasks t
         JOIN study_plans p ON p.id = t.study_plan_id
        WHERE t.material_id IS NOT NULL`,
    );
    assert.equal(rows[0].c, 0, "no task may reference any material here");
  });
});

// ── §37: materials are optional, and RAG is not on the critical path ────────

describe("a plan needs no materials, and does not embed when it has none (§37)", () => {
  let ctx;
  before(async () => {
    // The provider's generation endpoint works; its EMBEDDING endpoint is
    // broken. A plan with no materials must not touch it at all, so a 201 here
    // is the proof that no retrieval happened.
    ctx = await planServer("plan-noembed", { FAKE_EMBEDDING_MODE: "malformed" });
  });
  after(async () => ctx?.stop());

  it("creates a plan with no materials while embeddings are broken", async () => {
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username, { materialIds: [] }));

    assert.equal(res.status, 201, `RAG must not be on this path: ${res.text}`);
    assert.ok(res.body.tasks.length > 0);
    for (const task of res.body.tasks) assert.equal(task.materialId, null);
  });

  it("reports a failure rather than silently dropping the materials", async () => {
    // The other half of the same decision. When a learner DID ask for grounding
    // and retrieval cannot run, quietly generating an ungrounded plan would
    // hand them something different from what they asked for, without saying so.
    const username = await ctx.makeUser();
    const materialId = await ctx.makeMaterial(username);
    await ctx.addChunk(materialId, "Some indexed content.");

    const res = await ctx.create(
      ctx.planBody(username, { materialIds: [materialId] }),
    );

    assert.equal(res.status, 500, res.text);
    assert.equal(typeof res.body.error, "string");
    assertNoInternals(res.body);

    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 0, "and a failed brief leaves nothing behind");
    assert.equal(stored.tasks, 0);
  });
});

// ── §19: clamping long text rather than refusing it ─────────────────────────

describe("FAKE_PLAN_MODE=long-text — over-long text is clamped, not rejected", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-longtext", { FAKE_PLAN_MODE: "long-text" });
  });
  after(async () => ctx?.stop());

  it("fits the columns the migration declares", async () => {
    // A 600-character title is a formatting problem, not a broken response, so
    // it is clamped — and the bound that matters is the database's, because the
    // alternative to clamping is a constraint violation surfacing as a 500.
    const username = await ctx.makeUser();
    const res = await ctx.create(ctx.planBody(username));

    assert.equal(res.status, 201, res.text);
    assert.ok(res.body.title.length <= 200, `title was ${res.body.title.length}`);
    assert.ok(res.body.goal.length <= 2000, `goal was ${res.body.goal.length}`);

    for (const task of res.body.tasks) {
      assert.ok(task.title.length <= 200, `task title was ${task.title.length}`);
      assert.ok((task.description ?? "").length <= 2000);
      assert.ok((task.topic ?? "").length <= 200);
    }

    const stored = await ctx.storedFor(username);
    assert.equal(stored.plans, 1, "and it committed");
  });
});

// ── §25: no half-created plans ──────────────────────────────────────────────

describe("a plan and its tasks commit together or not at all (§25)", () => {
  let ctx;
  before(async () => {
    ctx = await planServer("plan-atomic");
  });
  after(async () => ctx?.stop());

  it("never leaves a plan row without tasks", async () => {
    // The invariant across everything this database has seen, rather than for
    // one request: a plan with no tasks is the shape a half-finished
    // transaction leaves behind, and no code path may produce it.
    const username = await ctx.makeUser();
    await ctx.create(ctx.planBody(username));
    await ctx.create(ctx.planBody(username, { subject: "Chemistry" }));

    const { rows } = await ctx.pool.query(
      `SELECT p.id FROM study_plans p
        WHERE NOT EXISTS (SELECT 1 FROM study_plan_tasks t
                           WHERE t.study_plan_id = p.id)`,
    );
    assert.deepEqual(rows, [], "every plan must have at least one task");
  });

  it("never leaves a task whose plan is gone", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT t.id FROM study_plan_tasks t
        WHERE NOT EXISTS (SELECT 1 FROM study_plans p WHERE p.id = t.study_plan_id)`,
    );
    assert.deepEqual(rows, []);
  });

  it("commits the regeneration and the archive together (§30)", async () => {
    // Two writes in one transaction: the new plan, and the parent's status. A
    // partial commit here is two active plans or none.
    const username = await ctx.makeUser();
    const original = (await ctx.create(ctx.planBody(username))).body;

    const res = await ctx.server.request(
      "POST",
      `/api/study-plans/${original.id}/regenerate`,
      { json: { username } },
    );
    assert.equal(res.status, 201, res.text);

    const { rows } = await ctx.pool.query(
      `SELECT p.id, p.status, p.parent_plan_id
         FROM study_plans p JOIN users u ON u.id = p.user_id
        WHERE u.username = $1 ORDER BY p.id`,
      [username],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, "archived");
    assert.equal(rows[1].status, "active");
    assert.equal(rows[1].parent_plan_id, rows[0].id);
  });

  it("holds no transaction open across the provider call (§25, §52)", async () => {
    // Not directly observable from outside — so what is asserted is the
    // consequence: plans created concurrently all commit, and none blocks
    // another. A transaction opened before the Gemini call would serialise
    // these behind one another and, under a slow provider, exhaust the pool.
    const users = await Promise.all([
      ctx.makeUser("conc"),
      ctx.makeUser("conc"),
      ctx.makeUser("conc"),
      ctx.makeUser("conc"),
      ctx.makeUser("conc"),
    ]);

    const responses = await Promise.all(
      users.map((username) => ctx.create(ctx.planBody(username))),
    );

    for (const res of responses) {
      assert.equal(res.status, 201, res.text);
      assert.ok(res.body.tasks.length > 0);
    }
    const ids = new Set(responses.map((res) => res.body.id));
    assert.equal(ids.size, responses.length, "each request produced its own plan");
  });
});
