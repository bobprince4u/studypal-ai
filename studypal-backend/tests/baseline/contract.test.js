/**
 * BASELINE CONTRACT SUITE
 * =======================
 *
 * Every assertion in this file describes behaviour that must be **identical
 * before and after** the SP-V2-001 refactor. It is the safety net: it was run
 * green against the original monolithic server.js, and must stay green against
 * the refactored backend.
 *
 *   npm run test:baseline          # against the current entry (server.js)
 *   STUDYPAL_ENTRY=<file> npm run test:baseline
 *                                 # against any other entrypoint, e.g. a copy of
 *                                 # the pre-refactor server.js restored from git
 *
 * Deliberately NOT asserted here (these are the documented, intentional
 * deviations — see docs/api-contract.md §7, asserted in tests/hardening.test.js):
 *   • error-page format for malformed input (was HTML + stack trace)
 *   • upload size and type limits
 *   • the /health endpoint
 *   • 404 body format
 *   • the verbatim upstream text inside the /api/ask 500 message
 *
 * Gemini is never contacted: tests/helpers/fake-gemini.mjs replaces the global
 * fetch before the app loads. No GEMINI_API_KEY is required.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  startServer,
  askForm,
  testUser,
} from "../helpers/server-harness.mjs";
import { CANNED_ANSWER } from "../helpers/fake-gemini.mjs";

describe("baseline contract", () => {
  let srv;

  before(async () => {
    // The harness provisions a private, migrated PostgreSQL database per server
    // and drops it in stop(). Before SP-V2-002 this passed a DATABASE_PATH into
    // a temp directory; the isolation requirement is the same, the mechanism is
    // not. See tests/helpers/test-database.mjs.
    srv = await startServer({ label: "contract" });
  });

  after(async () => {
    await srv?.stop();
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("POST /api/session", () => {
    test("creates a session and returns username + created_at", async () => {
      const username = testUser();
      const res = await srv.request("POST", "/api/session", {
        json: { username },
      });

      assert.equal(res.status, 200);
      assert.match(
        res.headers.get("content-type") ?? "",
        /application\/json/,
        "must respond with JSON",
      );
      assert.deepEqual(Object.keys(res.body).sort(), [
        "created_at",
        "username",
      ]);
      assert.equal(res.body.username, username);
      assert.equal(
        new Date(res.body.created_at).toISOString(),
        res.body.created_at,
        "created_at must be an ISO-8601 string",
      );
    });

    test("is idempotent and preserves the original created_at", async () => {
      const username = testUser();
      const first = await srv.request("POST", "/api/session", {
        json: { username },
      });
      const second = await srv.request("POST", "/api/session", {
        json: { username },
      });

      assert.equal(second.status, 200);
      assert.deepEqual(second.body, first.body);
    });

    test("trims surrounding whitespace from the username", async () => {
      const username = testUser();
      const res = await srv.request("POST", "/api/session", {
        json: { username: `   ${username}   ` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.username, username);
    });

    test("rejects a missing username with 400 Username required", async () => {
      const res = await srv.request("POST", "/api/session", { json: {} });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: "Username required" });
    });

    test("rejects a whitespace-only username with 400", async () => {
      const res = await srv.request("POST", "/api/session", {
        json: { username: "     " },
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: "Username required" });
    });

    test("rejects an empty-string username with 400", async () => {
      const res = await srv.request("POST", "/api/session", {
        json: { username: "" },
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: "Username required" });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("POST /api/ask", () => {
    test("returns the AI answer object verbatim", async () => {
      const username = testUser();
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ username, question: "Explain photosynthesis" }),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body,
        CANNED_ANSWER,
        "the model's JSON must be passed through unwrapped and unmodified",
      );
    });

    test("returns the shape the frontend reads", async () => {
      const username = testUser();
      const { body } = await srv.request("POST", "/api/ask", {
        form: askForm({ username, question: "Explain nouns" }),
      });

      // page.jsx reads exactly these paths.
      assert.equal(typeof body.explanation, "string");
      assert.equal(typeof body.topic, "string");
      assert.ok(Array.isArray(body.practice_questions));
      assert.equal(typeof body.encouragement, "string");
      for (const pq of body.practice_questions) {
        assert.equal(typeof pq.question, "string");
        assert.equal(typeof pq.answer, "string");
      }
    });

    test("rejects a missing question with 400", async () => {
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ username: testUser() }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: "Username and question required",
      });
    });

    test("rejects a missing username with 400", async () => {
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ question: "anything" }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: "Username and question required",
      });
    });

    test("rejects a whitespace-only question with 400", async () => {
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ username: testUser(), question: "   " }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: "Username and question required",
      });
    });

    test("also accepts an application/json body (unintended but relied upon)", async () => {
      const username = testUser();
      const res = await srv.request("POST", "/api/ask", {
        json: { username, question: "JSON rather than multipart" },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, CANNED_ANSWER);
    });

    test("does not require the username to have a session first", async () => {
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({
          username: testUser("never_registered"),
          question: "no session for me",
        }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, CANNED_ANSWER);
    });

    test("validates before calling the AI (no row written on 400)", async () => {
      const username = testUser();
      await srv.request("POST", "/api/ask", { form: askForm({ username }) });

      const history = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );
      assert.deepEqual(history.body, []);
    });

    describe("file uploads", () => {
      const cases = [
        { label: "plain text", name: "notes.txt", type: "text/plain", content: "cell biology" },
        { label: "markdown", name: "notes.md", type: "text/markdown", content: "# heading" },
        { label: "png image", name: "diagram.png", type: "image/png", content: "\x89PNG\r\n\x1a\nfake" },
        { label: "jpeg image", name: "photo.jpg", type: "image/jpeg", content: "\xff\xd8\xff\xe0fake" },
        { label: "gif image", name: "anim.gif", type: "image/gif", content: "GIF89afake" },
        { label: "webp image", name: "pic.webp", type: "image/webp", content: "RIFF....WEBPfake" },
      ];

      for (const c of cases) {
        test(`accepts ${c.label} and records it in history`, async () => {
          const username = testUser();
          const res = await srv.request("POST", "/api/ask", {
            form: askForm({
              username,
              question: `about ${c.label}`,
              file: { name: c.name, type: c.type, content: c.content },
            }),
          });

          assert.equal(res.status, 200);
          assert.deepEqual(res.body, CANNED_ANSWER);

          const { body: history } = await srv.request(
            "GET",
            `/api/history/${encodeURIComponent(username)}`,
          );
          assert.equal(history.length, 1);
          assert.equal(history[0].has_file, true);
          assert.equal(history[0].filename, c.name);
        });
      }

      test("returns 200 for a PDF that cannot be parsed", async () => {
        const username = testUser();
        const res = await srv.request("POST", "/api/ask", {
          form: askForm({
            username,
            question: "summarise this",
            file: {
              name: "broken.pdf",
              type: "application/pdf",
              content: "this is not a real pdf",
            },
          }),
        });

        assert.equal(
          res.status,
          200,
          "an unparseable PDF must degrade gracefully, not error",
        );
        assert.deepEqual(res.body, CANNED_ANSWER);
      });

      test("records has_file=false and filename=null when no file is sent", async () => {
        const username = testUser();
        await srv.request("POST", "/api/ask", {
          form: askForm({ username, question: "no attachment" }),
        });

        const { body: history } = await srv.request(
          "GET",
          `/api/history/${encodeURIComponent(username)}`,
        );
        assert.equal(history[0].has_file, false);
        assert.equal(history[0].filename, null);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("GET /api/history/:username", () => {
    test("returns an empty array for an unknown user", async () => {
      const res = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(testUser("unknown"))}`,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, [], "must be an array — page.jsx maps over it");
    });

    test("persists an asked question and returns the full item shape", async () => {
      const username = testUser();
      const question = "What is a noun?";
      await srv.request("POST", "/api/ask", {
        form: askForm({ username, question }),
      });

      const res = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 1);

      const item = res.body[0];
      assert.deepEqual(Object.keys(item).sort(), [
        "answer",
        "created_at",
        "filename",
        "has_file",
        "question",
        "topic",
      ]);
      assert.equal(item.question, question);
      assert.deepEqual(item.answer, CANNED_ANSWER, "answer must be re-parsed to an object");
      assert.equal(item.topic, CANNED_ANSWER.topic);
      assert.equal(item.has_file, false, "has_file must be a boolean, not 0/1");
      assert.equal(item.filename, null);
      assert.equal(
        new Date(item.created_at).toISOString(),
        item.created_at,
      );
    });

    test("orders newest first", async () => {
      const username = testUser();
      for (const q of ["first question", "second question", "third question"]) {
        await srv.request("POST", "/api/ask", {
          form: askForm({ username, question: q }),
        });
      }

      const { body } = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );
      assert.equal(body.length, 3);
      assert.equal(body[0].question, "third question");
      assert.equal(body[2].question, "first question");
    });

    test("caps the result at 30 items", async () => {
      const username = testUser();
      for (let i = 0; i < 32; i++) {
        await srv.request("POST", "/api/ask", {
          form: askForm({ username, question: `q${i}` }),
        });
      }

      const { body } = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );
      assert.equal(body.length, 30);
    });

    test("is not vulnerable to SQL injection via the path parameter", async () => {
      const username = testUser();
      await srv.request("POST", "/api/ask", {
        form: askForm({ username, question: "safe row" }),
      });

      for (const probe of ["' OR 1=1 --", "'; DROP TABLE questions; --", "%"]) {
        const res = await srv.request(
          "GET",
          `/api/history/${encodeURIComponent(probe)}`,
        );
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, [], `probe leaked rows: ${probe}`);
      }

      // The table must still be there afterwards.
      const after = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );
      assert.equal(after.body.length, 1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("GET /api/progress/:username", () => {
    test("returns zeroed progress for an unknown user", async () => {
      const res = await srv.request(
        "GET",
        `/api/progress/${encodeURIComponent(testUser("unknown"))}`,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { total_questions: 0, topics: [] });
    });

    test("counts questions and groups topics", async () => {
      const username = testUser();
      for (let i = 0; i < 3; i++) {
        await srv.request("POST", "/api/ask", {
          form: askForm({ username, question: `q${i}` }),
        });
      }

      const res = await srv.request(
        "GET",
        `/api/progress/${encodeURIComponent(username)}`,
      );

      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body).sort(), [
        "topics",
        "total_questions",
      ]);
      assert.equal(res.body.total_questions, 3);
      assert.ok(Array.isArray(res.body.topics));
      assert.deepEqual(res.body.topics, [
        { topic: CANNED_ANSWER.topic, count: 3 },
      ]);
    });

    test("topics is always an array (page.jsx reads .length unguarded)", async () => {
      const res = await srv.request(
        "GET",
        `/api/progress/${encodeURIComponent(testUser())}`,
      );
      assert.ok(Array.isArray(res.body.topics));
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("CORS", () => {
    test("allows the local frontend origin", async () => {
      const res = await srv.request("OPTIONS", "/api/ask", {
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
        },
      });

      assert.ok(
        [200, 204].includes(res.status),
        `preflight should succeed, got ${res.status}`,
      );
      const allow = res.headers.get("access-control-allow-origin");
      assert.ok(
        allow === "*" || allow === "http://localhost:3000",
        `local dev origin must be permitted, got ${allow}`,
      );
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AI response repair. Each mode needs its own server process because the fake
// is steered by an environment variable.
// ──────────────────────────────────────────────────────────────────────────
describe("AI response repair", () => {
  test("parses JSON wrapped in ```json fences", async () => {
    const srv = await startServer({
      label: "fenced",
      env: { FAKE_GEMINI_MODE: "fenced" },
    });
    try {
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ username: testUser(), question: "fenced" }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, CANNED_ANSWER);
    } finally {
      await srv.stop();
    }
  });

  test("falls back to the placeholder answer for non-JSON output", async () => {
    const srv = await startServer({
      label: "prose",
      env: { FAKE_GEMINI_MODE: "prose" },
    });
    try {
      const username = testUser();
      const res = await srv.request("POST", "/api/ask", {
        form: askForm({ username, question: "prose" }),
      });

      assert.equal(res.status, 200, "degradation must stay a 200");
      assert.equal(
        res.body.explanation,
        "Photosynthesis is how plants make food. No JSON here at all.",
        "raw model text becomes the explanation",
      );
      assert.equal(res.body.topic, "Study Topic");
      assert.deepEqual(res.body.practice_questions, []);
      assert.equal(res.body.encouragement, "Keep going!");

      // The degraded answer is still persisted, under the placeholder topic.
      const { body: history } = await srv.request(
        "GET",
        `/api/history/${encodeURIComponent(username)}`,
      );
      assert.equal(history[0].topic, "Study Topic");
    } finally {
      await srv.stop();
    }
  });

  for (const mode of ["http-error", "network-error"]) {
    test(`returns 500 {error} when the AI ${mode === "http-error" ? "rejects the request" : "is unreachable"}`, async () => {
      const srv = await startServer({
        label: mode,
        env: { FAKE_GEMINI_MODE: mode },
      });
      try {
        const username = testUser();
        const res = await srv.request("POST", "/api/ask", {
          form: askForm({ username, question: "boom" }),
        });

        assert.equal(res.status, 500);
        assert.match(
          res.headers.get("content-type") ?? "",
          /application\/json/,
          "error must be JSON, not an HTML error page",
        );
        assert.equal(
          typeof res.body?.error,
          "string",
          "body must keep an `error` string — page.jsx renders this object",
        );
        assert.match(res.body.error, /AI request failed/);

        // A failed AI call must not persist anything.
        const { body: history } = await srv.request(
          "GET",
          `/api/history/${encodeURIComponent(username)}`,
        );
        assert.deepEqual(history, []);
      } finally {
        await srv.stop();
      }
    });
  }
});
