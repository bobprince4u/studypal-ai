# StudyPal Security Baseline

Established during **SP-V2-001** (baseline + backend architecture refactor).

This is a record, not a security audit. It states what protections the codebase
already had, what this iteration found, what it fixed, and what it consciously
left alone — so the next iteration starts from facts rather than from a re-read
of the diff.

Scope note: SP-V2-001 was instructed to fix only what could be addressed safely
without expanding into a full security project. Several findings below are
therefore recorded and deferred rather than fixed. Each says where it belongs.

---

## 1. Protections that already existed

These were correct before this iteration and were preserved unchanged.

| # | Protection | Where |
| --- | --- | --- |
| P1 | **All SQL is parameterised.** Every query goes through a `better-sqlite3` prepared statement with bound parameters; no value is ever concatenated into SQL. | `src/repositories/*.js` (moved verbatim from `server.js`) |
| P2 | **Secrets come from the environment**, never from source. No key, token or connection string is committed. | `src/config/env.js` |
| P3 | **`.gitignore` excludes real env files and databases** — `.env`, `.env.local`, `.env.*.local`, `*.db`, `*.db-shm`, `*.db-wal`. Only `.env.example` is tracked; verified with `git ls-files`. | `studypal-backend/.gitignore` |
| P4 | **Uploads never touch the filesystem.** multer uses `memoryStorage()`, so there is no upload directory, no path traversal via `originalname`, and no arbitrary file write. | `src/middleware/upload.js` |
| P5 | **No shell execution and no dynamic evaluation** anywhere in the backend. No `child_process`, no `eval`, no `new Function`. | verified across `src/` |
| P6 | **Usernames are unique at the schema level** (`sessions.username TEXT UNIQUE NOT NULL`), and session creation uses `INSERT OR IGNORE`, so re-login cannot duplicate or overwrite a row. | `migrations/001_initial_schema.sql` |
| P7 | **The frontend escapes all model output.** Answers, topics and filenames are rendered as JSX text; there is no `dangerouslySetInnerHTML` in the app. A malicious document cannot get script into the page through an answer. | `studypal-frontend/app/page.jsx` |
| P8 | **JSON request bodies were already bounded** by `express.json()`'s 100 kb default. That limit is now explicit and configurable rather than implicit, but the value is unchanged. | `src/app.js` |

---

## 2. Issues discovered

Numbered `S*` and referenced from the sections below. Severity is this project's
own judgement: **High** = exploitable now with real impact, **Medium** = real but
bounded or requires unusual conditions, **Low** = hygiene.

| # | Severity | Finding |
| --- | --- | --- |
| **S1** | **High** | **No authentication or authorization at all.** A username is an identity claim, nothing more: `POST /api/session` accepts any string and `GET /api/history/:username` / `GET /api/progress/:username` return that user's full study history to anyone who asks. Guessing or enumerating a name is the entire attack. |
| **S2** | **High** | **Stack traces leaked to clients.** Malformed input (a non-string `username`, an absent body, a `text/plain` body) reached an unguarded destructure and produced Express's default HTML 500 containing absolute server paths and internal frames. Measured, not theorised — see `docs/current-architecture.md`. |
| **S3** | **Medium** | **Upstream provider errors forwarded verbatim.** `/api/ask` responded `{"error": "AI request failed: " + err.message}`, exposing whatever Gemini said — quota state, project detail, request URLs, key-state hints. |
| **S4** | **High** | **Unbounded upload size into memory.** `multer({storage: memoryStorage()})` was configured with no `limits`, so an anonymous caller could push arbitrarily large bodies straight into the Node heap. Trivial denial of service. |
| **S5** | **Medium** | **No upload type restriction.** Any extension was accepted; anything not an image or PDF was read as UTF-8 and forwarded to the model. A `.exe` returned `200`. |
| **S6** | **Medium** | **CORS open to every origin unconditionally** (bare `cors()` → `Access-Control-Allow-Origin: *`), with no way to restrict it short of a code change. |
| **S7** | **High** | **No rate limiting on a paid, unauthenticated endpoint.** `POST /api/ask` bills a Gemini call per request with no per-IP or per-user ceiling. This is a direct financial denial-of-wallet exposure. |
| **S8** | **Medium** | **Prompt injection.** The student's text is concatenated into the same turn as the instructions with no delimiter or role separation, so document or question content can redirect the model. |
| **S9** | **High** | **7 known dependency vulnerabilities in the backend** (1 critical `protobufjs`, high in `multer` — a direct dependency — plus `path-to-regexp` and `ws`, moderate `qs` and `@protobufjs/utf8`, low `body-parser`) and **4 high in the frontend** (`next` direct, plus `nanoid`, `postcss`, `sharp`). |
| **S10** | **Low** | **No security response headers**, and `X-Powered-By: Express` advertised the framework and version family on every response. |
| **S11** | **Medium** | **Configuration failed silently.** `import "dotenv/config"` reads only `.env`, but the repository ships `.env.local` — so `GEMINI_API_KEY` was routinely `undefined` and the failure surfaced as a confusing AI error. Separately, `.env.example` shipped `PORT=your_port`; copied literally, Node interprets a non-numeric `PORT` as a **Unix socket path**, so the server binds a file named `your_port` and no TCP listener exists. |
| **S12** | **Low** | **Unbounded username length** written to the database from an unauthenticated endpoint. |
| **S13** | **Low** | **No request logging.** Nothing recorded who called what, so there was no audit trail and no way to detect abuse. |
| **S14** | **Low** | **No graceful shutdown.** `SIGTERM` from a container runtime killed in-flight requests and left the SQLite WAL unchecked. |
| **S15** | **Low** | **User-controlled filename stored and echoed.** `file.originalname` is persisted and returned by `/api/history`. Harmless in the current React client (P7), but it is reflected user input and any future non-escaping consumer would inherit the problem. |

---

## 3. Issues fixed in this iteration

Every fix here is covered by a test in `tests/hardening.test.js`, and the
behavioural changes visible to a client are enumerated in
`docs/api-contract.md` §7.

| Fixes | Change | Verified by |
| --- | --- | --- |
| **S2** | Central error handler. Every error response is JSON with an `error` string; stack traces, SQLite messages, filesystem paths and upstream detail are logged server-side and never serialised. Malformed input now yields the endpoint's existing `400` message instead of an HTML `500`. | `7.1`, `7.2`, plus an explicit "no stack frame, no absolute path, no HTML" assertion on every error response |
| **S3** | `/api/ask` returns a fixed `{"error":"AI request failed"}`. Status code and body shape are unchanged; the provider's message is logged, not sent. | `7.4` |
| **S4** | Upload limits: `fileSize` (default 10 MB, `MAX_UPLOAD_BYTES`), `files: 1`, plus `fields`/`fieldSize` bounds so the whole multipart body is capped. Over-limit → `413`. | `7.5` |
| **S5** | Extension allowlist → `415` for anything outside it. The allowlist is a **superset** of the frontend's `accept` attribute plus the text formats the old code already handled usefully, so no upload a user can make through the UI is newly rejected — asserted explicitly. | `7.5` |
| **S6** | CORS is environment-driven: `FRONTEND_URL` / `CORS_ORIGINS` define an allowlist; unset keeps the previous permissive behaviour **and logs a startup warning**. Loopback origins stay allowed outside production so configuring a deployment cannot lock a developer out. | `7.6` |
| **S9** | `npm audit fix` (in-range only, no `--force`, no major bumps) in both packages: **7 → 0** backend, **4 → 0** frontend. `package.json` was not modified in either — every fix fell inside existing semver ranges. `multer 2.1.1 → 2.3.0`, `next 16.2.1 → 16.3.4`. | full backend suite (59/59) and `next build` re-run after the fix |
| **S10** | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Strict-Transport-Security` in production only, and `app.disable("x-powered-by")`. Set before routing, so they are present on error responses too. | header assertions on both a success and a `404` |
| **S11** | `src/config/env.js` loads `.env.local` then `.env` (first wins, and a real environment variable beats both). `PORT` and every other numeric variable is validated — a non-numeric value now fails loudly at startup instead of binding a Unix socket. `.env.example` rewritten with correct, documented defaults. | startup warning list; `int()` validation |
| **S12** | Username bounded at 200 characters (`MAX_USERNAME_LENGTH`) on both write endpoints. | `7.3` |
| **S13** | One-line request log per request with method, path, status and duration. Silent under `NODE_ENV=test`. | — |
| **S14** | `SIGTERM`/`SIGINT` stop the listener, drain in-flight requests, close the database, then exit; a 10 s timer prevents hanging forever. | — |
| — | Unmatched routes return `404 {"error":"Not found"}` instead of Express's HTML page, without echoing the requested path back. | `7.7` |
| — | `GET /health` added. Checks the local database only — it never contacts Gemini, so a provider outage cannot take the service out of rotation and probes cost no quota. Asserted to return `200` with `GEMINI_API_KEY` unset entirely. | `7.8` |

**No new runtime dependency was added to fix any of the above.** The security
headers are eight `setHeader` calls, and validation is thirty lines; neither
justified a package in an iteration whose remit is structure.

---

## 4. Issues deferred

Recorded deliberately, with the reason and where each belongs. Nothing here is
"forgotten" — leaving it undone was a decision.

| # | Deferred | Why, and where it belongs |
| --- | --- | --- |
| **S1** | **Authentication and authorization** | **The single largest gap in the product**, and explicitly out of scope for SP-V2-001. It is also not purely technical: it needs a product decision about what an account is for students who may share devices and have no reliable email. Until it exists, treat all stored study history as public to anyone who knows a username. Should be its own ticket, before any feature that stores something a student would mind others reading. |
| **S7** | **Rate limiting** | Needs a dependency (`express-rate-limit` or equivalent) and two decisions this iteration cannot make: the limit itself, and whether a shared store is required behind more than one instance. **This is the highest-value deferred item** — it is the only finding with an unbounded financial cost, and it becomes urgent the moment the API is publicly reachable. Recommended for SP-V2-002. |
| **S8** | **Prompt injection** | The student's text and the instructions share a turn. Fixing it properly means restructuring the prompt — separate system instruction, delimited user content — which **changes model output**, and this iteration's whole purpose was to change structure while holding behaviour fixed. Belongs with the RAG work, where untrusted retrieved text makes it materially worse. |
| **S15** | **Reflected filename** | Left as-is because the only consumer escapes it (P7) and normalising stored filenames would alter existing `/api/history` responses. Worth handling if a non-React consumer is ever added. |
| — | **`helmet`** | Deliberately not added. This is a JSON API with no HTML responses and no cookies, so most of what helmet sets is inert here and the meaningful headers are already set by hand. It becomes the right answer the moment the service serves anything browser-rendered. |
| — | **AI request timeout** | Wired and configurable (`AI_TIMEOUT_MS`) but **defaults to 0 = off**, matching the previous behaviour. A generation has no upper bound today, so a stalled provider connection holds a socket indefinitely. Turning it on is a one-variable change; it is off by default only so this refactor cannot be blamed for a newly-failing slow request. Should be enabled with a measured value. |
| — | **Extension spoofing** | Accepted, not fixed. The allowlist checks the extension, so `payload.exe` renamed to `payload.txt` passes. This gains an attacker nothing: the content is read as text or base64 and sent to Gemini, never executed, never written to disk, never served back. Magic-byte sniffing would add a dependency to close a hole that does not lead anywhere. |
| — | **Third-party data disclosure** | Every uploaded document and question is sent to Google. That is inherent to the product, but it is not currently disclosed to students anywhere in the UI. This is a privacy/consent matter for the product owner, not a code fix. |
| — | **Encryption at rest** | The SQLite file is unencrypted. Appropriate for local development; a deployment storing real student work should consider SQLCipher or full-disk encryption, and needs a backup story either way. Belongs with the data-layer work in SP-V2-002. |
| — | **HTTPS enforcement** | Not done at the application layer, which is correct — TLS termination belongs at the proxy or platform. HSTS is emitted in production so the browser cooperates once TLS is present. |

---

## 5. Recommended order for the next iteration

1. **Rate limit `POST /api/ask`** (S7) — unbounded cost, cheapest fix, no product decision needed.
2. **Authentication** (S1) — largest gap; blocks anything privacy-sensitive.
3. **Enable `AI_TIMEOUT_MS`** with a measured value.
4. **Prompt injection** (S8) — pair it with the RAG work, which makes it worse.

## 6. Re-running the checks

```bash
cd studypal-backend
npm audit                 # expect 0 vulnerabilities
npm test                  # 59 tests: 35 baseline contract + 24 hardening
npm run test:baseline     # 35 — the subset that also passes pre-refactor

cd ../studypal-frontend
npm audit                 # expect 0 vulnerabilities
npx next build
```
