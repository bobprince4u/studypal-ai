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
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 *                                express or better-sqlite3.
 *
 *                                For the pre-refactor server, put it one level
 *                                down (.baseline/server.mjs). That server
 *                                hardcoded `new Database(path.join(__dirname,
 *                                "studypal.db"))` and ignored DATABASE_PATH, so
 *                                running it from the backend root writes test
 *                                rows into the real studypal.db.
 * @param {object} [opts.env]     extra environment variables
 */
export async function startServer(opts = {}) {
  const entry = opts.entry || process.env.STUDYPAL_ENTRY || "server.js";
  // resolve() rather than join() so an absolute entry is honoured as given.
  const entryPath = path.resolve(BACKEND_ROOT, entry);
  const port = await freePort();

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
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGKILL");
      await once(child, "exit");
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
