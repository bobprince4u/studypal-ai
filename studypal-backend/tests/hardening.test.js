/**
 * Hardening tests — the intended CHANGES from SP-V2-001.
 *
 * The companion file tests/baseline/contract.test.js asserts what must NOT
 * change; this one asserts what deliberately did. Keeping them separate matters:
 * the baseline suite is runnable against the pre-refactor server.js and passes
 * there, which is what makes it evidence of behavioural equivalence. These tests
 * only pass against the refactored backend, by design.
 *
 * Each test maps to a numbered row in docs/api-contract.md §7. If a row is
 * changed there, the matching test here must change with it.
 *
 *   npm test              # everything
 *   node --test tests/hardening.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { askForm, startServer, testUser } from "./helpers/server-harness.mjs";

const { Pool } = pg;

let server;

before(async () => {
  // Each startServer() gets its own migrated PostgreSQL database; see
  // tests/helpers/test-database.mjs. SP-V2-002 replaced the temp-directory
  // SQLite files this file used to manage.
  server = await startServer({
    label: "harden",
    env: { FAKE_GEMINI_MODE: "json" },
  });
});

after(async () => {
  await server?.stop();
});

/** Every error response must be JSON carrying a string `error`. */
async function assertJsonError(res, expectedStatus) {
  assert.equal(res.status, expectedStatus);
  assert.match(
    res.headers.get("content-type") ?? "",
    /application\/json/,
    "error responses must be JSON — the frontend parses them unconditionally",
  );
  assert.equal(typeof res.body?.error, "string");
  return res.body.error;
}

/** No response may ever contain a stack frame or an absolute server path. */
function assertNoLeak(raw) {
  assert.doesNotMatch(raw, /\bat\s+\S+\s+\(\/|\bat\s+\/|node:internal/, "leaked a stack frame");
  assert.doesNotMatch(raw, /\/home\/|\/Users\/|node_modules/, "leaked a filesystem path");
  assert.doesNotMatch(raw, /<!DOCTYPE|<html|<pre>/i, "returned HTML instead of JSON");
}

// ── 7.1 malformed input is a 400, not an HTML 500 ──────────────────────────
describe("7.1 bad input returns JSON 400 instead of an HTML stack trace", () => {
  it("rejects a non-string username on /api/session", async () => {
    const res = await server.request("POST", "/api/session", {
      json: { username: { evil: true } },
    });
    const message = await assertJsonError(res, 400);
    assert.equal(message, "Username required");
    assertNoLeak(res.text);
  });

  it("rejects a completely absent body on /api/session", async () => {
    const res = await server.request("POST", "/api/session");
    assert.equal(await assertJsonError(res, 400), "Username required");
    assertNoLeak(res.text);
  });

  it("rejects a text/plain body on /api/ask", async () => {
    const res = await server.request("POST", "/api/ask", {
      headers: { "content-type": "text/plain" },
      body: "username=x&question=y",
    });
    assert.equal(
      await assertJsonError(res, 400),
      "Username and question required",
    );
    assertNoLeak(res.text);
  });

  it("rejects a numeric question on /api/ask", async () => {
    const res = await server.request("POST", "/api/ask", {
      json: { username: testUser("h71"), question: 42 },
    });
    assert.equal(
      await assertJsonError(res, 400),
      "Username and question required",
    );
  });
});

// ── 7.2 body-parser failures ───────────────────────────────────────────────
describe("7.2 body parser failures are JSON", () => {
  it("returns 400 for malformed JSON", async () => {
    const res = await server.request("POST", "/api/session", {
      headers: { "content-type": "application/json" },
      body: '{"username": "broken",,}',
    });
    assert.equal(await assertJsonError(res, 400), "Invalid JSON body");
    assertNoLeak(res.text);
  });

  it("returns 413 for a body over the JSON limit", async () => {
    const res = await server.request("POST", "/api/session", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "x".repeat(200 * 1024) }),
    });
    assert.equal(await assertJsonError(res, 413), "Request body too large");
    assertNoLeak(res.text);
  });
});

// ── 7.3 username length bound ──────────────────────────────────────────────
describe("7.3 username length is bounded", () => {
  it("rejects an over-long username on /api/session", async () => {
    const res = await server.request("POST", "/api/session", {
      json: { username: "a".repeat(201) },
    });
    assert.equal(
      await assertJsonError(res, 400),
      "Username must be 200 characters or fewer",
    );
  });

  it("accepts a username exactly at the limit", async () => {
    const res = await server.request("POST", "/api/session", {
      json: { username: "b".repeat(200) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username.length, 200);
  });

  it("rejects an over-long username on /api/ask", async () => {
    const res = await server.request("POST", "/api/ask", {
      json: { username: "c".repeat(201), question: "hello" },
    });
    await assertJsonError(res, 400);
  });
});

// ── 7.4 upstream AI errors are not forwarded verbatim ──────────────────────
describe("7.4 provider error detail is not leaked", () => {
  it("returns a fixed message on AI failure, keeping status and shape", async () => {
    const failing = await startServer({
      label: "aifail",
      env: { FAKE_GEMINI_MODE: "http-error" },
    });

    try {
      const username = testUser("h74");
      const res = await failing.request("POST", "/api/ask", {
        form: askForm({ username, question: "What is a noun?" }),
      });

      // Status and body shape are the pre-refactor ones...
      assert.equal(res.status, 500);
      assert.equal(typeof res.body.error, "string");
      // ...but the upstream detail is gone.
      assert.equal(res.body.error, "AI request failed");
      assert.doesNotMatch(res.body.error, /quota|api[_ -]?key|googleapis|429|500/i);
      assertNoLeak(res.text);

      // And still nothing persisted, as before.
      const history = await failing.request("GET", `/api/history/${username}`);
      assert.deepEqual(history.body, []);
    } finally {
      await failing.stop();
    }
  });
});

// ── 7.5 upload limits and type allowlist ───────────────────────────────────
describe("7.5 uploads are bounded and type-checked", () => {
  it("rejects a file type outside the allowlist with 415", async () => {
    const res = await server.request("POST", "/api/ask", {
      form: askForm({
        username: testUser("h75"),
        question: "run this",
        file: { name: "payload.exe", content: "MZ\x00\x00", type: "application/octet-stream" },
      }),
    });
    const message = await assertJsonError(res, 415);
    assert.match(message, /unsupported file type/i);
  });

  it("rejects an oversized file with 413", async () => {
    const res = await server.request("POST", "/api/ask", {
      form: askForm({
        username: testUser("h75b"),
        question: "big file",
        // Default limit is 10MB.
        file: { name: "big.txt", content: "x".repeat(11 * 1024 * 1024), type: "text/plain" },
      }),
    });
    const message = await assertJsonError(res, 413);
    assert.match(message, /too large/i);
  });

  it("still accepts every type the frontend's file picker offers", async () => {
    // Mirrors accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.gif" in app/page.jsx.
    for (const name of [
      "notes.txt",
      "diagram.png",
      "photo.jpg",
      "photo.jpeg",
      "sketch.webp",
      "animation.gif",
    ]) {
      const res = await server.request("POST", "/api/ask", {
        form: askForm({
          username: testUser("h75c"),
          question: `about ${name}`,
          file: { name, content: "sample content" },
        }),
      });
      assert.equal(res.status, 200, `${name} should be accepted`);
    }
  });

  it("does not persist a row when the upload is rejected", async () => {
    const username = testUser("h75d");
    await server.request("POST", "/api/ask", {
      form: askForm({
        username,
        question: "rejected",
        file: { name: "bad.exe", content: "nope" },
      }),
    });
    const history = await server.request("GET", `/api/history/${username}`);
    assert.deepEqual(history.body, []);
  });
});

// ── 7.6 CORS is configurable ───────────────────────────────────────────────
describe("7.6 CORS can be restricted without breaking local development", () => {
  it("allows only the configured origin when CORS_ORIGINS is set", async () => {
    const restricted = await startServer({
      label: "cors",
      env: {
        CORS_ORIGINS: "https://studypal.example",
        NODE_ENV: "production",
      },
    });

    try {
      const allowed = await restricted.request("OPTIONS", "/api/session", {
        headers: {
          origin: "https://studypal.example",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(
        allowed.headers.get("access-control-allow-origin"),
        "https://studypal.example",
      );

      const denied = await restricted.request("OPTIONS", "/api/session", {
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(
        denied.headers.get("access-control-allow-origin"),
        null,
        "a disallowed origin must not receive an allow-origin header",
      );
    } finally {
      await restricted.stop();
    }
  });

  it("keeps localhost working outside production even when an origin is configured", async () => {
    const configured = await startServer({
      label: "corsdev",
      env: { FRONTEND_URL: "https://studypal.example" },
    });

    try {
      const res = await configured.request("OPTIONS", "/api/session", {
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(
        res.headers.get("access-control-allow-origin"),
        "http://localhost:3000",
      );
    } finally {
      await configured.stop();
    }
  });
});

// ── 7.7 JSON 404 ───────────────────────────────────────────────────────────
describe("7.7 unmatched routes return JSON", () => {
  it("returns a JSON 404 without echoing the request path", async () => {
    const res = await server.request("GET", "/api/does-not-exist");
    assert.equal(await assertJsonError(res, 404), "Not found");
    assert.doesNotMatch(res.text, /does-not-exist/);
    assertNoLeak(res.text);
  });

  it("returns a JSON 404 for a wrong method on a real path", async () => {
    const res = await server.request("GET", "/api/session");
    await assertJsonError(res, 404);
  });
});

// ── 7.8 GET /health ────────────────────────────────────────────────────────
describe("7.8 GET /health", () => {
  it("reports ok with uptime, version and database status", async () => {
    const res = await server.request("GET", "/health");

    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.database, "ok");
    assert.equal(typeof res.body.uptime_seconds, "number");
    assert.ok(res.body.uptime_seconds >= 0);
    assert.equal(typeof res.body.version, "string");
  });

  it("does not contact Gemini", async () => {
    // The fake Gemini transport fails every call in this mode. If /health
    // touched the provider it could not return 200.
    const isolated = await startServer({
      label: "health",
      env: { FAKE_GEMINI_MODE: "network-error", GEMINI_API_KEY: "" },
    });

    try {
      const res = await isolated.request("GET", "/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
    } finally {
      await isolated.stop();
    }
  });

  it("works with no GEMINI_API_KEY set at all", async () => {
    const keyless = await startServer({
      label: "keyless",
      env: { GEMINI_API_KEY: "" },
    });

    try {
      assert.equal((await keyless.request("GET", "/health")).status, 200);
      // History and progress must work without a key too.
      assert.equal((await keyless.request("GET", "/api/history/nobody")).status, 200);
      assert.equal((await keyless.request("GET", "/api/progress/nobody")).status, 200);
    } finally {
      await keyless.stop();
    }
  });
});

// ── Cross-cutting: response headers ────────────────────────────────────────
describe("baseline security headers", () => {
  it("sets hardening headers and hides the framework", async () => {
    const res = await server.request("GET", "/health");

    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(
      res.headers.get("x-powered-by"),
      null,
      "x-powered-by must be disabled",
    );
  });

  it("sets them on error responses too", async () => {
    const res = await server.request("GET", "/nope");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

// ── Cross-cutting: the configured database is the one that is used ─────────
//
// Replaces SP-V2-001's "writes to the configured DATABASE_PATH" test, which
// asserted that a SQLite file appeared on disk. The property being checked is
// the same one — configuration decides where data goes — but the evidence is now
// a row in a named PostgreSQL database rather than the existence of a file.
describe("configuration", () => {
  it("writes to the database named by the connection string", async () => {
    const configured = await startServer({ label: "explicit" });
    const username = testUser("cfg");

    try {
      const res = await configured.request("POST", "/api/session", {
        json: { username },
      });
      assert.equal(res.status, 200);

      // Connect to that database directly — not through the API — and confirm
      // the row landed there and not somewhere else.
      const pool = new Pool({ connectionString: configured.databaseUrl });
      try {
        const { rows } = await pool.query(
          "SELECT username FROM users WHERE username = $1",
          [username],
        );
        assert.equal(
          rows.length,
          1,
          `the row must be in ${configured.databaseName}, the database the ` +
            "server was configured with",
        );
      } finally {
        await pool.end();
      }
    } finally {
      await configured.stop();
    }
  });

  it("refuses to start under NODE_ENV=test with no test database configured", async () => {
    // The guard that stops `npm test` from reaching a real database. An empty
    // STUDYPAL_TEST_DATABASE_URL must be fatal, NOT a silent fall back to
    // DATABASE_URL — which is set in this environment, so a fallback would
    // connect to the developer's working database.
    await assert.rejects(
      () =>
        startServer({
          database: false,
          env: { STUDYPAL_TEST_DATABASE_URL: "" },
        }),
      (err) => {
        assert.match(err.message, /server exited early/);
        assert.match(err.message, /STUDYPAL_TEST_DATABASE_URL is required/);
        return true;
      },
    );
  });
});

// ── Cross-cutting: an unreachable database degrades, it does not crash ─────
describe("database outage behaviour", () => {
  it("still starts and reports 503 from /health when PostgreSQL is unreachable", async () => {
    // Port 1 has nothing listening. The documented decision (see
    // docs/database-architecture.md) is that the server starts anyway and
    // reports its state, rather than crash-looping under an orchestrator.
    const unreachable = await startServer({
      database: false,
      env: {
        STUDYPAL_TEST_DATABASE_URL:
          "postgresql://nobody:nothing@127.0.0.1:1/studypal_test_unreachable",
      },
    });

    try {
      const res = await unreachable.request("GET", "/health");
      assert.equal(res.status, 503);
      assert.equal(res.body.status, "degraded");
      assert.equal(res.body.database, "unavailable");
      assertNoLeak(res.text);
      // The connection error names the host, port and user; it must be logged,
      // not serialised.
      assert.doesNotMatch(res.text, /127\.0\.0\.1|nobody|nothing|ECONNREFUSED/);

      // A data endpoint fails as a clean JSON 500 rather than an HTML page or a
      // hang, and never falls back to a local file.
      const history = await unreachable.request("GET", "/api/history/someone");
      assert.equal(history.status, 500);
      assert.equal(typeof history.body.error, "string");
      assertNoLeak(history.text);
    } finally {
      await unreachable.stop();
    }
  });
});
