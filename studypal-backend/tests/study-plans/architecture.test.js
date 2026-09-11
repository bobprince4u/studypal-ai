/**
 * The SP-V2-005 architecture checks (§50), as tests rather than a checklist.
 *
 * Same method as tests/materials/architecture.test.js, and the same reasoning:
 * every assertion reads the source tree and asserts a property of its SHAPE —
 * which layer may hold SQL, which may call a model, where a date is decided,
 * where ownership is enforced. None of it exercises behaviour. A layering rule
 * that lives only in a review comment is one refactor away from being gone, and
 * the failure it permits is invisible in a green run because the feature still
 * works.
 *
 * WHAT THIS FILE ADDS OVER THE MATERIALS ONE
 * ------------------------------------------
 * The materials suite already asserts the tree-wide rules — one provider SDK
 * import, no SQL in controllers, no filesystem outside storage — and those cover
 * src/study-plans automatically, because they are stated over the whole of src/
 * rather than over one directory. Re-asserting them here would be duplication
 * that drifts.
 *
 * What is new in SP-V2-005 is a different set of claims, and they are the ones
 * below: that the backend rather than the model decides dates and durations,
 * that the model is never given a database id, that the generator does not
 * reimplement retrieval, and that no provider call happens inside a transaction.
 * Each is a property the behavioural suites can only observe indirectly.
 *
 * THE FAILURE MODE OF A TEXTUAL CHECK IS SILENCE
 * ----------------------------------------------
 * A pattern that stops matching does not fail — it passes, permanently, on
 * anything. So every rule here is paired with an assertion that the pattern
 * still matches something it should: a file count, a named symbol, the same
 * pattern found in the module that is supposed to have it. A green run should
 * mean the check ran, not that it found nothing.
 *
 * Two rules deserve their reasoning stated, because the obvious way to write
 * them is wrong and passes anyway:
 *
 *   — §2's exclusions are checked as the set of EXTERNAL import specifiers, not
 *     by grepping for product names. Grepping finds `ical` inside "atomically"
 *     and `moment` inside "the moment a learner corrected a mis-tap", so such a
 *     rule reports English prose and has to be weakened until it reports
 *     nothing. A dependency has to be imported to be used; the import list is
 *     both exact and impossible to trip on a comment.
 *
 *   — the no-logging rule is checked over template interpolations rather than
 *     over logger call text, because what leaks a document is a BINDING inside
 *     `${...}`, never the English of the message around it.
 *
 *   node --test tests/study-plans/architecture.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { BACKEND_ROOT } from "../helpers/server-harness.mjs";

const SRC = path.join(BACKEND_ROOT, "src");
const PLANS = path.join(SRC, "study-plans");

/** Every .js file under a directory, recursively, as repo-relative paths. */
async function jsFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.name.endsWith(".js")) {
        found.push(path.relative(BACKEND_ROOT, full));
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function readAll(relativePaths) {
  const entries = await Promise.all(
    relativePaths.map(async (relative) => [
      relative,
      await fs.readFile(path.join(BACKEND_ROOT, relative), "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

const read = (relative) =>
  fs.readFile(path.join(BACKEND_ROOT, relative), "utf8");

/**
 * Comments out, strings in.
 *
 * The default here, for the reason the materials suite documents at length: in
 * JavaScript a query and an import specifier are both strings, so a stripper
 * that removed them would make the SQL and dependency rules vacuous — they would
 * pass on a file that was nothing but SQL.
 *
 * Comments have to go, because this feature explains its own boundaries by
 * quoting them. The validation middleware's header contains the text
 * `WHERE user_id = $2` precisely in order to say that it does not contain that
 * query, and study-calendar.js names src/config/database.js in a comment about
 * the session time zone while importing nothing at all.
 */
function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Comments AND strings out, for rules about what the code does. */
function stripCommentsAndStrings(source) {
  return stripComments(source)
    .replaceAll(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replaceAll(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replaceAll(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function assertNoneMatch(sources, pattern, why, strip = stripCommentsAndStrings) {
  const offenders = Object.entries(sources)
    .filter(([, source]) => pattern.test(strip(source)))
    .map(([file]) => file);
  assert.deepEqual(offenders, [], `${why}\noffending files: ${offenders.join(", ")}`);
}

const SQL =
  /\b(SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|JOIN\s)/i;

/** The one module allowed to speak SQL in this feature. */
const REPOSITORY = "src/study-plans/study-plan.repository.js";

describe("§4 the layers are real", () => {
  it("has one module per responsibility", async () => {
    // The cheapest statement of §4's diagram: the files exist and are separate.
    // A single 900-line study-plan.service.js would satisfy every other check in
    // this file.
    const present = await jsFiles(SRC);
    for (const expected of [
      "src/study-plans/study-plan.routes.js",
      "src/study-plans/study-plan.controller.js",
      "src/study-plans/study-plan.service.js",
      "src/study-plans/study-plan.repository.js",
      "src/study-plans/study-plan-validation.middleware.js",
      "src/study-plans/study-plan-generator.js",
      // The three deterministic modules. Each is separate because each is
      // separately testable with no database, no provider and no clock — which
      // is exactly what tests/study-plans/scheduling.test.js relies on.
      "src/study-plans/study-calendar.js",
      "src/study-plans/plan-normalizer.js",
      "src/study-plans/plan-output.validator.js",
      // Material grounding, kept out of the generator so the generator holds no
      // opinion about where context comes from.
      "src/study-plans/material-brief.js",
      // The prompt lives with the other prompts rather than inside this feature,
      // so the feature depends on an interface instead of on Google.
      "src/ai/prompts/study-plan.prompt.js",
    ]) {
      assert.ok(present.includes(expected), `missing ${expected}`);
    }
  });

  it("keeps SQL in the repository and nowhere else in the feature", async () => {
    const files = (await jsFiles(PLANS)).filter((file) => file !== REPOSITORY);
    assert.ok(files.length >= 8, "the check must actually find the feature's modules");
    assertNoneMatch(
      await readAll(files),
      SQL,
      "§4: the repository is the only module in this feature that speaks SQL.",
      stripComments,
    );
  });

  it("puts the study-plan SQL where it belongs, so the rule is not vacuous", async () => {
    // The complement. Without this, deleting every query in the feature would
    // satisfy the rule above while breaking the product.
    //
    // The UPDATE patterns stop at the table name rather than requiring SET,
    // because both writes alias their table (`UPDATE study_plan_tasks t SET`) so
    // that a correlated EXISTS can refer back to it.
    const source = await read(REPOSITORY);
    for (const statement of [
      /INSERT\s+INTO\s+study_plans\b/i,
      /INSERT\s+INTO\s+study_plan_tasks\b/i,
      /UPDATE\s+study_plans\b/i,
      /UPDATE\s+study_plan_tasks\b/i,
      /SELECT/i,
    ]) {
      assert.match(source, statement);
    }
  });

  it("opens a database connection only in the repository", async () => {
    /**
     * stripComments rather than the default, and that choice is the whole test:
     * an import specifier IS a string, so stripping strings would leave nothing
     * to match and the rule would pass on a file that imported the pool twice.
     *
     * Stripping comments is still necessary — study-calendar.js discusses
     * src/config/database.js pinning the session TimeZone to UTC, which is a
     * fact about why it can do date arithmetic in UTC, not a dependency on it.
     */
    const files = (await jsFiles(PLANS)).filter((file) => file !== REPOSITORY);
    assertNoneMatch(
      await readAll(files),
      /config\/database\.js/,
      "§4: route → controller → service → repository → PostgreSQL, in that order.",
      stripComments,
    );
    assert.match(
      stripComments(await read(REPOSITORY)),
      /import\s*\{[^}]*\}\s*from\s*"\.\.\/config\/database\.js"/,
      "and the repository really does hold the connection",
    );
  });

  it("keeps req and res out of everything below the controller", async () => {
    // A service that reads req.query cannot be called from anywhere else, which
    // is the practical cost of leaking HTTP downward. The controller, routes and
    // middleware are excluded because handling req/res is their job.
    const files = (await jsFiles(PLANS)).filter(
      (file) => !/\.controller\.|\.routes\.|\.middleware\./.test(file),
    );
    assert.ok(files.length >= 6);
    assertNoneMatch(
      await readAll(files),
      /\breq\.(body|query|params|file)\b|\bres\.(json|status|send)\b/,
      "§4: services, repositories and the deterministic modules must not know about HTTP.",
    );
  });

  it("wraps every endpoint in the central async wrapper", async () => {
    // Without asyncHandler a rejected promise is an unhandled rejection rather
    // than the JSON error §32 requires — and every path in this feature is async
    // several calls deep.
    const routes = await read("src/study-plans/study-plan.routes.js");
    assert.equal(
      (routes.match(/asyncHandler\(/g) ?? []).length,
      5,
      "all five study-plan endpoints must be wrapped",
    );
  });
});

describe("§17, §20 the model is told nothing it could use to reach the database", () => {
  it("never calls a provider from the controller or the repository", async () => {
    // §4: "do not put Gemini calls in controllers". A repository that could
    // generate, or a controller that could, has bypassed the service that owns
    // the decision to spend a provider call at all.
    assertNoneMatch(
      await readAll([
        "src/study-plans/study-plan.controller.js",
        "src/study-plans/study-plan.repository.js",
      ]),
      /@google\/genai|GoogleGenAI|generateJsonContent|embedQuery|embedDocuments|GEMINI_API_KEY/,
      "§4: controllers speak HTTP and repositories speak SQL. Neither calls a model.",
      stripComments,
    );
  });

  it("calls the model from exactly one module in this feature", async () => {
    // An equality against a NON-EMPTY list, which is what makes it
    // self-anchoring: it fails if a second module generates, and it fails if the
    // generator stops doing so.
    const callers = Object.entries(await readAll(await jsFiles(PLANS)))
      .filter(([, source]) => /generateJsonContent\(/.test(stripComments(source)))
      .map(([file]) => file);
    assert.deepEqual(callers, ["src/study-plans/study-plan-generator.js"]);
  });

  it("gives the model no field through which to name a database row", async () => {
    /**
     * §20, enforced by ABSENCE. The response schema has no `materialId`, no
     * `id`, no `planId` — there is no key for a model to fill with a row
     * identifier, so there is nothing to validate, sanitise or accidentally
     * trust. The one material field it has is `material`, carrying an opaque
     * alias the backend issued and only the backend can resolve.
     */
    const { STUDY_PLAN_RESPONSE_SCHEMA } = await import(
      "../../src/ai/prompts/study-plan.prompt.js"
    );
    assert.deepEqual(Object.keys(STUDY_PLAN_RESPONSE_SCHEMA.properties).sort(), [
      "goal",
      "tasks",
      "title",
    ]);

    const task = STUDY_PLAN_RESPONSE_SCHEMA.properties.tasks.items;
    assert.deepEqual(Object.keys(task.properties).sort(), [
      "description",
      "durationMinutes",
      "material",
      "taskType",
      "title",
      "topic",
    ]);
    assert.equal(task.properties.material.type, "string", "an alias, never an id");

    // The fields §17 reserves for the backend are absent BY NAME, so this fails
    // the moment one is added rather than only when one is trusted.
    for (const forbidden of [
      "id",
      "materialId",
      "material_id",
      "planId",
      "userId",
      "scheduledDate",
      "date",
      "status",
      "position",
    ]) {
      assert.ok(
        !(forbidden in task.properties),
        `§17: ${forbidden} is the backend's to decide, not the model's`,
      );
      assert.ok(!(forbidden in STUDY_PLAN_RESPONSE_SCHEMA.properties));
    }
  });

  it("resolves aliases in one place, and never in the validator", async () => {
    /**
     * §20's boundary, as a separation of responsibilities rather than a comment.
     *
     * The validator sees the model's output and the set of aliases that were
     * issued; it can say an alias was invented, but it holds no map from alias
     * to id and so cannot resolve one even by mistake. The normalizer holds the
     * map and does the resolution, once. Keeping those apart is what makes "the
     * model cannot name a row" structurally true instead of carefully true.
     */
    const validator = stripComments(
      await read("src/study-plans/plan-output.validator.js"),
    );
    assert.doesNotMatch(
      validator,
      /aliasToMaterialId|materialId/,
      "§20: the validator reports invented aliases; it does not resolve real ones",
    );

    const normalizer = stripComments(
      await read("src/study-plans/plan-normalizer.js"),
    );
    assert.equal(
      (normalizer.match(/aliasToMaterialId\.get\(/g) ?? []).length,
      1,
      "§20: exactly one alias→id resolution, so an alias cannot take a second path",
    );
  });

  it("builds aliases from the caller's own resolved materials", async () => {
    // The aliases exist because the model must not see a real id. That is only
    // worth anything if the alias list is built from rows the DATABASE returned
    // for this user, which is the line asserted here — next to the ownership-
    // scoped lookup that makes it safe.
    const brief = stripComments(await read("src/study-plans/material-brief.js"));
    assert.match(brief, /`MATERIAL_\$\{/, "aliases are generated, not client-supplied");
    assert.match(
      brief,
      /findOwnedByIds\(materialIds,\s*userId\)/,
      "§10: and only over materials that lookup proved are the caller's",
    );
  });
});

describe("§11, §13 the backend owns the calendar", () => {
  it("decides dates in modules with no provider and no database", async () => {
    /**
     * §13: "prefer deterministic backend scheduling over trusting
     * model-generated dates". The strongest form of that is a scheduler that
     * COULD NOT consult a model if asked — no import, no client, no network.
     *
     * study-calendar.js imports nothing at all; the normalizer and validator
     * import only the logger. That is also why scheduling.test.js can assert 45
     * cases with no fixtures, no database and no fake provider.
     */
    const files = [
      "src/study-plans/study-calendar.js",
      "src/study-plans/plan-normalizer.js",
      "src/study-plans/plan-output.validator.js",
    ];
    const sources = await readAll(files);
    assertNoneMatch(
      sources,
      /@google\/genai|GoogleGenAI|\/ai\/|generateJsonContent|embedQuery|fetch\(|config\/database\.js/,
      "§13: scheduling is deterministic — no model, no database, no network.",
      stripComments,
    );
    assertNoneMatch(sources, SQL, "§13: the scheduler does not query.", stripComments);

    // The anchor: these are real modules, not three empty files that would
    // satisfy any absence rule ever written.
    assert.match(
      stripComments(sources["src/study-plans/study-calendar.js"]),
      /export function availableStudyDates/,
    );
    assert.match(
      stripComments(sources["src/study-plans/plan-normalizer.js"]),
      /export function normalizePlan/,
    );
  });

  it("reads the clock in exactly one place", async () => {
    /**
     * §11: "do not use the client-provided local clock blindly." The server's
     * today is a single function, so there is one answer to "what day is it"
     * across validation, scheduling and persistence.
     *
     * Any other module calling `new Date()` or `Date.now()` would be a second,
     * possibly disagreeing, clock — and a plan validated against one midnight
     * and scheduled against another is a bug that only appears near a date
     * boundary, which is to say only in production and only sometimes.
     */
    const offenders = Object.entries(await readAll(await jsFiles(PLANS)))
      .filter(([file, source]) => {
        if (file === "src/study-plans/study-calendar.js") return false;
        return /new Date\(\s*\)|Date\.now\(\)/.test(stripComments(source));
      })
      .map(([file]) => file);
    assert.deepEqual(
      offenders,
      [],
      "§11: the server's today comes from study-calendar.todayIso(), once.",
    );

    const calendar = stripComments(await read("src/study-plans/study-calendar.js"));
    assert.match(calendar, /export function todayIso/, "and that one reading exists");
    assert.match(calendar, /Date\.now\(\)/, "and it is a real clock read");
  });

  it("never lets the model's text become a date", async () => {
    // §17: date validity is not the model's responsibility. The validator is the
    // module that reads model output, and it contains no date handling at all —
    // it neither parses one nor passes one through.
    const validator = stripComments(
      await read("src/study-plans/plan-output.validator.js"),
    );
    assert.doesNotMatch(
      validator,
      /scheduledDate|isIsoDate|new Date|Date\.parse/,
      "§17: the model does not propose dates, so nothing parses one from its output",
    );
  });

  it("takes every bound from config rather than from a literal", async () => {
    /**
     * §48: "do not scatter magic numbers." The bounds a learner can hit —
     * topics, text length, daily minutes, materials, horizon — all come from
     * config.plan, which is validated at startup against what the migration's
     * CHECK constraints allow.
     *
     * Asserted over the validation middleware because that is where a literal
     * would be both most tempting and least visible: `if (topics.length > 20)`
     * reads perfectly and silently disagrees with the database the day either
     * one changes.
     */
    const source = stripComments(
      await read("src/study-plans/study-plan-validation.middleware.js"),
    );
    for (const key of [
      "config.plan.maxTopics",
      "config.plan.maxTextChars",
      "config.plan.minDailyMinutes",
      "config.plan.maxDailyMinutes",
      "config.plan.maxMaterials",
      "config.plan.maxHorizonDays",
    ]) {
      assert.ok(source.includes(key), `${key} must come from config (§48)`);
    }
  });
});

describe("§15 the generator does not reimplement RAG", () => {
  it("reuses the existing retrieval service and context builder", async () => {
    // §15: "do not turn the study-plan generator into a second RAG
    // implementation. Reuse: embedding provider, retrieval service, context
    // builder." Asserted as imports, which is the only form of reuse that cannot
    // quietly drift from the original.
    const brief = stripComments(await read("src/study-plans/material-brief.js"));
    assert.match(brief, /from\s+"\.\.\/materials\/retrieval\.service\.js"/);
    assert.match(brief, /from\s+"\.\.\/materials\/context-builder\.js"/);
  });

  it("contains no vector search of its own", async () => {
    /**
     * The other half of reuse: it is only real if there is no second
     * implementation beside it. A cosine computed here, a `<=>` operator, or a
     * direct call into the retrieval REPOSITORY would each be a parallel path
     * that could diverge on the threshold, the limit, or — worst — the ownership
     * predicate that keeps one learner's chunks out of another's prompt.
     */
    const pattern =
      /<=>|\bcosine|dotProduct|Math\.sqrt|Math\.hypot|searchSimilarChunks|retrieval\.repository/i;
    assertNoneMatch(
      await readAll(await jsFiles(PLANS)),
      pattern,
      "§15: vector search belongs to src/materials, and there is one of it.",
      stripComments,
    );

    // The anchor, and the reason this rule is not vacuous: the same pattern
    // finds the real implementation, so a green run means it was looking.
    const inMaterials = Object.entries(
      await readAll(await jsFiles(path.join(SRC, "materials"))),
    )
      .filter(([, source]) => pattern.test(stripComments(source)))
      .map(([file]) => file);
    assert.deepEqual(inMaterials, [
      "src/materials/retrieval.repository.js",
      "src/materials/retrieval.service.js",
    ]);
  });

  it("goes through the shared embedding provider, not around it", async () => {
    // §15 again, stated over the provider: this feature must not construct its
    // own embedding call, because two callers using different task types would
    // put two different vector spaces in one column and similarity would quietly
    // stop meaning anything.
    assertNoneMatch(
      await readAll(await jsFiles(PLANS)),
      /embedContent|batchEmbedContents|RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY/,
      "§15: embedding is src/ai/embedding.service.js's job.",
      stripComments,
    );
  });
});

describe("§25, §52 no provider call inside a transaction", () => {
  it("generates before it persists, and opens no transaction to do it", async () => {
    /**
     * §25: "do not call Gemini while holding a database transaction open."
     *
     * Checked as an ordering in the service, because the alternative — a
     * transaction wrapping the generation call — works perfectly in every test
     * and shows up in production as pool exhaustion, once provider latency and
     * request volume are both real at the same time.
     *
     * `await generateStudyPlan(` rather than `generateStudyPlan(`: the service
     * also exports regenerateStudyPlan, whose NAME CONTAINS the call this test
     * is looking for. Matching the bare call would find that export instead of
     * the call site, and the ordering assertion would silently become a claim
     * about where a function is declared.
     */
    const service = stripComments(await read("src/study-plans/study-plan.service.js"));

    const generate = service.indexOf("await generateStudyPlan(");
    const normalize = service.indexOf("normalizePlan(");
    const persist = service.indexOf("insertPlanWithTasks(");
    assert.ok(generate > 0, "the generation call is gone or was renamed");
    assert.ok(normalize > 0, "the normalization call is gone or was renamed");
    assert.ok(persist > 0, "the persistence call is gone or was renamed");

    // §19 and §25 together: the plan is fully validated and fully scheduled
    // while nothing is persisted, so a rejection costs a provider call and
    // nothing else. There is no partial row to clean up because there is no row.
    assert.ok(generate < normalize, "§25: generate, then normalize");
    assert.ok(normalize < persist, "§25: normalize, then persist");

    // And the service opens no transaction at all — withTransaction lives in the
    // repository, wrapped around the writes only.
    assert.doesNotMatch(
      service,
      /withTransaction/,
      "§25: the transaction belongs to the repository, around the INSERTs",
    );
    assert.match(
      stripComments(await read(REPOSITORY)),
      /withTransaction/,
      "and it is actually there",
    );
  });

  it("retries at most once, in one place", async () => {
    /**
     * §33: "optional ONE controlled retry (max one, no infinite loop, no double
     * write)". The bound is a named constant rather than a `while`, and the loop
     * is the only one in the module — a second retry elsewhere would be
     * invisible to any test that counts provider calls on the happy path.
     */
    const generator = stripComments(
      await read("src/study-plans/study-plan-generator.js"),
    );
    assert.match(generator, /MAX_ATTEMPTS\s*=\s*2/, "two attempts total, per §33");
    assert.doesNotMatch(generator, /\bwhile\s*\(/, "§33: no unbounded retry loop");
    assert.equal(
      (generator.match(/\bfor\s*\(/g) ?? []).length,
      1,
      "one loop, and it is the attempt loop",
    );

    // The write is not merely outside the loop — the generator cannot write at
    // all, so a retry cannot double-write whatever it returns or however often
    // it runs.
    assert.doesNotMatch(generator, /insertPlanWithTasks|repository/i);
  });
});

describe("§27 ownership is enforced where it cannot be forgotten", () => {
  it("names user_id only inside the repository", async () => {
    /**
     * The same absolute form the materials suite uses, and for the same reason:
     * a service that never sees `user_id` cannot filter on it after the fact,
     * cannot forget to, and cannot be handed a client-supplied value for it.
     *
     * Ownership still reaches the repository — as the resolved camelCase
     * `userId` argument — which is what lets the rule be this strict without
     * making the feature impossible to write. Comments are stripped because
     * three modules explain this boundary by quoting the predicate they do not
     * contain.
     */
    const mentions = Object.entries(await readAll(await jsFiles(PLANS)))
      .filter(([, source]) => /user_id/.test(stripComments(source)))
      .map(([file]) => file)
      .sort();
    assert.deepEqual(mentions, [REPOSITORY]);
  });

  it("has no plan lookup that can be called without a user", async () => {
    /**
     * §27: "do not allow access merely because the caller knows the plan ID."
     *
     * The structural form of that is the absence of a by-id-only finder: there
     * is findOwnedById(id, userId) and there is deliberately no findById(id), so
     * no future caller can reach a plan without saying whose it is. A rule about
     * call sites would only ever cover the call sites that exist today.
     */
    const repository = stripComments(await read(REPOSITORY));
    const exported = (
      repository.match(/export\s+(?:async\s+)?function\s+(\w+)/g) ?? []
    ).map((match) => match.replace(/export\s+(?:async\s+)?function\s+/, ""));

    assert.ok(exported.length >= 5, "the export scan must find the repository's API");
    assert.ok(exported.includes("findOwnedById"), "the owned finder must exist");
    assert.ok(
      !exported.some((name) => /^(findById|getById|findPlanById|getPlan)$/.test(name)),
      `§27: an id-only finder would bypass ownership — exports are ${exported.join(", ")}`,
    );

    // And it is scoped in the SQL rather than by a caller's discipline.
    assert.match(repository, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i);
  });

  it("scopes the task update in one statement", async () => {
    // §28. Plan ownership, task membership and task identity are three
    // conditions, and they are checked together: a read-then-write would leave a
    // window between the check and the update, and a missing condition would be
    // invisible in a green test that only ever used matching ids.
    const repository = stripComments(await read(REPOSITORY));
    const update = repository.slice(repository.indexOf("UPDATE study_plan_tasks"));
    assert.match(update, /EXISTS/i, "ownership is inside the UPDATE, not a prior SELECT");
    assert.match(update, /p\.user_id\s*=\s*\$/i);
    assert.match(update, /t\.study_plan_id\s*=\s*\$/i);
  });

  it("never returns a row straight from the database", async () => {
    /**
     * §32: "do not leak unnecessary internal IDs." The service maps every row
     * field by field rather than spreading it, which is what keeps `user_id` out
     * of a response even after a migration adds a column nobody remembers to
     * exclude. A spread is correct today and wrong the next time the table
     * grows — and wrong silently, in the direction of disclosure.
     */
    const service = stripComments(await read("src/study-plans/study-plan.service.js"));
    assert.doesNotMatch(
      service,
      /\.\.\.(?:plan|row|task|result)\b/,
      "§32: map rows field by field; a spread ships whatever the table grows",
    );
    for (const mapper of ["toApiShape", "toSummaryShape", "toPlanFields", "toTaskShape"]) {
      assert.match(service, new RegExp(`function ${mapper}\\b`), `${mapper} must exist`);
    }
  });
});

describe("§35 the prompt keeps its boundaries", () => {
  it("separates instructions, learner goals and untrusted material context", async () => {
    // §35 asks for explicit separation and for the boundary to be documented.
    // The three section headers are that documentation, in the artefact itself
    // rather than in a design note beside it.
    const prompt = await read("src/ai/prompts/study-plan.prompt.js");
    for (const marker of [
      "APPLICATION INSTRUCTIONS",
      "LEARNER GOALS",
      "STUDY MATERIAL CONTEXT",
    ]) {
      assert.ok(prompt.includes(marker), `§35: the prompt must label ${marker}`);
    }
    // And the instructions the model reads must SAY the material is data. A
    // separator the model was never told about is a layout choice, not a
    // boundary.
    assert.match(prompt, /DATA, not instructions/i);
  });

  it("builds the instructions from a constant nothing can interpolate into", async () => {
    /**
     * §35: "the material context must not be allowed to override application
     * instructions."
     *
     * The structural guarantee is that the instruction block is a template
     * literal with no `${` in it at all. Retrieved text cannot reach a string it
     * cannot be substituted into, so the only place a document can appear is the
     * section explicitly fenced as untrusted. Learner goals ARE interpolated —
     * in formatLearnerGoals, further down, inside its own labelled section.
     */
    const prompt = await read("src/ai/prompts/study-plan.prompt.js");
    const constant = prompt.match(/STUDY_PLAN_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/);
    assert.ok(constant, "§35: the static instruction constant must exist");
    assert.ok(constant[1].length > 500, "and this really is the instruction body");
    assert.doesNotMatch(
      constant[1],
      /\$\{/,
      "§35: nothing is interpolated into the application instructions",
    );
  });

  it("puts no prompt, context or model output into a log line", async () => {
    /**
     * The standing rule for this repository, checked where it is easiest to
     * break: a debug line added while chasing a generation bug is how retrieved
     * document text ends up in a log file, and it looks entirely harmless in
     * review.
     *
     * Checked over INTERPOLATIONS rather than over logger calls, because what
     * leaks a document is a binding inside `${...}`, never the English of the
     * message around it. Every interpolation in this feature is a count, an id,
     * a config bound or a SQL column list — `${brief.sourceCount}` rather than
     * `${brief.context}`, which is exactly the distinction the rule is about.
     */
    const sources = await readAll(await jsFiles(PLANS));
    const interpolations = new Set();
    for (const source of Object.values(sources)) {
      for (const match of stripComments(source).matchAll(/\$\{([^}]*)\}/g)) {
        interpolations.add(match[1].trim());
      }
    }
    assert.ok(interpolations.size >= 15, "the extraction must find real interpolations");

    const leaky = [...interpolations].filter((expression) =>
      /\b(prompt|materialContext|context|chunk|raw|responseText|apiKey|GEMINI_API_KEY|extracts?)\b/i.test(
        expression,
      ),
    );
    assert.deepEqual(leaky, [], "never interpolate a prompt, retrieved context or a key");
  });
});

describe("§2 nothing out of scope crept in", () => {
  it("imports exactly one external package", async () => {
    /**
     * §2's exclusion list — Redis, BullMQ, pg-boss, workers, notifications,
     * calendars, a second AI SDK, an ORM — as a single equality.
     *
     * Stated over import specifiers rather than by grepping for product names,
     * because grepping a codebase this heavily commented finds `ical` inside
     * "atomically" and `moment` inside "the moment a learner corrected a
     * mis-tap". A rule that reports English has to be weakened until it reports
     * nothing, and then it is decoration. A dependency must be imported to be
     * used, so the import list is both exact and impossible to trip on prose.
     *
     * express is the one, in study-plan.routes.js, for Router(). Everything else
     * this feature needs, the repository already owns.
     */
    const sources = await readAll(await jsFiles(PLANS));
    assert.ok(Object.keys(sources).length >= 9, "the check must read the feature");

    const external = new Set();
    for (const source of Object.values(sources)) {
      for (const match of stripComments(source).matchAll(
        /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g,
      )) {
        if (!match[1].startsWith(".")) external.add(match[1]);
      }
    }
    assert.deepEqual([...external].sort(), ["express"]);
  });

  it("schedules nothing in process", async () => {
    // The half an import list cannot catch: a background scheduler built out of
    // globals. §2 excludes background workers, and a plan generated on a timer
    // is one whether or not a library was installed to do it.
    assertNoneMatch(
      await readAll(await jsFiles(PLANS)),
      /\bsetInterval\s*\(|\bsetTimeout\s*\(|\bunref\s*\(/,
      "§2: no background scheduling — a request generates a plan, nothing else does.",
    );
  });

  it("declares no exam, grading or analytics table", async () => {
    // §2 excludes the exam simulator and learning analytics. The migration is
    // where a speculative table would appear, and an empty table nothing reads
    // is harder to remove later than it is to not create now.
    const sql = await read("migrations/postgres/004_study_plans.sql");
    assert.deepEqual(
      (sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi) ?? []).map((match) =>
        match.replace(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, ""),
      ),
      ["study_plans", "study_plan_tasks"],
      "§2: two tables, and no speculative third",
    );
  });

  it("leaves the older features independent of this one", async () => {
    /**
     * This feature may depend on materials; nothing in materials or /api/ask may
     * come to depend on IT. The arrow points one way, which is what keeps
     * SP-V2-002 and SP-V2-003 regression-testable without a study plan anywhere
     * in the fixture — and what makes it possible to say a failure in those
     * suites is not about this work.
     *
     * The route table is excluded because mounting the router is how the feature
     * becomes reachable at all.
     */
    const files = (await jsFiles(SRC)).filter(
      (file) => !file.startsWith("src/study-plans/") && !/routes\/index\.js$/.test(file),
    );
    const offenders = Object.entries(await readAll(files))
      .filter(([, source]) => /["'][^"']*study-plans\/[\w.-]+\.js["']/.test(source))
      .map(([file]) => file);
    assert.deepEqual(offenders, [], `§2: ${offenders.join(", ")} must not depend on study plans`);

    // The anchor: the router IS mounted, so the exclusion above is excluding
    // something real rather than describing a feature nobody wired up.
    assert.match(
      await read("src/routes/index.js"),
      /from\s+"\.\.\/study-plans\/study-plan\.routes\.js"/,
    );
  });
});
