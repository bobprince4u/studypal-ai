/**
 * The SP-V2-006 architecture checks (§23), as tests rather than a checklist.
 *
 * Same method as tests/materials/architecture.test.js and
 * tests/study-plans/architecture.test.js: every assertion reads the source tree
 * and asserts a property of its SHAPE — which layer may hold SQL, which may call
 * a model, where the answer key may appear, where grading happens. None of it
 * exercises behaviour. A layering rule that lives only in a review comment is
 * one refactor away from being gone, and the failure it permits is invisible in
 * a green run because the feature still works.
 *
 * WHAT THIS FILE ADDS OVER THE OTHER TWO
 * --------------------------------------
 * The materials suite states the tree-wide rules — one provider SDK import, no
 * SQL in controllers, no filesystem access outside storage — over the whole of
 * src/, so they already cover src/exams without being restated. Re-asserting
 * them here would be duplication that drifts.
 *
 * What is new in SP-V2-006 is one claim, and almost every rule below is a
 * different face of it: THE ANSWER KEY AND THE SCORE ARE THE SERVER'S. §5 and
 * §10 state it as behaviour, and tests/exams/api.test.js checks that behaviour
 * over HTTP. But the behavioural test can only prove that today's code path
 * withholds the key — it cannot prove that no other path exists. That is a
 * property of the shape:
 *
 *   — the column list used for taking an exam cannot name `correct_answer`, so
 *     the taking query cannot select it even by accident;
 *   — the grader imports no AI module and no database module, so a score cannot
 *     come from a model or from a second query;
 *   — grading is called from exactly one place, inside the transaction, against
 *     a key read in that same transaction;
 *   — the word `isCorrect` appears in no request-parsing code, so §5's "never
 *     accept it from a client" needs no filter — there is no field to filter.
 *
 * THE FAILURE MODE OF A TEXTUAL CHECK IS SILENCE
 * ----------------------------------------------
 * A pattern that stops matching does not fail — it passes, permanently, on
 * anything. So every rule here is paired with an assertion that the pattern
 * still matches something it should: a file count, a named symbol, the same
 * pattern found in the module that is supposed to have it. A green run should
 * mean the check ran, not that it found nothing.
 *
 *   node --test tests/exams/architecture.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { BACKEND_ROOT } from "../helpers/server-harness.mjs";

const SRC = path.join(BACKEND_ROOT, "src");
const EXAMS = path.join(SRC, "exams");

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

const read = (relative) => fs.readFile(path.join(BACKEND_ROOT, relative), "utf8");

/**
 * Comments out, strings in.
 *
 * The default here, for the reason the materials suite documents at length: in
 * JavaScript a query and an import specifier are both strings, so a stripper
 * that removed them would make the SQL and dependency rules vacuous — they would
 * pass on a file that was nothing but SQL.
 *
 * Comments have to go, because this feature explains its boundaries by quoting
 * them. grader.js's header says it never calls Gemini, exam.controller.js's says
 * it contains no SQL, and exam.repository.js's names `correct_answer` repeatedly
 * in order to say which queries must not select it. A rule that fires on its own
 * documentation is a rule nobody keeps.
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

/** Any route to a model, however it is reached. */
const PROVIDER = /@google\/genai|gemini\.client|generateJsonContent|generateContent/;

/** The one module in this feature allowed to speak SQL. */
const REPOSITORY = "src/exams/exam.repository.js";

/** The one module in this feature allowed to call a model. */
const GENERATOR = "src/exams/exam-generator.js";

describe("§23 the layers are real", () => {
  it("has one module per responsibility", async () => {
    // The list is asserted rather than described, so adding a module to this
    // feature is a decision someone makes here instead of a file that appears.
    const present = await jsFiles(EXAMS);
    assert.deepEqual(present, [
      "src/exams/exam-generator.js",
      "src/exams/exam-output.validator.js",
      "src/exams/exam-validation.middleware.js",
      "src/exams/exam.controller.js",
      "src/exams/exam.repository.js",
      "src/exams/exam.routes.js",
      "src/exams/exam.service.js",
      "src/exams/grader.js",
      "src/exams/material-brief.js",
    ]);
  });

  it("keeps SQL in the repository and nowhere else in the feature", async () => {
    const files = (await jsFiles(EXAMS)).filter((file) => file !== REPOSITORY);
    assert.ok(files.length >= 8, "the check must actually find the other modules");
    assertNoSqlIn(
      await readAll(files),
      "§23: the repository is the only module in this feature that speaks SQL.",
    );
  });

  it("puts the exam SQL where it belongs, so the rule is not vacuous", async () => {
    // The complement. Without it, deleting every query in the feature would
    // satisfy the rule above while breaking the product.
    const source = await read(REPOSITORY);
    for (const statement of [
      /INSERT\s+INTO\s+exams/i,
      /INSERT\s+INTO\s+exam_questions/i,
      /INSERT\s+INTO\s+exam_attempts/i,
      /INSERT\s+INTO\s+attempt_answers/i,
      /UPDATE\s+exam_attempts\s+SET/i,
      /SELECT/i,
    ]) {
      assert.match(source, statement);
    }
  });

  it("opens a database connection only in the repository", async () => {
    const files = (await jsFiles(EXAMS)).filter(
      (file) => file !== REPOSITORY && file !== "src/exams/exam.service.js",
    );
    assertNoneMatch(
      await readAll(files),
      /\b(query|getClient|pool)\s*\(/,
      "Only the repository queries, and only the service opens a transaction.",
    );

    // The service's exemption is exactly one thing: it orchestrates §13's two
    // transactions, and the transaction helper is the only database symbol it
    // may import.
    const service = stripCommentsAndStrings(await read("src/exams/exam.service.js"));
    assert.match(service, /withTransaction/, "the service does open transactions");
    assert.doesNotMatch(
      service,
      /\bquery\s*\(/,
      "but it must not run a query of its own",
    );
  });

  it("keeps req and res out of everything below the controller", async () => {
    const files = (await jsFiles(EXAMS)).filter(
      (file) =>
        !file.endsWith(".controller.js") &&
        !file.endsWith(".routes.js") &&
        !file.endsWith("-validation.middleware.js"),
    );
    assert.ok(files.length >= 6);
    assertNoneMatch(
      await readAll(files),
      /\breq\.|\bres\.(?:json|status|send)\b/,
      "§23: below the controller nothing knows it is serving HTTP.",
    );
  });

  it("wraps every endpoint in the central async wrapper", async () => {
    // An unwrapped async handler in Express 5 rejects into the void: the client
    // hangs rather than receiving §15's 500. Counted rather than merely matched,
    // so a seventh route cannot be added unwrapped.
    const routes = await read("src/exams/exam.routes.js");
    const handlers = routes.match(/asyncHandler\(/g) ?? [];
    assert.equal(handlers.length, 6, "§9's six endpoints, each wrapped");

    const verbs = stripComments(routes).match(/examRoutes\.(get|post|put|patch|delete)/g) ?? [];
    assert.equal(verbs.length, 6, "and no seventh route registered");
  });
});

describe("§5, §10 the score cannot come from anywhere but the grader", () => {
  it("grades in a module with no model, no database and no request", async () => {
    // The single most important rule in this file. §10: "Never calculate the
    // final score using Gemini." A grader that imports nothing cannot.
    const grader = await read("src/exams/grader.js");
    const code = stripComments(grader);

    assert.doesNotMatch(code, PROVIDER, "§10: the grader must not reach a model");
    assert.doesNotMatch(code, SQL, "nor run a query");
    assert.doesNotMatch(code, /\breq\b|\bres\b/, "nor see a request");

    // It imports exactly one thing: the configured pass threshold, as a default
    // for an injectable parameter. That is §10's "explicit and configurable"
    // rather than a dependency — and it is the only import, so the grader still
    // cannot reach a model, a database or a request even transitively.
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports, ["../config/env.js"]);

    // And it really is the grader: the assertions above would also pass on an
    // empty file.
    assert.match(grader, /export function gradeAttempt/);
    assert.match(grader, /selectedAnswer === /, "the comparison itself");
  });

  it("calls the grader from exactly one place, inside the transaction", async () => {
    // §13: the key that was marked against and the result that was stored must
    // be provably the same read. That holds only if grading happens between
    // BEGIN and COMMIT, so the call site is asserted positionally rather than
    // merely counted.
    const importers = Object.entries(await readAll(await jsFiles(SRC))).filter(
      ([, source]) => /from\s+["'].*grader\.js["']/.test(stripComments(source)),
    );
    assert.deepEqual(
      importers.map(([file]) => file),
      ["src/exams/exam.service.js"],
      "only the service may grade",
    );

    const service = stripComments(await read("src/exams/exam.service.js"));
    const calls = service.match(/gradeAttempt\(/g) ?? [];
    assert.equal(calls.length, 1, "§10: one call, so there is one place to audit");

    // The transaction opens, then the key is read, then grading happens, then
    // the attempt is completed — in that order, in that block.
    const transaction = service.slice(service.indexOf("withTransaction"));
    const keyAt = transaction.indexOf("findAnswerKey");
    const gradeAt = transaction.indexOf("gradeAttempt(");
    const completeAt = transaction.indexOf("completeAttempt");

    assert.ok(keyAt > 0, "the key is read inside the transaction");
    assert.ok(gradeAt > keyAt, "and grading follows the read");
    assert.ok(completeAt > gradeAt, "and the write follows the grading");
  });

  it("reads the key under a lock, in one function", async () => {
    const repository = await read(REPOSITORY);
    // Comments stripped first: the header explains the lock, and a rule that
    // counts its own documentation is a rule that fails on a correct file.
    const locking = stripComments(repository).match(/FOR SHARE/g) ?? [];
    assert.equal(locking.length, 1, "one locked read: the answer key");
    assert.match(
      repository,
      /export async function findAnswerKey\(client/,
      "and it takes the transaction's client, not a fresh connection",
    );
  });

  it("has no field through which a client could supply a mark", async () => {
    // §5 lists what must never be accepted as authoritative. The validation
    // layer builds each answer from two named properties, so those fields have
    // nowhere to arrive — which is stronger than filtering them out, because
    // there is no filter to forget to update.
    const middleware = stripComments(
      await read("src/exams/exam-validation.middleware.js"),
    );

    for (const forbidden of [
      /isCorrect/,
      /correctAnswer/,
      /\bpercentage\b/,
      /\bpassed\b/,
      /\bscore\b/,
    ]) {
      assert.doesNotMatch(
        middleware,
        forbidden,
        `§5: the request parser must not name ${forbidden.source}`,
      );
    }

    // The positive control: it does read the two fields a client may send.
    assert.match(middleware, /questionId/);
    assert.match(middleware, /\banswer\b/);
  });

  it("takes the pass threshold from config, in one place", async () => {
    // §10: "Pass threshold should be explicit and configurable. Do not hardcode
    // the threshold in multiple places."
    const sources = await readAll(await jsFiles(SRC));
    const hardcoded = Object.entries(sources)
      .filter(([file]) => file !== "src/config/env.js")
      .filter(([, source]) => /\b70\b/.test(stripComments(source)))
      .map(([file]) => file);
    assert.deepEqual(hardcoded, [], "the threshold is a config value, not a literal");

    // 70 appears exactly once in the tree: as the default of the environment
    // variable that carries it.
    assert.match(
      await read("src/config/env.js"),
      /passingPercentage:\s*int\("STUDYPAL_EXAM_PASSING_PERCENTAGE",\s*70\)/,
    );

    // The grader reads that default itself, and accepts an override — which is
    // what makes tests/exams/grading.test.js able to state a threshold instead
    // of depending on the deployment's. The comparison exists in one place.
    const grader = stripComments(await read("src/exams/grader.js"));
    assert.match(grader, /passingPercentage = config\.exam\.passingPercentage/);
    assert.equal(
      (grader.match(/passingPercentage/g) ?? []).length,
      3,
      "the parameter, its default and the one comparison — no fourth mention",
    );
  });
});

describe("§4, §9 the answer key cannot be selected by the taking path", () => {
  it("builds the taking column list without the key", async () => {
    // The structural half of §4. The behavioural half is in
    // tests/exams/api.test.js; this is the half that says no other query can
    // return it either, because the list the taking queries interpolate does not
    // contain the column name.
    const repository = await read(REPOSITORY);

    const taking = repository.match(
      /const QUESTION_COLUMNS_FOR_TAKING = `([\s\S]*?)`/,
    );
    assert.ok(taking, "the constant must still exist under this name");
    assert.doesNotMatch(
      taking[1],
      /correct_answer|explanation/,
      "§4: the taking column list must not name the key or the explanation",
    );
    assert.match(taking[1], /question_text/, "but must select the question");

    const withAnswers = repository.match(
      /const QUESTION_COLUMNS_WITH_ANSWERS = `([\s\S]*?)`/,
    );
    assert.ok(withAnswers, "and its counterpart must exist");
    assert.match(
      withAnswers[1],
      /correct_answer/,
      "the post-submission list does carry the key — otherwise the rule above is vacuous",
    );
  });

  it("selects the key in exactly the queries that need it", async () => {
    // Every appearance of the KEY column in the repository's code, named
    // individually. `correct_answers` — the count on exam_attempts — is a
    // different column, so the pattern is word-bounded to exclude it; and
    // comments are stripped, because the header names the column six times in
    // order to say which queries must not select it.
    const code = stripComments(await read(REPOSITORY));
    const mentions = code.match(/\bcorrect_answer\b(?!s)/g) ?? [];

    // Six, and each one is accounted for: the WITH_ANSWERS column list; the
    // INSERT's column list, its SELECT-from-values and the sub-select it writes
    // through; and the key read's SELECT plus the row mapping that renames it to
    // camelCase. A seventh means a new query touches the key.
    assert.equal(
      mentions.length,
      6,
      `the key is named ${mentions.length} times in code; each one is a place it could leak`,
    );

    // The insert has to write it, and the key read has to select it.
    assert.match(code, /INSERT INTO exam_questions[\s\S]*?correct_answer/);
    assert.match(code, /SELECT id, correct_answer/, "the grader's key read");

    // The with-answers list is used by exactly one query — the post-submission
    // read — and declared once.
    const withAnswersUses = code.match(/QUESTION_COLUMNS_WITH_ANSWERS/g) ?? [];
    assert.equal(withAnswersUses.length, 3, "declared, RETURNINGed, and selected once");

    // And the taking constant is used by the queries that serve an exam in
    // progress.
    const takingUses = code.match(/QUESTION_COLUMNS_FOR_TAKING/g) ?? [];
    assert.ok(takingUses.length >= 2, "declared and used at least once");
  });

  it("chooses between two repository functions rather than filtering a field", async () => {
    // §4 enforced by which query runs, not by deleting a key from an object
    // afterwards. A filter is one forgotten spread away from leaking; a query
    // that never selected the column cannot.
    const service = stripComments(await read("src/exams/exam.service.js"));

    assert.match(service, /findQuestionsForTaking/, "the in-progress path");
    assert.match(service, /findQuestionsWithAnswers/, "the completed path");
    assert.doesNotMatch(
      service,
      /delete\s+\w+\.correctAnswer|omit\(|\bstripKey\b/,
      "there must be no field-deleting step to forget",
    );
  });

  it("never sends the key to the client from the controller", async () => {
    const controller = stripComments(await read("src/exams/exam.controller.js"));
    assert.doesNotMatch(controller, SQL, "§23: no SQL in a controller");
    assert.doesNotMatch(controller, PROVIDER, "§23: no model call in a controller");
    assert.doesNotMatch(
      controller,
      /correct|isCorrect|percentage|score/i,
      "§23: and no grading vocabulary — it passes values through",
    );

    // The positive control: it is a controller, and it does respond.
    assert.match(controller, /res\.json|res\.status/);
    assert.match(controller, /req\.validated/, "every value comes from validation");
  });
});

describe("§7, §13 the model is called in one place, outside every transaction", () => {
  it("calls a provider from exactly one module in this feature", async () => {
    const files = (await jsFiles(EXAMS)).filter((file) => file !== GENERATOR);
    assert.ok(files.length >= 8);
    assertNoneMatch(
      await readAll(files),
      PROVIDER,
      "§23: generation is the generator's job, and nothing else in this feature may reach a model.",
      stripComments,
    );

    // And the generator does reach one, so the rule is not vacuous.
    assert.match(stripComments(await read(GENERATOR)), PROVIDER);
  });

  it("generates before it persists, and opens no transaction to do it", async () => {
    // §13: the provider call happens BEFORE BEGIN. A round trip inside a
    // transaction holds a connection for the length of a model call and turns a
    // slow provider into an exhausted pool.
    const generator = stripComments(await read(GENERATOR));
    assert.doesNotMatch(generator, /withTransaction|BEGIN/i, "the generator must not");
    assert.doesNotMatch(generator, SQL, "nor persist anything itself");

    const service = stripComments(await read("src/exams/exam.service.js"));
    const generateAt = service.indexOf("generateExam(");
    const transactionAt = service.indexOf("insertExamWithQuestions");
    assert.ok(generateAt > 0 && transactionAt > 0);
    assert.ok(
      generateAt < transactionAt,
      "§13: the model is called before the exam is written",
    );
  });

  it("validates before it persists, in a module that cannot persist", async () => {
    // §7: "Validate the entire AI response before persistence." The validator
    // has no database access at all, so validation cannot be interleaved with
    // writing.
    const validator = stripComments(await read("src/exams/exam-output.validator.js"));
    assert.doesNotMatch(validator, SQL);
    assert.doesNotMatch(validator, PROVIDER, "it judges output, it does not fetch it");
    assert.doesNotMatch(validator, /withTransaction/);

    const generator = stripComments(await read(GENERATOR));
    const validateAt = generator.indexOf("validateExamOutput(");
    const returnAt = generator.indexOf("return validated");
    assert.ok(validateAt > 0 && returnAt > validateAt, "nothing is returned unvalidated");
  });

  it("retries at most once, in one place, and only for bad output", async () => {
    // §8's retry, and the distinction that matters: unusable content is retried,
    // a provider failure is not. A retry on a 503 doubles the load on a provider
    // that is already failing.
    const generator = await read(GENERATOR);
    const code = stripComments(generator);

    assert.match(code, /config\.exam\.generationRetries/, "the bound is configured");
    assert.match(code, /throw internal\(.*AI_UNAVAILABLE|AI_UNAVAILABLE/, "provider failure");
    assert.match(code, /AI_INVALID_OUTPUT/, "and exhausted validation are distinct");

    // The catch around the provider call must rethrow rather than continue the
    // loop — otherwise a provider outage becomes two calls per request.
    const catchBlock = code.slice(code.indexOf("} catch"), code.indexOf("const validated"));
    assert.match(catchBlock, /throw /, "§8: a provider error is not retried");
    assert.doesNotMatch(catchBlock, /continue\b/);

    // One retry loop in the whole feature.
    const loops = (await readAll(await jsFiles(EXAMS)))["src/exams/exam-generator.js"];
    assert.equal((stripComments(loops).match(/maxAttempts/g) ?? []).length, 3);
  });

  it("gives the model no field through which to name a database row", async () => {
    // §7's schema, and the reason §14 resolves provenance in the service: the
    // model returns a 1-based source NUMBER that means nothing outside the
    // prompt, never a material id. If the schema had an id field, an invented
    // value would be a foreign key to someone else's document.
    const prompt = await read("src/ai/prompts/exam.prompt.js");
    const schema = stripComments(prompt);

    assert.doesNotMatch(
      schema,
      /materialId|material_id|chunkId|chunk_id|examId|exam_id|userId|user_id/,
      "§7: the response schema must contain no database identifier",
    );
    assert.match(schema, /sourceNumber/, "only a prompt-local source number");

    // And the service is what turns that number into an id, against the list it
    // was numbered from.
    const service = stripComments(await read("src/exams/exam.service.js"));
    assert.match(service, /resolveSource\(/);
  });
});

describe("§12 ownership is enforced where it cannot be forgotten", () => {
  it("names user_id only inside the repository", async () => {
    const files = (await jsFiles(EXAMS)).filter((file) => file !== REPOSITORY);
    assertNoneMatch(
      await readAll(files),
      /user_id/,
      "§12: ownership is a WHERE clause, so the column belongs to the repository.",
      stripComments,
    );
    assert.match(await read(REPOSITORY), /user_id/, "and it is enforced there");
  });

  it("has no exam or attempt lookup that can be called without a user", async () => {
    // The rule that makes §12 structural rather than a habit. Every finder in
    // this repository takes the owner, so there is no id-only variant for a
    // handler to reach for by mistake.
    const repository = await read(REPOSITORY);
    const finders =
      repository.match(/export async function (find\w+)\(([^)]*)\)/g) ?? [];
    assert.ok(finders.length >= 4, "the check must find the finders");

    for (const finder of finders) {
      const [, name, params] = finder.match(
        /export async function (find\w+)\(([\s\S]*)\)/,
      );
      // findQuestions* and findAnswerKey are scoped by an exam id whose
      // ownership the caller has already established — a question carries no
      // user of its own. Everything that names an exam or an attempt must.
      const scopedByExam = /^find(Questions|AnswerKey|Answers)/.test(name);
      if (scopedByExam) continue;
      assert.match(
        params,
        /userId/,
        `${name} must take the owner — §12 must not be forgettable`,
      );
    }
  });

  it("verifies the attempt belongs to the exam in the same lookup", async () => {
    // §9's sequence collapses "verify ownership" and "verify the attempt belongs
    // to this exam" into one query, so neither can be done without the other.
    const repository = await read(REPOSITORY);
    const owned = repository.match(
      /export async function findOwnedAttempt[\s\S]{0,700}?\n}/,
    );
    assert.ok(owned, "findOwnedAttempt must exist under this name");
    for (const clause of [/attemptId|\$1/, /exam_id/, /user_id/]) {
      assert.match(owned[0], clause);
    }
  });

  it("completes an attempt with a compare-and-set, not a bare update", async () => {
    // §11's immutability against a race. The pre-check gives a clean 409; this
    // is what makes it hold when two submissions arrive together.
    const repository = await read(REPOSITORY);
    const complete = repository.match(
      /export async function completeAttempt[\s\S]{0,1800}?\n}/,
    );
    assert.ok(complete, "completeAttempt must exist under this name");
    assert.match(complete[0], /status\s*=\s*'in_progress'/, "the compare");
    assert.match(complete[0], /user_id/, "scoped to the owner");
  });

  it("never returns a row straight from the database", async () => {
    // §20: camelCase, no raw rows. The shape functions are the boundary, and the
    // controller must not be able to bypass them.
    const service = await read("src/exams/exam.service.js");
    for (const shape of [
      /function toExamShape/,
      /function toQuestionShape/,
      /function toAttemptShape/,
      /function toResultShape/,
    ]) {
      assert.match(service, shape);
    }

    // Nothing outside the service imports the repository, so there is no path
    // from a controller to a raw row.
    const importers = Object.entries(await readAll(await jsFiles(SRC)))
      .filter(([, source]) =>
        /from\s+["'].*exam\.repository\.js["']/.test(stripComments(source)),
      )
      .map(([file]) => file);
    assert.deepEqual(importers, ["src/exams/exam.service.js"]);
  });

  it("returns a list as a bare array, like every other list here", async () => {
    /**
     * §20: "Follow the existing StudyPal response envelope. Do not create a
     * second response style."
     *
     * This rule exists because the code did not follow it. listAttempts returned
     * `{attempts: […]}` — a wrapper worn by exactly one endpoint in the whole
     * API, since /api/history, /api/materials and /api/study-plans all return
     * bare arrays. An envelope is not wrong in itself; being the only endpoint
     * that has one is what makes it a second style.
     *
     * Asserted against the service, which is where the shape is decided — the
     * controller only forwards it.
     */
    const service = await read("src/exams/exam.service.js");
    const list = service.match(
      /export async function listAttempts[\s\S]*?\n}/,
    );
    assert.ok(list, "listAttempts must exist under this name");
    assert.match(
      list[0],
      /return rows\.map\(/,
      "§20: a collection of resources is an array, not {key: […]}",
    );
    assert.doesNotMatch(list[0], /return\s*\{/, "§20: no object wrapper");
  });
});

describe("§6, §14 the generator does not reimplement RAG", () => {
  it("reuses the existing retrieval service and context builder", async () => {
    // §14: "Do not implement a new vector-search system here. Reuse SP-V2-004."
    // Asserted as imports, the only form of reuse that cannot quietly drift from
    // the original: a copied retrieval would keep passing if this were asserted
    // as behaviour. Material ownership comes from SP-V2-003's repository for the
    // same reason — §6's "do not bypass ownership checks" is satisfied by using
    // the query that already has the owner in its WHERE clause.
    const brief = stripComments(await read("src/exams/material-brief.js"));
    assert.match(brief, /from\s+"\.\.\/materials\/retrieval\.service\.js"/);
    assert.match(brief, /from\s+"\.\.\/materials\/context-builder\.js"/);
    assert.match(brief, /from\s+"\.\.\/materials\/material\.repository\.js"/);
  });

  it("contains no vector search of its own", async () => {
    /**
     * The other half of reuse: it is only real if there is no second
     * implementation beside it. A cosine computed here, a `<=>` operator, or a
     * direct call into the retrieval REPOSITORY would each be a parallel path
     * that could diverge on the threshold, the limit, or — worst — the ownership
     * predicate that keeps one learner's chunks out of another's exam.
     *
     * `interleave` in that file is duplicated from the study-plan brief, and this
     * rule is what separates the two cases: ordering a list is not retrieval, and
     * nothing above matches it.
     */
    const pattern =
      /<=>|\bcosine|dotProduct|Math\.sqrt|Math\.hypot|searchSimilarChunks|retrieval\.repository/i;
    assertNoneMatch(
      await readAll(await jsFiles(EXAMS)),
      pattern,
      "§14: vector search belongs to src/materials, and there is one of it.",
      stripComments,
    );

    // The anchor, and the reason this rule is not vacuous: the same pattern finds
    // the real implementation, so a green run means it was looking.
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
    // §14 again, stated over the provider: this feature must not construct its
    // own embedding call, because two callers using different task types would
    // put two different vector spaces in one column and similarity would quietly
    // stop meaning anything.
    assertNoneMatch(
      await readAll(await jsFiles(EXAMS)),
      /embedContent|batchEmbedContents|RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY/,
      "§14: embedding is src/ai/embedding.service.js's job.",
      stripComments,
    );
  });
});

describe("§18, §24 nothing out of scope crept in", () => {
  it("adds no external dependency", async () => {
    // §24: "Do not install new dependencies unless the current project genuinely
    // lacks something required." Checked as the set of external import
    // specifiers, which is exact — grepping for product names reports English
    // prose instead.
    //
    // `express` is the one, in exam.routes.js, and it was already a dependency
    // before this feature existed: a Router has to come from somewhere. Anything
    // else appearing in this list is a package SP-V2-006 introduced.
    const sources = await readAll(await jsFiles(EXAMS));
    const external = new Set();
    for (const source of Object.values(sources)) {
      for (const [, specifier] of stripComments(source).matchAll(
        /from\s+["']([^"']+)["']/g,
      )) {
        if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
          external.add(specifier);
        }
      }
    }
    assert.deepEqual(
      [...external].sort(),
      ["express"],
      "the exam feature reaches the provider and the database through existing modules",
    );

    // And the manifest agrees: no package was installed for this feature.
    const manifest = JSON.parse(await read("package.json"));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
      "@google/genai",
      "cors",
      "dotenv",
      "express",
      "multer",
      "pdf-parse",
      "pg",
    ]);
    assert.deepEqual(
      Object.keys(manifest.devDependencies ?? {}),
      [],
      "the test suite runs on node:test — §24 needs no test framework either",
    );
  });

  it("implements no analytics, and no weak-area detection", async () => {
    // §1: "Do not implement learning analytics or weak-area detection yet. That
    // belongs to SP-V2-007." The temptation is real — the data is right there.
    const sources = await readAll(await jsFiles(EXAMS));
    assertNoneMatch(
      sources,
      /weakArea|weak_area|proficiency|mastery|analytics|recommendation/i,
      "§1, §18: analytics belong to SP-V2-007, which will read this data rather than this code producing it.",
      stripComments,
    );
  });

  it("schedules nothing in process and queues nothing", async () => {
    // §19's excluded infrastructure. Generation is synchronous within the
    // request, which is the whole reason §13's transaction is simple.
    const sources = await readAll(await jsFiles(EXAMS));
    assertNoneMatch(
      sources,
      /setInterval|setTimeout|node-cron|bullmq|pg-boss|createClient\(|WebSocket/i,
      "§19: no queue, no scheduler, no socket.",
    );
  });

  it("declares no table of its own outside the migration", async () => {
    // §21: schema lives in migrations/postgres. The one exemption is the
    // migrator's own bookkeeping table, which cannot be created by a migration
    // because it is what records that migrations ran.
    const sources = await readAll(
      (await jsFiles(SRC)).filter((file) => file !== "src/db/migrator.js"),
    );
    assertNoneMatch(
      sources,
      /CREATE\s+TABLE/i,
      "§21: schema lives in migrations/postgres, never in application code.",
      stripComments,
    );
    assert.match(
      await read("src/db/migrator.js"),
      /CREATE TABLE IF NOT EXISTS schema_migrations/,
      "and the exemption is exactly that one table",
    );

    // And the migration that declares §4's four tables exists.
    const migration = await read("migrations/postgres/005_exams.sql");
    for (const table of ["exams", "exam_questions", "exam_attempts", "attempt_answers"]) {
      assert.match(
        migration,
        new RegExp(`CREATE TABLE ${table}\\b`),
        `§4's ${table}`,
      );
    }
  });

  it("leaves the older features independent of this one", async () => {
    // SP-V2-006 is additive. If materials or study plans imported from
    // src/exams, the exam feature could not be changed without re-testing them.
    const outside = (await jsFiles(SRC)).filter(
      (file) => !file.startsWith("src/exams/") && !file.startsWith("src/routes/"),
    );
    assertNoneMatch(
      await readAll(outside),
      /from\s+["'].*\/exams\//,
      "nothing outside the feature may import it, except the route table.",
      stripComments,
    );

    // The router is the one permitted seam, and it is how the endpoints exist.
    assert.match(
      stripComments(await read("src/routes/index.js")),
      /exams\/exam\.routes\.js/,
    );
  });

  it("logs no prompt, no material context and no model output", async () => {
    // §15, and the rule the study-plan suite states: what leaks a document is a
    // BINDING inside `${...}`, never the English around it. So the check is over
    // interpolations rather than over message text.
    const sources = await readAll(await jsFiles(EXAMS));
    const leaks = [];

    for (const [file, source] of Object.entries(sources)) {
      for (const [, call] of stripComments(source).matchAll(
        /logger\.\w+\(([\s\S]*?)\);/g,
      )) {
        for (const [, binding] of call.matchAll(/\$\{([^}]*)\}/g)) {
          if (/prompt|context|raw|response|answer|question|material|content/i.test(binding)) {
            leaks.push(`${file}: \${${binding.trim()}}`);
          }
        }
      }
    }
    assert.deepEqual(leaks, [], "§15: no document text, no prompt, no model output");

    // The positive control: this feature does log, so the pattern has something
    // to examine.
    const logging = Object.values(sources).filter((source) =>
      /logger\.\w+\(/.test(stripComments(source)),
    );
    assert.ok(logging.length >= 1, "the check must find at least one logger call");
  });
});

/** SQL lives in strings, so this check keeps them. */
function assertNoSqlIn(sources, why) {
  return assertNoneMatch(sources, SQL, why, stripComments);
}
