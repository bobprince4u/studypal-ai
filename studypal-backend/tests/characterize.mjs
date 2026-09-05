/**
 * Characterization probe — NOT part of the test suite.
 *
 * Exercises the running backend as a black box and dumps every observable
 * detail (status, headers, body) so that docs/api-contract.md can be written
 * from measured behaviour rather than from reading the source and guessing.
 *
 * Usage: node tests/characterize.mjs [entry]
 */

import { startServer, askForm, testUser } from "./helpers/server-harness.mjs";

const entry = process.argv[2] || "server.js";
const out = [];
const log = (...a) => out.push(a.join(" "));

function show(label, r) {
  log(`\n### ${label}`);
  log(`status: ${r.status}`);
  log(`content-type: ${r.headers.get("content-type")}`);
  const cors = [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "x-powered-by",
    "x-content-type-options",
    "x-frame-options",
    "content-security-policy",
    "strict-transport-security",
    "ratelimit-limit",
  ]
    .map((h) => [h, r.headers.get(h)])
    .filter(([, v]) => v !== null);
  log(`notable headers: ${JSON.stringify(Object.fromEntries(cors))}`);
  log(
    `body: ${typeof r.body === "string" ? JSON.stringify(r.body.slice(0, 300)) : JSON.stringify(r.body, null, 2).slice(0, 1200)}`,
  );
}

const srv = await startServer({ entry });
log(`# Characterization of ${entry} (port ${srv.port})`);

try {
  const user = testUser("charz");

  // ── Unknown route / root ────────────────────────────────────────────────
  show("GET / (unrouted)", await srv.request("GET", "/"));
  show("GET /health", await srv.request("GET", "/health"));
  show("GET /api/health", await srv.request("GET", "/api/health"));

  // ── CORS preflight ──────────────────────────────────────────────────────
  show(
    "OPTIONS /api/ask (preflight from evil.example)",
    await srv.request("OPTIONS", "/api/ask", {
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    }),
  );

  // ── POST /api/session ───────────────────────────────────────────────────
  show(
    "POST /api/session (valid)",
    await srv.request("POST", "/api/session", { json: { username: user } }),
  );
  show(
    "POST /api/session (same user again — idempotency)",
    await srv.request("POST", "/api/session", { json: { username: user } }),
  );
  show(
    "POST /api/session (untrimmed '  spaced  ')",
    await srv.request("POST", "/api/session", {
      json: { username: `  ${user}_sp  ` },
    }),
  );
  show(
    "POST /api/session (missing username)",
    await srv.request("POST", "/api/session", { json: {} }),
  );
  show(
    "POST /api/session (whitespace-only username)",
    await srv.request("POST", "/api/session", { json: { username: "   " } }),
  );
  show(
    "POST /api/session (username = number 42)",
    await srv.request("POST", "/api/session", { json: { username: 42 } }),
  );
  show(
    "POST /api/session (no body at all)",
    await srv.request("POST", "/api/session"),
  );
  show(
    "POST /api/session (malformed JSON)",
    await srv.request("POST", "/api/session", {
      headers: { "content-type": "application/json" },
      form: "{not json",
    }),
  );
  show(
    "POST /api/session (2000-char username)",
    await srv.request("POST", "/api/session", {
      json: { username: "L".repeat(2000) },
    }),
  );

  // ── POST /api/ask ───────────────────────────────────────────────────────
  show(
    "POST /api/ask (valid, no file)",
    await srv.request("POST", "/api/ask", {
      form: askForm({ username: user, question: "Explain photosynthesis" }),
    }),
  );
  show(
    "POST /api/ask (missing question)",
    await srv.request("POST", "/api/ask", {
      form: askForm({ username: user }),
    }),
  );
  show(
    "POST /api/ask (missing username)",
    await srv.request("POST", "/api/ask", {
      form: askForm({ question: "hello" }),
    }),
  );
  show(
    "POST /api/ask (blank question)",
    await srv.request("POST", "/api/ask", {
      form: askForm({ username: user, question: "   " }),
    }),
  );
  show(
    "POST /api/ask (JSON body instead of multipart)",
    await srv.request("POST", "/api/ask", {
      json: { username: user, question: "json not multipart" },
    }),
  );
  show(
    "POST /api/ask (username never registered via /api/session)",
    await srv.request("POST", "/api/ask", {
      form: askForm({ username: "ghost_never_registered", question: "hi" }),
    }),
  );
  show(
    "POST /api/ask (.txt file)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "summarise the attachment",
        file: { name: "notes.txt", type: "text/plain", content: "cell biology notes" },
      }),
    }),
  );
  show(
    "POST /api/ask (.png image)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "what is in this image",
        file: { name: "diagram.png", type: "image/png", content: "\x89PNG\r\n\x1a\nfake" },
      }),
    }),
  );
  show(
    "POST /api/ask (unparseable .pdf)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "summarise this pdf",
        file: { name: "broken.pdf", type: "application/pdf", content: "not really a pdf" },
      }),
    }),
  );
  show(
    "POST /api/ask (.exe — extension NOT in frontend accept list)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "what is this",
        file: { name: "payload.exe", type: "application/octet-stream", content: "MZ\x00\x00binary" },
      }),
    }),
  );
  show(
    "POST /api/ask (file with NO extension)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "what is this",
        file: { name: "README", type: "text/plain", content: "no extension here" },
      }),
    }),
  );
  show(
    "POST /api/ask (8MB upload — file size limit probe)",
    await srv.request("POST", "/api/ask", {
      form: askForm({
        username: user,
        question: "big file",
        file: { name: "big.txt", type: "text/plain", content: "A".repeat(8 * 1024 * 1024) },
      }),
    }),
  );

  // Fenced / prose / error AI modes need a server restart to change env.
  for (const mode of ["fenced", "prose", "http-error", "network-error"]) {
    const s2 = await startServer({ entry, env: { FAKE_GEMINI_MODE: mode } });
    try {
      show(
        `POST /api/ask (Gemini mode=${mode})`,
        await s2.request("POST", "/api/ask", {
          form: askForm({ username: user, question: `mode ${mode}` }),
        }),
      );
      if (mode === "http-error" || mode === "network-error") {
        log(`server stderr during ${mode}: ${JSON.stringify(s2.stderr.slice(0, 400))}`);
      }
    } finally {
      await s2.stop();
    }
  }

  // ── GET /api/history/:username ──────────────────────────────────────────
  show(
    "GET /api/history/:username (populated)",
    await srv.request("GET", `/api/history/${encodeURIComponent(user)}`),
  );
  show(
    "GET /api/history/:username (unknown user)",
    await srv.request("GET", "/api/history/nobody_at_all_xyz"),
  );
  show(
    "GET /api/history/:username (SQLi probe)",
    await srv.request(
      "GET",
      `/api/history/${encodeURIComponent("' OR 1=1 --")}`,
    ),
  );

  // ── GET /api/progress/:username ─────────────────────────────────────────
  show(
    "GET /api/progress/:username (populated)",
    await srv.request("GET", `/api/progress/${encodeURIComponent(user)}`),
  );
  show(
    "GET /api/progress/:username (unknown user)",
    await srv.request("GET", "/api/progress/nobody_at_all_xyz"),
  );
} finally {
  await srv.stop();
}

console.log(out.join("\n"));
