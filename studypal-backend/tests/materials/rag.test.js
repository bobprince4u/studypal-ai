/**
 * POST /api/materials/chat, end to end — SP-V2-004 §39.
 *
 * Black box, like tests/materials/api.test.js: real server child processes, real
 * migrated PostgreSQL databases, real uploads through the multipart endpoint, HTTP
 * in and JSON out. Nothing here imports a service or a repository. The units are
 * covered in tests/materials/chat.test.js, retrieval ordering in
 * tests/materials/retrieval.test.js — this file answers a different question: does
 * the FEATURE work through the contract a client actually sees, and does every
 * failure of it still come back as JSON.
 *
 * The corpus is built by UPLOADING documents, not by inserting rows. That is the
 * point of doing this over HTTP at all: it exercises extract → normalize → chunk →
 * embed → store → retrieve → answer as one path, so a break anywhere in it shows
 * up here. The embedding fake derives each chunk's vector from the chunk's own
 * text (tests/fixtures/vectors.mjs), which is what makes an uploaded document's
 * retrieval behaviour predictable without any row being written by hand.
 *
 * HOW "GEMINI WAS NOT CALLED" IS PROVED HERE
 * ------------------------------------------
 * A spawned server's environment cannot be changed after it starts, and its fetch
 * cannot be counted from this process — so §21's no-call requirement is proved a
 * different way than in chat.test.js: a server whose generation endpoint returns
 * 500 for every request answers an irrelevant question with a 200. If any
 * generation request had been made, that server could only have produced an error.
 * The absence is observed through the status code rather than asserted about a mock.
 *
 * One main server for the tests that run under the default fake behaviour, and a
 * short-lived server per fixed provider mode — the modes are read per request but
 * from the CHILD's environment, so they are fixed for a process's lifetime. Same
 * convention as api.test.js's embedding-outage test.
 *
 *   node --test tests/materials/rag.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startServer, testUser, askForm } from "../helpers/server-harness.mjs";
import { materialForm, multiPagePdf } from "../fixtures/materials.mjs";
import { CANNED_ANSWER, CANNED_CHAT_ANSWER } from "../helpers/fake-gemini.mjs";

/** The server-side text for "nothing in your materials covers this". */
const NO_EVIDENCE = /could not find anything about that in your uploaded study materials/;

/** config.rag.maxQuestionChars' default, restated so the bound is visible here. */
const MAX_QUESTION_CHARS = 2000;

/** config.rag.maxTopK's default. */
const MAX_TOP_K = 20;

let server;

before(async () => {
  server = await startServer({ label: "rag" });
});

after(async () => {
  await server?.stop();
});

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Short single-chunk documents, each about exactly one of the topics
// tests/fixtures/vectors.mjs knows. Single-chunk so a citation's chunkIndex must
// be 0 and its pageNumber must be absent, which makes the assertions exact rather
// than "some plausible number". The multi-chunk and multi-page cases use
// multiPagePdf(), whose pages differ in topic.

const PHOTOSYNTHESIS_TXT = Object.freeze({
  filename: "photosynthesis-notes.txt",
  type: "text/plain",
  content:
    "Photosynthesis converts light energy into chemical energy stored as glucose. " +
    "It happens in the chloroplasts of plant cells, and releases oxygen as a " +
    "by-product of splitting water.",
});

const CALCULUS_TXT = Object.freeze({
  filename: "calculus-notes.txt",
  type: "text/plain",
  content:
    "Calculus studies continuous change. The derivative measures an instantaneous " +
    "rate of change, and the integral accumulates a quantity over an interval.",
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** POST a chat request. `body` is sent exactly as given, malformed or not. */
const chat = (body, target = server) =>
  target.request("POST", "/api/materials/chat", { json: body });

/** POST a chat request and assert it succeeded. */
async function chatOk(body, target = server) {
  const res = await chat(body, target);
  assert.equal(res.status, 200, `chat failed: ${res.text}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  return res.body;
}

/** Upload a fixture and assert it is ready and searchable. */
async function uploadIndexed(username, file, target = server) {
  const res = await target.request("POST", "/api/materials", {
    form: materialForm({ username, file }),
  });
  assert.equal(res.status, 201, `upload failed: ${res.text}`);
  assert.equal(res.body.status, "ready", res.text);
  assert.equal(
    res.body.indexingStatus,
    "indexed",
    `the fixture must be searchable before a chat test uses it: ${res.text}`,
  );
  return res.body;
}

/** Nothing internal may appear in any response, error or not (§32). */
function assertNoInternals(payload) {
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /storage_?[Kk]ey/, "no storage key");
  assert.doesNotMatch(json, /\buser_?id\b/i, "no user id");
  assert.doesNotMatch(json, /\/tmp\/|\/home\/|studypal-test-uploads/, "no path");
  assert.doesNotMatch(json, /\bat \S+ \(|node_modules/, "no stack frame");
  assert.doesNotMatch(json, /generativelanguage|googleapis|GEMINI_API_KEY/i, "no provider");
  assert.doesNotMatch(json, /\bembedding\b|<=>|\bvector\b|SELECT |material_chunks/i, "no internals");
}

/** An error response has the given status, is JSON, and leaks nothing. */
function assertJsonError(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  assert.match(
    res.headers.get("content-type") ?? "",
    /application\/json/,
    "every error response must remain JSON (§39)",
  );
  assert.equal(typeof res.body?.error, "string", `no error string in ${res.text}`);
  assert.ok(res.body.error.length > 0);
  // A 4xx/5xx must never carry a half-built answer alongside the error: a client
  // reading `body.answer` without checking the status would render it.
  assert.equal("answer" in res.body, false);
  assert.equal("sources" in res.body, false);
  assertNoInternals(res.body);
}

/** A source citation has exactly the documented keys, with plausible values. */
function assertCitationShape(source) {
  assert.deepEqual(Object.keys(source).sort(), [
    "chunkIndex",
    "filename",
    "materialId",
    "pageNumber",
    "similarity",
  ]);
  assert.equal(typeof source.materialId, "number");
  assert.equal(typeof source.filename, "string");
  assert.equal(typeof source.chunkIndex, "number");
  assert.equal(typeof source.similarity, "number");
  assert.ok(source.similarity > 0 && source.similarity <= 1, `similarity ${source.similarity}`);
  assert.ok(
    source.pageNumber === null || typeof source.pageNumber === "number",
    "pageNumber is a number or explicitly null — never undefined or a string",
  );
}

// ── §14, §39: what the endpoint refuses ─────────────────────────────────────
describe("POST /api/materials/chat — request validation", () => {
  it("rejects a missing username with 400", async () => {
    const res = await chat({ question: "How does photosynthesis work?" });
    assertJsonError(res, 400);
    assert.match(res.body.error, /username/i);
  });

  it("rejects a blank username with the same 400", async () => {
    for (const username of ["", "   ", null, 42, ["a"]]) {
      const res = await chat({ username, question: "How does photosynthesis work?" });
      assertJsonError(res, 400);
      assert.match(res.body.error, /username/i);
    }
  });

  it("rejects a missing question with 400", async () => {
    const res = await chat({ username: testUser("noq") });
    assertJsonError(res, 400);
    assert.match(res.body.error, /question/i);
  });

  it("rejects an empty or whitespace-only question with 400", async () => {
    for (const question of ["", "   ", "\n\t ", null, 7, {}]) {
      const res = await chat({ username: testUser("blankq"), question });
      assertJsonError(res, 400);
      assert.match(res.body.error, /question/i);
    }
  });

  it("rejects an excessively long question with 400", async () => {
    // §14's "do not allow enormous prompts to become retrieval queries". Rejected
    // BEFORE any provider call, so an oversized body cannot spend embedding quota
    // — the assertion for which is the AI-outage server below: this same request
    // returns 400 there too, not 500.
    const res = await chat({
      username: testUser("longq"),
      question: "a".repeat(MAX_QUESTION_CHARS + 1),
    });
    assertJsonError(res, 400);
    assert.match(res.body.error, new RegExp(String(MAX_QUESTION_CHARS)));
  });

  it("accepts a question exactly at the limit", async () => {
    // The bound is inclusive, and a test for the rejection alone cannot tell an
    // off-by-one from a correct limit.
    const username = testUser("atlimit");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({
      username,
      question: `Photosynthesis: ${"a".repeat(MAX_QUESTION_CHARS - 16)}`,
    });
    assert.equal(typeof body.answer, "string");
  });

  it("ignores trailing whitespace when measuring the question", async () => {
    const username = testUser("padded");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({
      username,
      question: `${"a".repeat(MAX_QUESTION_CHARS)}   \n  `,
    });
    assert.equal(typeof body.answer, "string");
  });

  it("rejects a malformed materialId rather than silently widening the search", async () => {
    // A client that meant to scope a search and got a corpus-wide one could not
    // tell from the response, so this is an error rather than a default.
    const username = testUser("badid");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    for (const materialId of ["7", 0, -1, 2.5, true, {}, []]) {
      const res = await chat({
        username,
        question: "How does photosynthesis work?",
        materialId,
      });
      assertJsonError(res, 400);
      assert.match(res.body.error, /material id/i);
    }
  });

  it("cannot be sent a NaN materialId at all", async () => {
    // Not a gap in the validation above: JSON has no NaN literal, so
    // `JSON.stringify({materialId: NaN})` sends `null` and the value arrives as
    // "no scope". Asserted rather than left out, so the absence of NaN from that
    // list reads as a property of the wire format instead of an oversight.
    const username = testUser("nanid");
    const material = await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({
      username,
      question: "How does photosynthesis work?",
      materialId: Number.NaN,
    });
    assert.deepEqual(
      body.sources.map((source) => source.materialId),
      [material.id],
      "a NaN scope arrives as null and searches everything the user owns",
    );
  });

  it("treats an absent or null materialId as a search across everything owned", async () => {
    const username = testUser("wide");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    for (const body of [
      { username, question: "How does photosynthesis work?" },
      { username, question: "How does photosynthesis work?", materialId: null },
    ]) {
      const answer = await chatOk(body);
      assert.equal(answer.sources.length, 1, JSON.stringify(answer));
    }
  });

  it("rejects a malformed topK with 400", async () => {
    for (const topK of [0, -3, 1.5, "5", true]) {
      const res = await chat({
        username: testUser("badk"),
        question: "How does photosynthesis work?",
        topK,
      });
      assertJsonError(res, 400);
      assert.match(res.body.error, /topk/i);
    }
  });

  it("serves an oversized topK from the server's maximum instead of refusing it", async () => {
    // §13: "the server must enforce a maximum." 500 is a legitimate request for
    // more context than the server will give — it gets the cap, not an error, and
    // certainly not 500 sources.
    const username = testUser("bigk");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({
      username,
      question: "How does photosynthesis work?",
      topK: 500,
    });
    assert.ok(body.sources.length <= MAX_TOP_K, `${body.sources.length} sources`);
  });

  it("rejects a body that is not JSON at all, as JSON", async () => {
    const res = await server.request("POST", "/api/materials/chat", {
      body: "username=alice&question=hi",
      headers: { "content-type": "application/json" },
    });
    assertJsonError(res, 400);
  });

  it("rejects a request with no body at all", async () => {
    assertJsonError(await server.request("POST", "/api/materials/chat"), 400);
  });
});

// ── §21, §22, §39: a grounded answer ────────────────────────────────────────
describe("POST /api/materials/chat — a grounded answer", () => {
  it("answers from an uploaded document and cites it", async () => {
    const username = testUser("grounded");
    const material = await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({ username, question: "How does photosynthesis work?" });

    // §25's response contract, exactly: two keys, nothing else. `grounded` is
    // deliberately not forwarded — an empty `sources` already distinguishes the
    // two 200s, and a second signal would be one more thing to keep consistent.
    assert.deepEqual(Object.keys(body).sort(), ["answer", "sources"]);
    assert.equal(body.answer, CANNED_CHAT_ANSWER);

    assert.equal(body.sources.length, 1);
    assertCitationShape(body.sources[0]);
    assert.deepEqual(body.sources[0], {
      materialId: material.id,
      filename: "photosynthesis-notes.txt",
      pageNumber: null,
      chunkIndex: 0,
      similarity: 1,
    });
    assertNoInternals(body);
  });

  it("cites the page the text came from, on a document that has pages", async () => {
    // §22's page attribution, through the whole pipeline. Page 2 of the fixture is
    // the only page naming mitochondria, so it is the only page that can clear the
    // similarity threshold — and the page number in the citation is read from the
    // chunk row, not chosen by the model, which returns an index and nothing else.
    const username = testUser("paged");
    const material = await uploadIndexed(username, multiPagePdf());
    assert.equal(material.pageCount, 3);

    const body = await chatOk({
      username,
      question: "How do mitochondria generate energy?",
    });

    assert.equal(body.sources.length, 1, JSON.stringify(body.sources));
    assert.deepEqual(body.sources[0], {
      materialId: material.id,
      filename: "cell-biology.pdf",
      pageNumber: 2,
      chunkIndex: 1,
      similarity: 0.7071,
    });
  });

  it("scopes the search to one material when asked", async () => {
    const username = testUser("scoped");
    const biology = await uploadIndexed(username, PHOTOSYNTHESIS_TXT);
    const maths = await uploadIndexed(username, CALCULUS_TXT);

    const scoped = await chatOk({
      username,
      question: "What is a derivative in calculus?",
      materialId: maths.id,
    });
    assert.deepEqual(
      scoped.sources.map((source) => source.materialId),
      [maths.id],
    );

    // And the same question scoped to the OTHER material finds nothing rather
    // than falling back to a corpus-wide search.
    const wrongScope = await chatOk({
      username,
      question: "What is a derivative in calculus?",
      materialId: biology.id,
    });
    assert.deepEqual(wrongScope.sources, []);
    assert.match(wrongScope.answer, NO_EVIDENCE);
  });

  it("answers about a material uploaded a moment earlier, with no polling", async () => {
    // Indexing is synchronous on upload, so a student can ask about a document as
    // soon as the upload response arrives. Worth asserting because the response
    // *claims* `indexingStatus: "indexed"`, and this is what that claim means.
    const username = testUser("immediate");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({ username, question: "Explain photosynthesis." });
    assert.equal(body.sources.length, 1);
  });
});

// ── §15, §16, §39: whose material it is ─────────────────────────────────────
describe("POST /api/materials/chat — ownership", () => {
  it("404s a material id that does not exist", async () => {
    const username = testUser("ghostmat");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const res = await chat({
      username,
      question: "How does photosynthesis work?",
      materialId: 999_999_999,
    });
    assertJsonError(res, 404);
    assert.equal(res.body.error, "Material not found.");
  });

  it("404s another user's material, with the same message", async () => {
    // §16. The message is identical to a genuinely missing id on purpose: a
    // distinguishable "not yours" would let an unauthenticated caller enumerate
    // which ids exist. Asserted as an equality, not a pattern, because "the two
    // responses are the same" IS the property.
    const alice = testUser("alice");
    const bob = testUser("bob");
    const bobsMaterial = await uploadIndexed(bob, PHOTOSYNTHESIS_TXT);

    const res = await chat({
      username: alice,
      question: "How does photosynthesis work?",
      materialId: bobsMaterial.id,
    });
    assertJsonError(res, 404);
    assert.equal(res.body.error, "Material not found.");
  });

  it("never returns another user's material in a corpus-wide search", async () => {
    // Alice and Bob upload the SAME document, so Bob's chunk is an equally perfect
    // match for Alice's question — it would be a joint top result if ownership
    // were applied anywhere other than in the SQL.
    const alice = testUser("alice2");
    const bob = testUser("bob2");
    const alices = await uploadIndexed(alice, PHOTOSYNTHESIS_TXT);
    const bobs = await uploadIndexed(bob, PHOTOSYNTHESIS_TXT);
    assert.notEqual(alices.id, bobs.id);

    const forAlice = await chatOk({ username: alice, question: "Explain photosynthesis." });
    assert.deepEqual(
      forAlice.sources.map((source) => source.materialId),
      [alices.id],
    );

    const forBob = await chatOk({ username: bob, question: "Explain photosynthesis." });
    assert.deepEqual(
      forBob.sources.map((source) => source.materialId),
      [bobs.id],
    );
  });

  it("answers an unknown username exactly as it answers a student with no uploads", async () => {
    // The status code must not report whether a username exists. A 404 for an
    // unknown username while a known-but-empty one gets a 200 would make this
    // endpoint an existence oracle for any name a caller cares to try — which is
    // the opposite of what a 404 is for here. Asserted as a deepEqual of the two
    // whole responses, because "indistinguishable" is the property, not "both
    // are some kind of empty".
    const unknown = await chatOk({
      username: testUser("never-seen"),
      question: "How does photosynthesis work?",
    });
    assert.match(unknown.answer, NO_EVIDENCE);
    assert.deepEqual(unknown.sources, []);

    const known = testUser("emptyshelf");
    const session = await server.request("POST", "/api/session", {
      json: { username: known },
    });
    assert.equal(session.status, 200, session.text);

    const empty = await chatOk({ username: known, question: "How does photosynthesis work?" });
    assert.deepEqual(empty, unknown, "the two must be indistinguishable");
  });

  it("still 404s a scoped request from an unknown username", async () => {
    // The 404 belongs to the material scope, not to the username: this request
    // named an id, and gets the same answer as one naming someone else's id.
    const owner = testUser("realowner");
    const material = await uploadIndexed(owner, PHOTOSYNTHESIS_TXT);

    const res = await chat({
      username: testUser("never-seen-2"),
      question: "How does photosynthesis work?",
      materialId: material.id,
    });
    assertJsonError(res, 404);
    assert.equal(res.body.error, "Material not found.");
  });
});

// ── §21: nothing relevant is an answer, not an error ────────────────────────
describe("POST /api/materials/chat — when nothing is relevant", () => {
  it("returns 200 with no sources and says so", async () => {
    const username = testUser("irrelevant");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({ username, question: "Explain plate tectonics." });

    assert.deepEqual(Object.keys(body).sort(), ["answer", "sources"]);
    assert.deepEqual(body.sources, []);
    assert.match(body.answer, NO_EVIDENCE);
    // Not the model's answer — there was no model call to produce one.
    assert.notEqual(body.answer, CANNED_CHAT_ANSWER);
  });

  it("does not fabricate an answer from general knowledge", async () => {
    // §21's "do not silently fall back to unrestricted general Gemini knowledge in
    // the material-chat endpoint". Plate tectonics is something a general model
    // answers easily and this student's materials do not mention at all, so a
    // plausible geology answer here would be exactly the failure being ruled out.
    const username = testUser("nofallback");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const body = await chatOk({ username, question: "Explain plate tectonics." });
    assert.doesNotMatch(body.answer, /plate|tectonic|continental|lithosphere/i);
  });

  it("makes no generation request at all", async () => {
    // §21's no-call requirement, observed rather than mocked: this server answers
    // EVERY generation request with a 500, so a 200 is only reachable if no
    // generation request was made. The same question against a healthy server
    // (above) proves the 200 is not an artifact of the outage.
    const offline = await startServer({
      label: "ragnogen",
      env: { FAKE_GEMINI_MODE: "http-error" },
    });
    try {
      const username = testUser("nogen");
      await uploadIndexed(username, PHOTOSYNTHESIS_TXT, offline);

      const body = await chatOk(
        { username, question: "Explain plate tectonics." },
        offline,
      );
      assert.match(body.answer, NO_EVIDENCE);
      assert.deepEqual(body.sources, []);

      // And the control: a RELEVANT question on the same server does reach
      // generation, and fails. Without this, the test above would also pass
      // against a server that never called Gemini for anything.
      const relevant = await chat(
        { username, question: "How does photosynthesis work?" },
        offline,
      );
      assertJsonError(relevant, 500);
    } finally {
      await offline.stop();
    }
  });
});

// ── §33: a provider failure is its own condition ────────────────────────────
describe("POST /api/materials/chat — when a provider fails", () => {
  it("returns a safe JSON 500 when generation fails", async () => {
    const offline = await startServer({
      label: "ragnoai",
      env: { FAKE_GEMINI_MODE: "http-error" },
    });
    try {
      const username = testUser("aidown");
      await uploadIndexed(username, PHOTOSYNTHESIS_TXT, offline);

      const res = await chat(
        { username, question: "How does photosynthesis work?" },
        offline,
      );
      assertJsonError(res, 500);
      // Emphatically NOT the other condition's 200. A student told "your
      // materials do not cover this" during an outage would go and re-upload a
      // document that was never the problem.
      assert.doesNotMatch(res.body.error, NO_EVIDENCE);
      assert.doesNotMatch(res.body.error, /photosynthesis/i, "no leaked context");

      // Validation still runs first, so an outage does not turn a bad request
      // into a 500 — the client still learns what was wrong with its request.
      assertJsonError(await chat({ username }, offline), 400);
      assertJsonError(
        await chat({ username, question: "a".repeat(MAX_QUESTION_CHARS + 1) }, offline),
        400,
      );
    } finally {
      await offline.stop();
    }
  });

  it("returns a safe JSON 500 when the query cannot be embedded", async () => {
    // The subtler of the two, and the one §33 singles out: the search never ran,
    // so "nothing relevant was found" would be a claim about the student's
    // documents that this server is in no position to make.
    const offline = await startServer({
      label: "ragnoembed",
      env: { FAKE_EMBEDDING_MODE: "http-error" },
    });
    try {
      const username = testUser("embeddown");

      // The upload still succeeds — the document is readable, it just is not
      // searchable, which api.test.js asserts in full. Recorded here because it
      // is what makes the chat request below a query-embedding failure rather
      // than a missing material.
      const created = await offline.request("POST", "/api/materials", {
        form: materialForm({ username, file: PHOTOSYNTHESIS_TXT }),
      });
      assert.equal(created.body.indexingStatus, "failed", created.text);

      const res = await chat(
        { username, question: "How does photosynthesis work?" },
        offline,
      );
      assertJsonError(res, 500);
      assert.doesNotMatch(res.body.error, NO_EVIDENCE);
    } finally {
      await offline.stop();
    }
  });

  it("returns a safe JSON 500 when the model answers with something unparseable", async () => {
    // Deliberately not /api/ask's behaviour, which surfaces prose as the answer.
    // There, prose is a usable answer to a general question; here it is
    // ungrounded text from an endpoint that promises grounding, and there is no
    // honest way to attach sources to it.
    const babbling = await startServer({
      label: "ragprose",
      env: { FAKE_CHAT_MODE: "prose" },
    });
    try {
      const username = testUser("prose");
      await uploadIndexed(username, PHOTOSYNTHESIS_TXT, babbling);

      const res = await chat(
        { username, question: "How does photosynthesis work?" },
        babbling,
      );
      assertJsonError(res, 500);
      assert.doesNotMatch(res.body.error, NO_EVIDENCE);
    } finally {
      await babbling.stop();
    }
  });
});

// ── §22, §24: the citations are the backend's, whatever the model says ──────
describe("POST /api/materials/chat — a model that cites badly", () => {
  it("returns no citation for a source the prompt never contained", async () => {
    const lying = await startServer({
      label: "ragbadcite",
      env: { FAKE_CHAT_MODE: "invalid-index" },
    });
    try {
      const username = testUser("badcite");
      await uploadIndexed(username, PHOTOSYNTHESIS_TXT, lying);

      const body = await chatOk(
        { username, question: "How does photosynthesis work?" },
        lying,
      );

      // The answer stands — it was built from real retrieved context — and
      // source 99 becomes no citation at all rather than a citation pointing
      // somewhere convenient.
      assert.equal(body.answer, CANNED_CHAT_ANSWER);
      assert.deepEqual(body.sources, []);
      assertNoInternals(body);
    } finally {
      await lying.stop();
    }
  });

  it("cites every source it used, with each one's own metadata", async () => {
    const citesAll = await startServer({
      label: "ragallcite",
      env: { FAKE_CHAT_MODE: "all-sources" },
    });
    try {
      const username = testUser("allcite");
      const material = await uploadIndexed(username, multiPagePdf(), citesAll);

      // topK 1 first: the model is given one source and can only cite one, so the
      // pair of requests distinguishes "the response echoes what the model said"
      // from "the response is however many sources retrieval actually supplied".
      const one = await chatOk(
        { username, question: "How do mitochondria generate energy?", topK: 1 },
        citesAll,
      );
      assert.equal(one.sources.length, 1);

      // Threshold 0 is not reachable over HTTP, so a corpus-wide question that
      // genuinely matches two pages is not constructible from this fixture —
      // pages 1 and 3 name no topic at all. What is assertable is that each
      // citation carries its OWN page and chunk, which is the property that
      // breaks first if the mapping is off by one.
      const all = await chatOk(
        { username, question: "Where does photosynthesis happen in the cell?" },
        citesAll,
      );
      for (const source of all.sources) {
        assertCitationShape(source);
        assert.equal(source.materialId, material.id);
        assert.equal(source.filename, "cell-biology.pdf");
        assert.equal(
          source.pageNumber,
          source.chunkIndex + 1,
          "this fixture is one chunk per page, so page N is chunk N-1",
        );
      }
      assert.ok(all.sources.length >= 1);
    } finally {
      await citesAll.stop();
    }
  });
});

// ── §26: the endpoint that already existed ──────────────────────────────────
describe("POST /api/ask is untouched", () => {
  it("still answers from general knowledge, with no sources", async () => {
    // §26: "do not break /api/ask, do not silently make it use RAG." The check
    // that matters is not that it returns 200 but that its CONTRACT is unchanged:
    // the same keys as before, and no `sources` key — a client cannot have started
    // depending on grounding it was never promised.
    const username = testUser("ask");
    const res = await server.request("POST", "/api/ask", {
      form: askForm({ username, question: "Explain plate tectonics." }),
    });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, CANNED_ANSWER);
    assert.equal("sources" in res.body, false);
  });

  it("answers a question the student's materials do not cover", async () => {
    // The same question that gets "your materials do not cover this" from
    // /api/materials/chat. Two endpoints, two jobs: one is grounded in the
    // student's documents, the other is not, and this asserts they did not
    // converge.
    const username = testUser("bothways");
    await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const grounded = await chatOk({ username, question: "Explain plate tectonics." });
    assert.match(grounded.answer, NO_EVIDENCE);

    const general = await server.request("POST", "/api/ask", {
      form: askForm({ username, question: "Explain plate tectonics." }),
    });
    assert.equal(general.status, 200, general.text);
    assert.equal(general.body.explanation, CANNED_ANSWER.explanation);
  });

  it("ignores a materialId and never grows a sources key", async () => {
    // §26's real content. /api/ask accepts a JSON body as well as multipart, so a
    // RAG-shaped request reaches it intact — and the answer that comes back is
    // still the plain general-knowledge shape. `materialId` is not a field it has,
    // so it is ignored rather than quietly turning the endpoint into a scoped
    // grounded search, and no `sources` key appears for a client to start
    // depending on.
    const username = testUser("crossed");
    const material = await uploadIndexed(username, PHOTOSYNTHESIS_TXT);

    const res = await server.request("POST", "/api/ask", {
      json: {
        username,
        question: "Explain plate tectonics.",
        materialId: material.id,
      },
    });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, CANNED_ANSWER);
    assert.equal("sources" in res.body, false);
  });
});
