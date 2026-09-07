/**
 * §27's architecture checks, as tests rather than as a checklist someone runs by
 * hand.
 *
 * Every assertion here reads the source tree and asserts a property of its SHAPE:
 * which layer may contain SQL, which module may touch the filesystem, what the
 * material pipeline may import. None of it exercises behaviour — the other suites
 * do that — and that is the point. A layering rule that lives only in a review
 * comment is one refactor away from being gone, and the failure it permits (a
 * query in a controller, an `fs` call in a service) is invisible in a green test
 * run because the feature still works.
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

describe("§27 the material pipeline has no AI dependency", () => {
  it("nothing under src/materials or src/storage imports a Gemini client", async () => {
    const files = [...(await jsFiles(path.join(SRC, "materials"))), ...(await jsFiles(path.join(SRC, "storage")))];
    assert.ok(files.length >= 8, "the check must actually find the pipeline");
    assertNoneMatch(
      await readAll(files),
      /@google\/genai|GoogleGenAI|generateContent|GEMINI_API_KEY/,
      "§12: no Gemini dependency anywhere in this processing pipeline. Processing is deterministic (§13).",
    );
  });

  it("the AI client is still reachable from the question path, so the check is not vacuous", async () => {
    // The rule above forbids an import. If nothing in the codebase imported the
    // SDK at all — because it had been removed, or renamed — the rule would pass
    // while meaning nothing. This anchors it.
    const files = await jsFiles(SRC);
    const importers = Object.entries(await readAll(files))
      .filter(([, source]) => /@google\/genai/.test(source))
      .map(([file]) => file);
    assert.ok(importers.length > 0, "the Gemini SDK should still be used by /api/ask");
    assert.equal(
      importers.some((file) => file.startsWith("src/materials/")),
      false,
    );
  });
});

describe("§27 no deferred infrastructure crept in", () => {
  /**
   * Everything §2 and §30 exclude, checked against BOTH the source and the
   * dependency list.
   *
   * The source check catches a hand-rolled version; the dependency check catches
   * an installed one. Either alone would miss the other, and §30's point is that
   * neither belongs in SP-V2-003.
   */
  const FORBIDDEN = [
    { label: "pgvector or an embedding column", pattern: /pgvector|\bvector\(|embedding/i },
    { label: "Redis", pattern: /\bredis\b|ioredis/i },
    { label: "a queue or worker framework", pattern: /bullmq|pg-boss|\bkafka\b|amqp|celery|sqs/i },
    { label: "cloud object storage", pattern: /aws-sdk|@aws-sdk|s3client|\bgcs\b|azure-storage/i },
    { label: "an authentication library", pattern: /jsonwebtoken|passport|bcrypt|argon2|express-session/i },
    { label: "a vector or search service", pattern: /pinecone|weaviate|qdrant|elasticsearch|opensearch/i },
  ];

  it("appears nowhere in src/", async () => {
    const sources = await readAll(await jsFiles(SRC));
    for (const { label, pattern } of FORBIDDEN) {
      const offenders = Object.entries(sources)
        // Comments stripped: text-chunker.js explains at length why it computes no
        // embeddings, and a rule that fires on the documentation of its own
        // deferral is a rule that gets deleted rather than kept.
        .filter(([, source]) => pattern.test(stripComments(source)))
        .map(([file]) => file);
      assert.deepEqual(offenders, [], `${label} must not appear in src/ this iteration (§2, §30)`);
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
    for (const { label, pattern } of FORBIDDEN) {
      const offenders = installed.filter((name) => pattern.test(name));
      assert.deepEqual(offenders, [], `${label} must not be installed this iteration (§30)`);
    }
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
  it("nothing in the question path imports a material module", async () => {
    // The direction of the dependency is the whole of §19's protection. Materials
    // may not reach into /api/ask's behaviour, and /api/ask must not start
    // depending on materials — "do not make /api/ask depend on material IDs yet".
    const files = (await jsFiles(SRC)).filter(
      (file) => !file.startsWith("src/materials/") && !file.startsWith("src/storage/"),
    );
    const offenders = Object.entries(await readAll(files))
      .filter(([, source]) => /["'][^"']*materials\/[a-z-]+\.js["']/.test(source))
      // The route table must mount the router; that is how the feature is reachable.
      .map(([file]) => file)
      .filter((file) => !/routes\.js$|app\.js$/.test(file));
    assert.deepEqual(offenders, [], `§19: ${offenders.join(", ")} must not depend on materials`);
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
    // §12 asks for separation of concerns, and this is the cheapest statement of
    // it: the files exist and are separate. A single 800-line material.service.js
    // would pass every other check in this file.
    const present = await jsFiles(path.join(SRC, "materials"));
    for (const expected of [
      "src/materials/material.routes.js",
      "src/materials/material.controller.js",
      "src/materials/material.service.js",
      "src/materials/material.repository.js",
      "src/materials/material-processing.service.js",
      "src/materials/document-extractor.js",
      "src/materials/text-normalizer.js",
      "src/materials/text-chunker.js",
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
    // rather than the JSON error §20 requires.
    const routes = await fs.readFile(
      path.join(SRC, "materials", "material.routes.js"),
      "utf8",
    );
    const handlers = routes.match(/asyncHandler\(/g) ?? [];
    assert.equal(handlers.length, 5, "all five endpoints (§10) must be wrapped");
  });
});
