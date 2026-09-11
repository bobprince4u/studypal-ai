/**
 * The architecture checks, as tests rather than as a checklist someone runs by
 * hand. SP-V2-003 §27 and SP-V2-004 §46.
 *
 * Every assertion here reads the source tree and asserts a property of its SHAPE:
 * which layer may contain SQL, which module may touch the filesystem, which may
 * call a model, where ownership is enforced. None of it exercises behaviour — the
 * other suites do that — and that is the point. A layering rule that lives only in
 * a review comment is one refactor away from being gone, and the failure it permits
 * (a query in a controller, an `fs` call in a service, a model call on a path with
 * no evidence) is invisible in a green test run because the feature still works.
 *
 * The checks are deliberately textual and deliberately blunt. A real import graph
 * would be more precise and would need a parser; grepping for `node:fs` catches
 * the mistake a developer actually makes, which is writing `import fs from
 * "node:fs"` at the top of the wrong file.
 *
 * THE FAILURE MODE OF A CHECK LIKE THIS IS SILENCE
 * -----------------------------------------------
 * A textual check that stops matching does not fail — it passes, permanently, on
 * anything. Both hazards have been hit here in practice: a pattern run through a
 * stripper that deletes the very text it looks for (see `assertNoFilesystem`), and
 * a pattern too narrow for a real spelling (`node:fs/promises` slipped past the
 * first version of FILESYSTEM). So every rule below is paired with an assertion
 * that the pattern still matches something it *should* match — a controller count,
 * an allowlist entry, a reachable AI client. A green run here should mean the check
 * ran, not merely that it found nothing.
 *
 * WHERE A RULE IS VIOLATED ON PURPOSE
 * -----------------------------------
 * The exemptions are named individually rather than written as a loose pattern —
 * three files may touch the filesystem, each with its reason recorded next to it.
 * Naming them means adding a fourth requires editing this file, which is exactly
 * the review the rule is for.
 *
 * A RULE THAT CHANGED BETWEEN ITERATIONS
 * -------------------------------------
 * SP-V2-003 asserted that nothing under src/materials imported an AI client and
 * that the word "embedding" appeared nowhere in src/. SP-V2-004 delivers embeddings
 * and material chat, so both had to change. Neither was deleted: each is replaced
 * by a narrower rule that is harder to satisfy by accident, and the reasoning is
 * recorded at the describe block that replaced it rather than in a commit message.
 *
 *   node --test tests/materials/architecture.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { BACKEND_ROOT } from "../helpers/server-harness.mjs";

const SRC = path.join(BACKEND_ROOT, "src");

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

/** Read a set of files once, as { relativePath: source }. */
async function readAll(relativePaths) {
  const entries = await Promise.all(
    relativePaths.map(async (relative) => [
      relative,
      await fs.readFile(path.join(BACKEND_ROOT, relative), "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * Source with comments removed, strings intact.
 *
 * The default stripper for these checks. Comments have to go because this file's
 * rules are partly about vocabulary — a module header explaining why it contains
 * no SQL mentions SELECT, and text-chunker.js explains why it computes no
 * embeddings — and a rule that fires on its own documentation is a rule nobody
 * keeps.
 *
 * Strings deliberately STAY. In JavaScript every query is a string, so a stripper
 * that removed them would make `assertNoSql` pass on a file full of SQL: the check
 * would be perfectly green and completely empty. That mistake is easy to make and
 * invisible once made, which is why the two strippers are separate functions with
 * this note between them.
 *
 * Regex-based, so imprecise in the usual ways (an apostrophe in a comment, a `/`
 * that is division). It errs toward removing too little here, which can only
 * produce a failure a human then reads — never a silent pass.
 */
function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Source with comments AND strings removed.
 *
 * For rules about what the code DOES rather than what it contains: which modules
 * import `node:fs`, which touch `req`/`res`. Here a string is noise — an error
 * message reading "no file was uploaded" should not count as filesystem access.
 */
function stripCommentsAndStrings(source) {
  return stripComments(source)
    .replaceAll(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replaceAll(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replaceAll(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/**
 * Assert no file in `sources` matches `pattern`, reporting every offender.
 *
 * @param {Record<string, string>} sources
 * @param {RegExp} pattern
 * @param {string} why message shown on failure
 * @param {(source: string) => string} [strip] which stripper to apply
 */
function assertNoneMatch(sources, pattern, why, strip = stripCommentsAndStrings) {
  const offenders = Object.entries(sources)
    .filter(([, source]) => pattern.test(strip(source)))
    .map(([file]) => file);
  assert.deepEqual(offenders, [], `${why}\noffending files: ${offenders.join(", ")}`);
}

/** SQL lives in strings, so these checks keep them. */
const assertNoSql = (sources, why) => assertNoneMatch(sources, SQL, why, stripComments);

/**
 * So does an import specifier, so the filesystem checks keep strings too.
 *
 * `import fs from "node:fs"` puts the only evidence — the module name — inside a
 * string literal. Running FILESYSTEM through `stripCommentsAndStrings` leaves
 * `import fs from ""`, which matches nothing: the check would pass on a file that
 * imports `node:fs` on its first line. That is the same vacuity trap documented
 * above for SQL, and it is a separate helper for the same reason.
 */
const assertNoFilesystem = (sources, why) =>
  assertNoneMatch(sources, FILESYSTEM, why, stripComments);

// SQL a query would contain. Word-bounded and space-anchored so `selected` and a
// variable named `update` do not count.
const SQL =
  /\b(SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|JOIN\s)/i;
// Any route into the filesystem: static or dynamic import, `require`, bare or
// `node:`-prefixed, and the submodules (`node:fs/promises`). Written wide on
// purpose — an escape hatch this check misses is a check that does nothing.
const FILESYSTEM = /\b(?:from|import|require)\s*\(?\s*["'](?:node:)?fs["'/]/;

describe("§27 SQL stays in the repository layer", () => {
  it("no controller contains SQL", async () => {
    const files = (await jsFiles(SRC)).filter((file) => file.includes(".controller."));
    assert.ok(files.length >= 2, "the check must actually find controllers");
    assertNoSql(
      await readAll(files),
      "A controller with a query in it has skipped both the service and the repository.",
    );
  });

  it("no material module outside the repository contains SQL", async () => {
    const files = (await jsFiles(path.join(SRC, "materials"))).filter(
      (file) => !file.endsWith(".repository.js"),
    );
    assert.ok(files.length >= 7);
    assertNoSql(
      await readAll(files),
      "§3, §12: the repository is the only module in this feature that speaks SQL.",
    );
  });

  it("the material repository is where the material SQL actually is", async () => {
    // The complement of the rule above. Without this, deleting every query in the
    // feature would satisfy the check while breaking the product.
    const source = await fs.readFile(
      path.join(SRC, "materials", "material.repository.js"),
      "utf8",
    );
    for (const statement of [/INSERT\s+INTO\s+materials/i, /INSERT\s+INTO\s+material_chunks/i, /DELETE\s+FROM/i, /SELECT/i]) {
      assert.match(source, statement);
    }
  });

  it("no processing module contains SQL", async () => {
    // The extractor, normalizer and chunker are pure functions over text. A query
    // in one of them would mean the pipeline reaches around its own service.
    const files = [
      "src/materials/document-extractor.js",
      "src/materials/text-normalizer.js",
      "src/materials/text-chunker.js",
      "src/materials/file-validation.js",
    ];
    assertNoSql(await readAll(files), "§27: no SQL in document extraction modules.");
  });

  it("no service outside the known SP-V2-002 exception contains SQL", async () => {
    /**
     * src/services/question.service.js holds one inline `INSERT INTO users …
     * ON CONFLICT` so that the user upsert and the question insert share a single
     * transaction. It predates this iteration, §19 forbids changing /api/ask's
     * behaviour, and it is reported as SP-V2-002 technical debt rather than
     * silently permitted: the fix is an optional executor argument on
     * user.repository.upsert, which belongs to whichever iteration touches that
     * endpoint next.
     *
     * Naming it here is the point. The rule still holds for every other service —
     * including all of this iteration's — and a NEW service carrying SQL fails
     * this test, which is what §3's "do not reintroduce ad-hoc SQL in
     * controllers/services" needs to mean in practice.
     */
    const KNOWN_EXCEPTION = "src/services/question.service.js";
    const files = (await jsFiles(SRC)).filter(
      (file) => /\.service\./.test(file) && file !== KNOWN_EXCEPTION,
    );
    assert.ok(files.length >= 3);
    assertNoSql(
      await readAll(files),
      "Services orchestrate; repositories own SQL (§3).",
    );

    // And the exception is exactly one statement, so it cannot quietly grow.
    const exception = stripComments(
      await fs.readFile(path.join(BACKEND_ROOT, KNOWN_EXCEPTION), "utf8"),
    );
    assert.deepEqual(exception.match(/\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)/gi), [
      "INSERT INTO",
    ]);
  });

  it("no material module but the repository opens a database connection", async () => {
    const files = (await jsFiles(path.join(SRC, "materials"))).filter(
      (file) => !file.endsWith(".repository.js"),
    );
    assertNoneMatch(
      await readAll(files),
      /config\/database\.js/,
      "Only the repository may hold a connection (§3's route→controller→service→repository→PostgreSQL).",
    );
  });
});

describe("§27 filesystem access stays in the storage layer", () => {
  /**
   * Every file allowed to reach the filesystem, named individually with its reason.
   *
   * The rule §7 and §27 actually state is that filesystem operations must not be
   * *scattered* through the request path — controllers, services and the document
   * modules go through the storage abstraction or not at all. One of these three is
   * that abstraction; the other two are startup-time infrastructure that predates
   * SP-V2-003 and reads files that are part of the program, not part of a request.
   *
   * src/config/env.js is deliberately NOT here. It resolves the storage directory,
   * which needs `node:path`, not `node:fs`: reading configuration creates no
   * directory and touches no file, and the check below would fail if that changed.
   */
  const ALLOWED = {
    "src/storage/local-storage.service.js": "the storage abstraction §7 asks for",
    "src/utils/version.js": "reads package.json once, for /health's version field",
    "src/db/migrator.js": "reads the migration .sql files — that is its whole job",
  };

  it("no module outside the storage layer touches the filesystem", async () => {
    const files = (await jsFiles(SRC)).filter((file) => !(file in ALLOWED));
    assertNoFilesystem(
      await readAll(files),
      `Only these may touch the filesystem (§7, §27):\n${Object.entries(ALLOWED)
        .map(([file, why]) => `  ${file} — ${why}`)
        .join("\n")}`,
    );
  });

  it("every allowed file still imports fs, so the allowlist stays honest", async () => {
    // An allowlist is the one place a stale entry costs nothing and hides
    // something: a file that stopped using `fs` should lose its exemption rather
    // than keep a standing permission nobody notices. This also anchors the
    // pattern — if FILESYSTEM stopped matching a real import, as it silently did
    // for `node:fs/promises`, all four of these fail instead of the suite going
    // quietly green on a codebase full of unchecked filesystem access.
    for (const [file, why] of Object.entries(ALLOWED)) {
      const source = await fs.readFile(path.join(BACKEND_ROOT, file), "utf8");
      assert.match(
        stripComments(source),
        FILESYSTEM,
        `${file} no longer imports fs (${why}) — drop it from ALLOWED.`,
      );
    }
  });

  it("no controller touches the filesystem", async () => {
    // Implied by the check above, asserted separately because §27 names it
    // separately and because a controller is where this mistake is most tempting.
    const files = (await jsFiles(SRC)).filter((file) => file.includes(".controller."));
    assert.ok(files.length >= 2, "the check must actually find controllers");
    assertNoFilesystem(await readAll(files), "§27: no filesystem operations in controllers.");
  });

  it("no document-processing module touches the filesystem", async () => {
    // §12: the extractor, normalizer and chunker take bytes and return data. A
    // path or a read anywhere in here means the pipeline can no longer be tested
    // without a disk, and §7's abstraction has been bypassed.
    const files = await jsFiles(path.join(SRC, "materials"));
    assert.ok(files.length >= 6, "the check must actually find the pipeline");
    assertNoFilesystem(
      await readAll(files),
      "§12: document processing operates on buffers, not on the filesystem.",
    );
  });

  it("the storage service is the only place that writes files", async () => {
    const source = await fs.readFile(
      path.join(SRC, "storage", "local-storage.service.js"),
      "utf8",
    );
    // It must actually be doing the work the other modules are forbidden from
    // doing — otherwise the rule above would be satisfied by a codebase that
    // writes no files at all, which would pass while the feature was broken.
    assert.match(source, /writeFile/);
    assert.match(source, /\brm\b|unlink/);
  });
});

describe("§31, §46 the AI dependency enters through exactly one door", () => {
  /**
   * SP-V2-003 asserted that NOTHING under src/materials touched an AI client. That
   * rule is gone, because SP-V2-004 deliberately breaks it: retrieval embeds a
   * query and chat calls a model, both from src/materials.
   *
   * It is replaced by two narrower rules that are harder to satisfy accidentally,
   * so this is a tightening rather than a relaxation:
   *
   *   • the DETERMINISTIC modules below stay AI-free — the property that made
   *     SP-V2-003's pipeline testable offline is preserved exactly where it
   *     mattered, rather than being traded away for the whole directory;
   *   • the provider SDK is imported in exactly ONE file in the entire tree, so
   *     every AI call in the feature goes through src/ai/ (§31).
   *
   * Nothing that used to be checked has become unchecked: extraction, chunking,
   * normalisation, validation, storage, context building and source mapping are all
   * still forbidden from reaching a provider, and the SDK rule now covers files
   * SP-V2-003's version never looked at.
   */
  const DETERMINISTIC = [
    "src/materials/document-extractor.js",
    "src/materials/text-normalizer.js",
    "src/materials/text-chunker.js",
    "src/materials/file-validation.js",
    "src/materials/material-processing.service.js",
    "src/materials/material-upload.middleware.js",
    // Both of these handle retrieved text on the way to a prompt and neither may
    // call anything: a builder that could reach a provider is a builder that could
    // be tested only with one.
    "src/materials/context-builder.js",
    "src/materials/source-mapper.js",
    "src/storage/local-storage.service.js",
  ];

  // Comments stay OUT and strings stay IN, for the reason `assertNoFilesystem`
  // documents: an import specifier is a string literal, so stripping strings would
  // reduce `import … from "../ai/embedding.service.js"` to `import … from ""` and
  // make every rule below vacuous.
  const AI_DEPENDENCY =
    /@google\/genai|GoogleGenAI|\/ai\/|\bembedContent|\bembedQuery|\bembedDocuments|\bgenerateJsonContent|GEMINI_API_KEY/;
  const PROVIDER_SDK = /@google\/genai|GoogleGenAI/;

  it("keeps the deterministic document modules free of any AI dependency", async () => {
    const present = await jsFiles(SRC);
    for (const file of DETERMINISTIC) {
      assert.ok(present.includes(file), `${file} was renamed or removed — fix DETERMINISTIC`);
    }
    assertNoneMatch(
      await readAll(DETERMINISTIC),
      AI_DEPENDENCY,
      "§13, §46: extraction, chunking, storage, context building and source mapping " +
        "must run with no provider, no credential and no network.",
      stripComments,
    );
  });

  it("still matches the modules that legitimately do use AI, so the rule is not vacuous", async () => {
    // The anchor. A pattern that stopped matching anything would leave the rule
    // above permanently green on a codebase that had moved the SDK into the
    // chunker. Each of these SHOULD match, and does so through a different
    // spelling — an import path, a client function, a service function.
    for (const file of [
      "src/ai/gemini.client.js",
      "src/ai/embedding.service.js",
      "src/materials/material-indexing.service.js",
      "src/materials/retrieval.service.js",
      "src/materials/material-chat.service.js",
    ]) {
      const source = await fs.readFile(path.join(BACKEND_ROOT, file), "utf8");
      assert.match(
        stripComments(source),
        AI_DEPENDENCY,
        `${file} should depend on the AI layer — AI_DEPENDENCY no longer matches it`,
      );
    }
  });

  it("imports the provider SDK in exactly one file", async () => {
    // §31: "do not instantiate GoogleGenAI directly in controllers, repositories,
    // retrieval modules", "do not create duplicate Gemini clients". Both are the
    // same statement — there is one client, and this is it.
    //
    // An equality against a NON-EMPTY list, which is what makes this check
    // self-anchoring: it fails if a second file imports the SDK, and it also fails
    // if the one legitimate importer stops doing so.
    const importers = Object.entries(await readAll(await jsFiles(SRC)))
      .filter(([, source]) => PROVIDER_SDK.test(stripComments(source)))
      .map(([file]) => file);
    assert.deepEqual(importers, ["src/ai/gemini.client.js"]);
  });

  it("keeps the provider SDK out of every repository and controller", async () => {
    // §27, §46, stated over the layers rather than over one directory: a repository
    // that could embed text, or a controller that could generate, has bypassed the
    // service that owns the decision of whether to spend a provider call at all.
    const files = (await jsFiles(SRC)).filter(
      (file) => /\.repository\.|\.controller\./.test(file),
    );
    assert.ok(files.length >= 6, "the check must actually find repositories and controllers");
    assertNoneMatch(
      await readAll(files),
      AI_DEPENDENCY,
      "§46: repositories speak SQL and controllers speak HTTP. Neither calls a model.",
      stripComments,
    );
  });

  it("keeps vector arithmetic out of controllers and services", async () => {
    // §11 and §46: the DATABASE computes similarity. A cosine implemented in a
    // controller means chunks were loaded into Node to be scored there, which is
    // the exact design §11 forbids — and it would also silently ignore the
    // threshold and the LIMIT that make the result set bounded.
    const files = (await jsFiles(SRC)).filter(
      (file) => /\.controller\.|\.service\./.test(file),
    );
    assert.ok(files.length >= 8);
    assertNoneMatch(
      await readAll(files),
      /<=>|\bcosine|dotProduct|Math\.sqrt|Math\.hypot/i,
      "§11, §46: similarity is computed in SQL, and vector maths lives in src/utils/vector.js.",
      stripComments,
    );
  });

  it("computes vectors where it is supposed to, so that rule is not vacuous", async () => {
    // The complement: the arithmetic has to exist somewhere, and the two places it
    // is allowed are the normalisation helper and the retrieval SQL.
    assert.match(
      await fs.readFile(path.join(SRC, "utils", "vector.js"), "utf8"),
      /Math\.sqrt/,
    );
    assert.match(
      await fs.readFile(path.join(SRC, "materials", "retrieval.repository.js"), "utf8"),
      /<=>/,
    );
  });
});

describe("§15, §16, §46 retrieval cannot cross a user boundary", () => {
  const RETRIEVAL_REPOSITORY = path.join(SRC, "materials", "retrieval.repository.js");

  it("puts the ownership predicate in the SQL", async () => {
    // §15: "the ownership constraint should be part of the SQL query". Not a
    // parameter a caller remembers to pass through, not a check a service performs
    // first — a WHERE clause, so there is no code path that reaches a chunk row
    // belonging to another user, including one a future refactor adds.
    const sql = stripComments(await fs.readFile(RETRIEVAL_REPOSITORY, "utf8"));
    assert.match(sql, /WHERE\s+m\.user_id\s*=\s*\$1/);

    // One SELECT in the file, so there is no second, unscoped query hiding behind
    // the scoped one. A vector search that forgot the join condition would be
    // undetectable in its results — it would simply return other people's
    // documents, correctly ordered.
    assert.equal((sql.match(/\bSELECT\b/gi) ?? []).length, 1);
  });

  it("has no retrieval function that can be called without a user", async () => {
    const sql = stripComments(await fs.readFile(RETRIEVAL_REPOSITORY, "utf8"));
    assert.deepEqual(sql.match(/export\s+(?:async\s+)?function\s+(\w+)/g), [
      "export async function searchSimilarChunks",
    ]);
    // §16's "do not trust client-provided user IDs" needs somewhere for the
    // trusted one to enter: the parameter is destructured, so a call omitting it
    // passes `undefined` to a bigint parameter and the query errors rather than
    // matching every row.
    assert.match(sql, /searchSimilarChunks\(\{\s*userId,/);

    // And every call site in the tree supplies it.
    const callers = Object.entries(await readAll(await jsFiles(SRC))).flatMap(
      ([file, source]) =>
        [...stripComments(source).matchAll(/searchSimilarChunks\(([\s\S]{0,120})/g)].map(
          (match) => [file, match[1]],
        ),
    );
    // Two: the definition and the one caller. Fewer means the pattern broke.
    assert.ok(callers.length >= 2, "the check must actually find the call sites");
    for (const [file, args] of callers) {
      assert.match(args, /userId/, `${file} calls searchSimilarChunks without a user id`);
    }
  });

  it("names the user_id column only inside the repository layer", async () => {
    /**
     * §15's "do not retrieve globally then filter in JavaScript", expressed as the
     * strongest form the codebase can actually hold: nothing above the repository
     * layer so much as MENTIONS the column. A service that never sees `user_id`
     * cannot filter on it after the fact, cannot forget to, and cannot be given a
     * client-supplied value for it.
     *
     * Ownership still reaches the repository, as the resolved camelCase `userId`
     * argument — which is why this rule can be this absolute without making the
     * feature impossible to write.
     */
    const files = await jsFiles(path.join(SRC, "materials"));
    const mentions = Object.entries(await readAll(files))
      .filter(([, source]) => /user_id/.test(stripComments(source)))
      .map(([file]) => file)
      .sort();
    assert.deepEqual(mentions, [
      "src/materials/material.repository.js",
      "src/materials/retrieval.repository.js",
    ]);
  });

  it("reads no file and holds no connection outside the repository", async () => {
    // §46 names both for the retrieval path specifically. The filesystem rule is
    // already asserted tree-wide above; this states it where the spec states it,
    // and adds the connection rule that the SP-V2-003 check applies to materials.
    const files = ["src/materials/retrieval.service.js", "src/materials/context-builder.js"];
    assertNoFilesystem(await readAll(files), "§46: retrieval does not touch the filesystem.");
    assertNoneMatch(
      await readAll(files),
      /config\/database\.js/,
      "§46: only the repository opens a database connection.",
      stripComments,
    );
  });
});

describe("§21, §24, §41 the grounding guarantees are structural", () => {
  const CHAT_SERVICE = path.join(SRC, "materials", "material-chat.service.js");

  it("cannot reach the model on the no-evidence path", async () => {
    /**
     * §21 and §46's "no Gemini call when there is no relevant evidence", checked as
     * an ORDERING in the source rather than only as behaviour.
     *
     * tests/materials/chat.test.js asserts the same property the honest way, by
     * counting provider requests. This is the cheap structural companion: the guard
     * must come before the only generation call in the file, and must return. A
     * refactor that moved the call above the guard would still pass every behavioural
     * test that happens to retrieve something, and would quietly start answering
     * unfounded questions from the model's general knowledge.
     *
     * `generateJsonContent(` with the paren matches the CALL, not the import — the
     * import spells it `generateJsonContent }`.
     */
    const source = stripComments(await fs.readFile(CHAT_SERVICE, "utf8"));

    const guard = source.indexOf("chunks.length === 0");
    const call = source.indexOf("generateJsonContent(");
    assert.ok(guard > 0, "the no-evidence guard is gone or was renamed");
    assert.ok(call > 0, "the generation call is gone or was renamed");
    assert.ok(guard < call, "§21: the empty-retrieval guard must precede the model call");

    // Precede it AND return from it. A guard that only logged would satisfy an
    // ordering check while changing nothing. Any `return` in this span is the
    // guard's — nothing else between the guard and the call returns — and what it
    // returns is asserted behaviourally in tests/materials/chat.test.js. Matching
    // the statement rather than an object literal keeps the check about the
    // control flow, which is the part that must not change.
    assert.match(source.slice(guard, call), /\breturn\b/);

    // One generation call, so the guard cannot be bypassed by a second path.
    assert.equal((source.match(/generateJsonContent\(/g) ?? []).length, 1);
  });

  it("gives the model no field through which to name a source", async () => {
    // §23, §24: the backend owns source identity. The response schema is where that
    // is enforced, and it is enforced by ABSENCE — there is no `filename`,
    // `pageNumber` or `materialId` key for a model to fill in, so there is nothing
    // to validate, sanitise, or accidentally trust.
    const { MATERIAL_CHAT_RESPONSE_SCHEMA } = await import(
      "../../src/ai/prompts/material-chat.prompt.js"
    );
    assert.deepEqual(Object.keys(MATERIAL_CHAT_RESPONSE_SCHEMA.properties).sort(), [
      "answer",
      "sourceIndexes",
    ]);
    assert.equal(MATERIAL_CHAT_RESPONSE_SCHEMA.properties.sourceIndexes.items.type, "integer");
  });

  it("does not hold a transaction across a provider call", async () => {
    /**
     * §41. The indexing service is the only module that both writes vectors and
     * calls a provider, so it is the only place this can go wrong, and the shape
     * that keeps it right is visible in the source: the embed call sits between two
     * repository calls, not inside one.
     *
     * Checked as an ordering because the alternative — a transaction wrapping the
     * provider call — would work perfectly in every test and only show up in
     * production as pool exhaustion under load.
     */
    const source = stripComments(
      await fs.readFile(path.join(SRC, "materials", "material-indexing.service.js"), "utf8"),
    );
    const embed = source.indexOf("embedDocuments(");
    const persist = source.indexOf("saveEmbeddingsAndMarkIndexed(");
    assert.ok(embed > 0 && persist > 0);
    assert.ok(embed < persist, "embed first, then persist in one short transaction");

    // The service itself must not open a transaction at all — withTransaction lives
    // in the repository, around the write only.
    assert.doesNotMatch(source, /withTransaction/);
    assert.match(
      stripComments(
        await fs.readFile(path.join(SRC, "materials", "embedding.repository.js"), "utf8"),
      ),
      /withTransaction/,
    );
  });
});

describe("§45, §46 no deferred infrastructure crept in", () => {
  /**
   * Everything §2 and §45 exclude, checked against BOTH the source and the
   * dependency list.
   *
   * The source check catches a hand-rolled version; the dependency check catches
   * an installed one. Either alone would miss the other.
   *
   * WHAT LEFT THIS LIST, AND WHY THAT IS NOT A WEAKENING
   * ----------------------------------------------------
   * SP-V2-003 forbade `pgvector|vector\(|embedding` anywhere in src/, because that
   * iteration deferred embeddings to this one. Delivering them means that entry had
   * to go — it is the feature. It is replaced by the test below, which asserts the
   * vector support this iteration DOES use is pgvector inside PostgreSQL and
   * nothing else, so "no vector database" (§45) is still checked; the vector and
   * search SERVICES stay forbidden below, untouched.
   */
  const FORBIDDEN = [
    { label: "Redis", pattern: /\bredis\b|ioredis/i },
    { label: "a queue or worker framework", pattern: /bullmq|pg-boss|\bkafka\b|amqp|celery|sqs/i },
    { label: "cloud object storage", pattern: /aws-sdk|@aws-sdk|s3client|\bgcs\b|azure-storage/i },
    { label: "an authentication library", pattern: /jsonwebtoken|passport|bcrypt|argon2|express-session/i },
    { label: "a vector or search service", pattern: /pinecone|weaviate|qdrant|chromadb|milvus|elasticsearch|opensearch/i },
    // §5, §45: one AI provider. A second embedding provider would also mean a second
    // vector space in one column, which no amount of care downstream can untangle.
    { label: "a second AI SDK", pattern: /\bopenai\b|@anthropic-ai|@mistralai|\bcohere\b|huggingface|langchain|llamaindex|@ai-sdk/i },
    // §45: no ORM and no second database client.
    { label: "an ORM or query builder", pattern: /sequelize|typeorm|\bprisma\b|\bknex\b|drizzle|mikro-orm|objection/i },
  ];

  it("appears nowhere in src/", async () => {
    const sources = await readAll(await jsFiles(SRC));
    // The one real vacuity risk for a check shaped like this is a walker that
    // returns nothing — every pattern then matches nothing, and the suite is green
    // on an empty set.
    assert.ok(Object.keys(sources).length >= 25, "the check must actually read the source tree");

    for (const { label, pattern } of FORBIDDEN) {
      const offenders = Object.entries(sources)
        // Comments stripped: several modules explain at length what they
        // deliberately do NOT use, and a rule that fires on the documentation of
        // its own deferral is a rule that gets deleted rather than kept.
        .filter(([, source]) => pattern.test(stripComments(source)))
        .map(([file]) => file);
      assert.deepEqual(offenders, [], `${label} must not appear in src/ (§2, §45)`);
    }
  });

  it("appears in no dependency", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(BACKEND_ROOT, "package.json"), "utf8"),
    );
    const installed = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    assert.ok(installed.length >= 5, "the check must actually read the manifest");
    for (const { label, pattern } of FORBIDDEN) {
      const offenders = installed.filter((name) => pattern.test(name));
      assert.deepEqual(offenders, [], `${label} must not be installed (§45)`);
    }
  });

  it("gets its vector support from pgvector inside PostgreSQL", async () => {
    /**
     * The replacement for SP-V2-003's blanket embedding ban, and the reason
     * removing it was safe. §45's "no vector database" is not satisfied by the
     * absence of the word "embedding" — it is satisfied by embeddings living in a
     * `vector` column of the database that already holds the chunks, reached
     * through the one `pg` client, by a migration in the existing runner.
     *
     * All three claims are asserted, so adopting a vector service later would have
     * to change this test rather than slip past it.
     */
    const dir = path.join(BACKEND_ROOT, "migrations", "postgres");
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    const sql = (
      await Promise.all(names.map((name) => fs.readFile(path.join(dir, name), "utf8")))
    ).join("\n");

    assert.match(sql, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector\b/i);
    assert.match(sql, /\bembedding\s+vector\(\d+\)/i);

    // And nothing but `pg` talks to it.
    const manifest = JSON.parse(
      await fs.readFile(path.join(BACKEND_ROOT, "package.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(manifest.dependencies).filter((name) => /^(pg|mysql2?|mongodb|mongoose|better-sqlite3|sqlite3)$/.test(name)),
      ["pg"],
    );
  });

  it("keeps SQLite out of the runtime", async () => {
    // §3: PostgreSQL is authoritative and SQLite must not come back — not as a
    // dependency, not as a repository, not as a fallback in a test.
    const manifest = JSON.parse(
      await fs.readFile(path.join(BACKEND_ROOT, "package.json"), "utf8"),
    );
    const installed = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    assert.deepEqual(
      installed.filter((name) => /sqlite/i.test(name)),
      [],
    );
    assertNoneMatch(
      await readAll(await jsFiles(SRC)),
      /better-sqlite3|sqlite3|\.sqlite\b/i,
      "§3: do not reintroduce SQLite.",
    );
  });

  it("declares exactly one users table across all migrations", async () => {
    // §6: "Do not create a second users table." A second one would divide
    // ownership between two identities and silently break every ownership check.
    const dir = path.join(BACKEND_ROOT, "migrations", "postgres");
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    let creations = 0;
    for (const name of files) {
      const sql = await fs.readFile(path.join(dir, name), "utf8");
      // Anchored to the table being CREATED. `CREATE TABLE[^;]*users` would also
      // match `CREATE TABLE materials ( … REFERENCES users (id) )`, i.e. every
      // correct foreign key would count as a duplicate table.
      creations += (sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?users\b/gi) ?? [])
        .length;
    }
    assert.equal(creations, 1, `expected one users table across ${files.join(", ")}`);
  });
});

describe("§19 /api/ask is untouched by the material pipeline", () => {
  it("only the two modules allowed to may import a material module", async () => {
    // The direction of the dependency is the whole of §19's protection. Materials
    // may not reach into /api/ask's behaviour, and /api/ask must not start
    // depending on materials — "do not make /api/ask depend on material IDs yet".
    //
    // The specifier pattern tolerates a DOT in the basename. It did not until
    // SP-V2-005, and `[a-z-]+` cannot match `material.repository.js` or
    // `retrieval.service.js` — so for two tickets this rule could only have
    // caught an import of the one hyphenated module, `context-builder.js`, and
    // silently permitted every other. Widening it is what turns the list below
    // from an exemption for one filename into a real allowlist.
    const files = (await jsFiles(SRC)).filter(
      (file) => !file.startsWith("src/materials/") && !file.startsWith("src/storage/"),
    );
    const importers = Object.entries(await readAll(files))
      .filter(([, source]) =>
        /["'][^"']*materials\/[a-z.-]+\.js["']/.test(stripComments(source)),
      )
      .map(([file]) => file);

    // Exact rather than empty, and self-anchoring in both directions: a new
    // importer fails here, and so does either of these two ceasing to import,
    // which would mean the reuse SP-V2-005 §15 requires had been replaced by a
    // second copy of retrieval.
    assert.deepEqual(importers, [
      // The route table must mount the router; that is how the feature is reachable.
      "src/routes/index.js",
      // SP-V2-005 §15: "do not turn the study-plan generator into a second RAG
      // implementation. Reuse: embedding provider, retrieval service, context
      // builder." This is the single module that does, and
      // tests/study-plans/architecture.test.js states what it may reach for and
      // asserts that no vector search of its own accompanies it.
      "src/study-plans/material-brief.js",
    ]);
  });

  it("keeps its own upload middleware and extension logic", async () => {
    // Two upload paths with different allowlists, as material-upload.middleware.js
    // explains at length. If the material middleware ever imported /api/ask's, one
    // endpoint's rules would silently govern the other's. Comments stripped — that
    // file's header names the other one in order to explain the separation.
    const materialMiddleware = stripComments(
      await fs.readFile(path.join(SRC, "materials", "material-upload.middleware.js"), "utf8"),
    );
    assert.doesNotMatch(materialMiddleware, /middleware\/upload\.js/);
    assert.doesNotMatch(
      stripComments(await fs.readFile(path.join(SRC, "middleware", "upload.js"), "utf8")),
      /materials\//,
    );
  });
});

describe("the material layer is actually layered", () => {
  it("has one module per responsibility", async () => {
    // §12 and SP-V2-004 §3 ask for separation of concerns, and this is the cheapest
    // statement of it: the files exist and are separate. A single 800-line
    // material.service.js would pass every other check in this file.
    const present = await jsFiles(SRC);
    for (const expected of [
      // SP-V2-003: upload, processing, extraction.
      "src/materials/material.routes.js",
      "src/materials/material.controller.js",
      "src/materials/material.service.js",
      "src/materials/material.repository.js",
      "src/materials/material-processing.service.js",
      "src/materials/document-extractor.js",
      "src/materials/text-normalizer.js",
      "src/materials/text-chunker.js",
      // SP-V2-004: embedding, retrieval, chat. Each of these is a separate file
      // because each is separately testable — the context builder and the source
      // mapper are pure functions, retrieval needs a database but no model, and only
      // the chat service needs both.
      "src/materials/material-chat.controller.js",
      "src/materials/material-chat.service.js",
      "src/materials/material-indexing.service.js",
      "src/materials/retrieval.service.js",
      "src/materials/retrieval.repository.js",
      "src/materials/embedding.repository.js",
      "src/materials/context-builder.js",
      "src/materials/source-mapper.js",
      // The provider abstraction (§6) and the prompt (§19) live outside
      // src/materials, so the feature depends on an interface rather than on Google.
      "src/ai/embedding.service.js",
      "src/ai/gemini.client.js",
      "src/ai/prompts/material-chat.prompt.js",
      // Vector validation is shared by src/ai and src/materials, so it belongs to
      // neither — putting it in either would make one import the other.
      "src/utils/vector.js",
    ]) {
      assert.ok(present.includes(expected), `missing ${expected}`);
    }
  });

  it("keeps req and res out of everything below the controller", async () => {
    // A service that reads `req.query` or calls `res.json` cannot be called from
    // anywhere else, which is the practical cost of leaking HTTP downward.
    const files = (await jsFiles(path.join(SRC, "materials"))).filter(
      (file) => !/\.controller\.|\.routes\.|\.middleware\./.test(file),
    );
    assertNoneMatch(
      await readAll(files),
      /\breq\.(body|query|params|file)\b|\bres\.(json|status|send)\b/,
      "Services, repositories and processing modules must not know about HTTP.",
    );
  });

  it("routes the material endpoints through the central async wrapper", async () => {
    // Without asyncHandler a rejected promise becomes an unhandled rejection
    // rather than the JSON error §20 requires. Six now: SP-V2-003's five plus
    // POST /api/materials/chat, which needs it most — it is the one handler that
    // awaits two network calls.
    const routes = await fs.readFile(
      path.join(SRC, "materials", "material.routes.js"),
      "utf8",
    );
    const handlers = routes.match(/asyncHandler\(/g) ?? [];
    assert.equal(handlers.length, 6, "all six material endpoints must be wrapped");
  });
});
