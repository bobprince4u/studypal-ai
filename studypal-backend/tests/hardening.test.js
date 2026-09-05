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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { askForm, startServer, testUser } from "./helpers/server-harness.mjs";

let server;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypal-hardening-"));
  server = await startServer({
    env: {
      DATABASE_PATH: path.join(tmpDir, "hardening.db"),
      FAKE_GEMINI_MODE: "json",
    },
  });
});

after(async () => {
  await server?.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
      env: {
        DATABASE_PATH: path.join(tmpDir, "ai-fail.db"),
        FAKE_GEMINI_MODE: "http-error",
      },
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
      env: {
        DATABASE_PATH: path.join(tmpDir, "cors.db"),
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
      env: {
        DATABASE_PATH: path.join(tmpDir, "cors-dev.db"),
        FRONTEND_URL: "https://studypal.example",
      },
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
      env: {
        DATABASE_PATH: path.join(tmpDir, "health.db"),
        FAKE_GEMINI_MODE: "network-error",
        GEMINI_API_KEY: "",
      },
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
      env: { DATABASE_PATH: path.join(tmpDir, "keyless.db"), GEMINI_API_KEY: "" },
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

// ── Cross-cutting: DATABASE_PATH is honoured ───────────────────────────────
describe("configuration", () => {
  it("writes to the configured DATABASE_PATH", async () => {
    const dbPath = path.join(tmpDir, "explicit-path.db");
    const configured = await startServer({ env: { DATABASE_PATH: dbPath } });

    try {
      await configured.request("POST", "/api/session", {
        json: { username: testUser("cfg") },
      });
      assert.ok(
        fs.existsSync(dbPath),
        "DATABASE_PATH must control where the database is created",
      );
    } finally {
      await configured.stop();
    }
  });
});
