/**
 * Black-box server harness for the baseline suite.
 *
 * Spawns a StudyPal backend entrypoint as a real child process on an ephemeral
 * port with the fake-Gemini preload installed, then hands back a small HTTP
 * client bound to that port.
 *
 * The suite that uses this makes no assumptions about the internal structure of
 * the server, which is exactly what lets the same tests run against both the
 * pre-refactor monolith and the post-refactor layered app.
 *
 * Set STUDYPAL_ENTRY to point the harness at a different entrypoint (used to
 * replay the baseline against the original server.js after refactoring).
 *
 * Since SP-V2-002 each started server also gets its own migrated PostgreSQL
 * database, provisioned by tests/helpers/test-database.mjs and dropped by
 * `stop()`. That replaces the per-test SQLite file the old harness relied on:
 * `DATABASE_PATH` no longer means anything, and the isolation it provided for
 * free now has to be arranged explicitly.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIsolatedDatabase } from "./test-database.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(HERE, "..", "..");

const PRELOAD = path.join(HERE, "fake-gemini.mjs");

/** Reserve a free TCP port by binding to 0 and immediately releasing it. */
async function freePort() {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** A username that cannot collide with other runs or with real local data. */
export function testUser(prefix = "test") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * Start the backend. Returns { request, stop, stderr, port }.
 *
 * @param {object} opts
 * @param {string} [opts.entry]   entrypoint, absolute or relative to the backend
 *                                root. Must live INSIDE the backend directory:
 *                                Node resolves a module's imports from its own
 *                                location, so an entrypoint in /tmp cannot find
 *                                express or pg.
 * @param {object} [opts.env]     extra environment variables. Setting
 *                                STUDYPAL_TEST_DATABASE_URL here overrides the
 *                                private database this harness would otherwise
 *                                create — used only by the tests that need a
 *                                specific database.
 * @param {string} [opts.label]   short name for the private database, so a
 *                                leftover one is traceable to its suite
 * @param {boolean} [opts.database=true] set false to start the server with NO
 *                                reachable database, for the degraded-health test
 */
export async function startServer(opts = {}) {
  const entry = opts.entry || process.env.STUDYPAL_ENTRY || "server.js";
  // resolve() rather than join() so an absolute entry is honoured as given.
  const entryPath = path.resolve(BACKEND_ROOT, entry);
  const port = await freePort();

  // Each server gets a private, already-migrated database unless the caller
  // supplies its own connection string. Under NODE_ENV=test the app reads only
  // STUDYPAL_TEST_DATABASE_URL, so this is the whole of the wiring.
  let database = null;
  if (opts.database !== false && !opts.env?.STUDYPAL_TEST_DATABASE_URL) {
    database = await createIsolatedDatabase({ label: opts.label ?? "srv" });
  }

  const child = spawn(
    process.execPath,
    ["--import", PRELOAD, entryPath],
    {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        // The fake never validates the key, but the SDK requires one to exist.
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "fake-key-for-tests",
        NODE_ENV: "test",
        ...(database ? { STUDYPAL_TEST_DATABASE_URL: database.url } : {}),
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const base = `http://127.0.0.1:${port}`;

  // Wait until the port actually accepts connections, or the child dies.
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      // Drop the private database before throwing, or a failing start leaks one
      // per attempt and the server eventually runs out of databases.
      await database?.drop().catch(() => {});
      throw new Error(
        `server exited early (code ${child.exitCode})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) });
      break; // any HTTP response (incl. 404) means it is listening
    } catch {
      if (Date.now() > deadline) {
        await database?.drop().catch(() => {});
        throw new Error(
          `server did not start within 20s\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {object} [opts]
   * @param {object}   [opts.json]    serialised as an application/json body
   * @param {FormData} [opts.form]    sent as multipart (fetch sets the boundary)
   * @param {string}   [opts.body]    raw body, sent exactly as given — used to
   *                                  send deliberately malformed payloads
   * @param {object}   [opts.headers]
   * @returns {Promise<{status: number, headers: Headers, body: object|string, text: string}>}
   */
  async function request(method, pathname, { json, form, body, headers } = {}) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.body = form; // fetch sets the multipart boundary itself
    } else if (body !== undefined) {
      init.body = body;
    }
    const res = await fetch(base + pathname, init);
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  return {
    port,
    base,
    request,
    /** Connection string of this server's private database, if it has one. */
    databaseUrl: database?.url ?? null,
    databaseName: database?.name ?? null,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      // Dropped after the process is gone: PostgreSQL will not drop a database
      // that still has a connected client, and SIGKILL leaves the backends to be
      // reaped, hence WITH (FORCE) inside drop().
      await database?.drop().catch(() => {});
    },
  };
}

/** Build a multipart body for POST /api/ask. */
export function askForm({ username, question, file }) {
  const fd = new FormData();
  if (username !== undefined) fd.append("username", username);
  if (question !== undefined) fd.append("question", question);
  if (file) {
    fd.append(
      "file",
      new Blob([file.content], { type: file.type || "application/octet-stream" }),
      file.name,
    );
  }
  return fd;
}
