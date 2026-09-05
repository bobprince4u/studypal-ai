# StudyPal — Architecture

> **How to read this document.** Sections 1–15 describe the system **as it
> existed at the start of SP-V2-001**, before any refactoring. They are written
> from the actual source code and from measured black-box behaviour (see
> [`tests/characterize.mjs`](../tests/characterize.mjs)), not from the README —
> the README was inaccurate in several places, which is itself recorded below.
>
> **[Section 16](#16-architecture-after-sp-v2-001) describes the architecture as
> it is now**, after the refactor.
>
> The baseline sections are kept rather than overwritten because the problem
> inventory in §9–§11 is referenced by number (`A1`…`A18`) from
> [`api-contract.md`](./api-contract.md) and
> [`security-baseline.md`](./security-baseline.md), and because the measured
> "before" behaviour is the evidence that the refactor preserved it.

- Baseline characterized at: `634c9d8` (branch `feature/studypal-v2-baseline`)
- Node.js: v22.21.1, npm 11.8.0
- Date: 2026-09-05

---

## 1. System overview

StudyPal is a two-process web application:

```
┌──────────────────────────┐         ┌───────────────────────────┐        ┌──────────────┐
│  studypal-frontend       │  HTTP   │  studypal-backend         │  HTTPS │  Google      │
│  Next.js 16 (App Router) │ ──────► │  Express 5 (single file)  │ ─────► │  Gemini API  │
│  one client component    │  JSON / │  server.js — 199 lines    │        │              │
│  localhost:3000          │  multi- │  localhost:4000           │        └──────────────┘
└──────────────────────────┘  part   └───────────┬───────────────┘
                                                 │ better-sqlite3 (in-process)
                                                 ▼
                                        studypal.db (SQLite, WAL)
```

There is no authentication, no session token, and no server-side rendering of
application data. A "session" is simply a username string that the client sends
on every subsequent request.

The repository is a plain two-directory monorepo with **no workspace tooling** —
each package is installed and run independently.

```
studypal-frontend/            ← repository root (confusingly named)
├── README.md
├── studypal-backend/         ← Express API
└── studypal-frontend/        ← Next.js UI
```

> **Note.** The repository root directory is itself named `studypal-frontend`,
> and contains a `studypal-frontend` subdirectory. The README refers to these
> as `backend/` and `frontend/`, which do not exist.

---

## 2. Frontend architecture

Single package, three source files:

| File | Lines | Role |
| --- | --- | --- |
| `app/page.jsx` | 1271 | **Entire application.** `"use client"` — all UI, state and API calls. |
| `app/layout.js` | 30 | Root layout, metadata, viewport, Google Fonts `<link>`. |
| `app/globals.css` | 324 | CSS custom properties (`--gold`, `--cream`, …) and animations. |

### Characteristics

- **One client component.** `page.jsx` is `"use client"` in its entirety, so no
  React Server Component or data-fetching feature of the App Router is used.
  The App Router is effectively used as a static shell.
- **All styling is inline `style={{…}}`** except the animation classes and CSS
  variables in `globals.css`. There is no Tailwind, CSS module or component
  library.
- **No `next.config.js`** exists.
- **No `.env.local`** and no `.env.local.example` exist in the frontend, despite
  the README instructing `cp .env.local.example .env.local`.
- **State is entirely local** to the `Home` component: `screen`, `username`,
  `messages`, `history`, `progress`, `file`, plus mobile/desktop layout state.
  Nothing is persisted client-side — a page refresh returns to the login screen.
- **Responsive strategy is JS-based**, not CSS: `useIsMobile()` listens to
  `resize` and switches between two entirely separate render trees at 768px.

### Screens

1. `screen === "login"` — asks for a name/student ID, calls `POST /api/session`.
2. `screen === "app"` — three-pane desktop grid (`280px 1fr 260px`: history /
   chat / progress) or a mobile single-pane view with a bottom tab bar.

### API base URL

```js
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
```

`NEXT_PUBLIC_API_URL` is the only frontend environment variable. It is not
documented in any `.env` example file.

---

## 3. Backend architecture

**The entire backend is one 199-line file: `studypal-backend/server.js`.**

Everything lives at module scope in a single file, in this order:

| `server.js` lines | Concern |
| --- | --- |
| 1–8 | Imports |
| 10–13 | `__dirname`, Express app, multer instance, **Gemini client** |
| 15–16 | `cors()` and `express.json()` middleware |
| 18–37 | **Database open + schema DDL** executed at import time |
| 39–52 | `POST /api/session` — HTTP + validation + 2 SQL statements |
| 54–154 | `POST /api/ask` — HTTP + validation + **prompt text** + file processing + Gemini call + JSON-repair + SQL insert |
| 156–180 | `GET /api/history/:username` — SQL + row mapping |
| 182–193 | `GET /api/progress/:username` — 2 SQL aggregates |
| 195–199 | `app.listen()` |

### There are no layers

`POST /api/ask` alone contains, inline in one handler:

- request parsing and validation
- the full system prompt as a template literal
- file-type dispatch by filename extension
- base64 encoding of image uploads
- a dynamic `import("pdf-parse")` for PDFs
- the Gemini SDK call and model name
- three-tier JSON parse/repair logic
- the `INSERT` into `questions`
- the success response and the `catch` that formats the 500

### Consequences

- **Nothing is unit-testable.** `server.js` calls `app.listen()` and constructs
  `new GoogleGenAI(...)` as a side effect of import, so it cannot be imported by
  a test without starting a server and a real AI client. There is no exported
  `app`.
- **The AI provider is not abstracted.** `GoogleGenAI`, the model id
  `gemini-3-flash-preview` and `config.responseMimeType` are referenced directly
  inside the route handler.
- **Configuration is read ad hoc.** `process.env.GEMINI_API_KEY` (line 13) and
  `process.env.PORT` (line 196) are read at their point of use, with no
  validation and no single source of truth.
- **No error-handling middleware.** Each handler has (at most) its own
  `try/catch`; anything unanticipated falls through to Express's default error
  handler, which returns an **HTML page containing a full stack trace**
  (measured — see §9).

---

## 4. Current API endpoints

Four endpoints, all under `/api`. Full request/response detail, including every
measured error case, is in [`api-contract.md`](./api-contract.md).

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/api/session` | JSON `{username}` | `200 {username, created_at}` |
| POST | `/api/ask` | multipart `username`, `question`, `file?` | `200 <AI answer object>` |
| GET | `/api/history/:username` | — | `200 [<history item>, …]` (≤30) |
| GET | `/api/progress/:username` | — | `200 {total_questions, topics[]}` |

**There is no health endpoint.** `GET /health`, `GET /api/health` and `GET /`
all return `404` with an HTML body.

---

## 5. Request/response behaviour

### Notable measured behaviours

- **`POST /api/ask` accepts JSON as well as multipart.** `express.json()` is
  registered globally before the route, and multer passes non-multipart requests
  through untouched, so a JSON body `{username, question}` succeeds identically.
  This is almost certainly unintentional but it is part of the current contract.
- **`POST /api/ask` does not require a session.** A username that was never sent
  to `/api/session` is accepted and its question is stored. There is no foreign
  key between `questions.username` and `sessions.username`.
- **`/api/session` is idempotent** via `INSERT OR IGNORE`; a repeat call returns
  the *original* `created_at`.
- **Usernames are trimmed** on `/api/session` (`username.trim()`) but **not** on
  `/api/ask`, `/api/history/:username` or `/api/progress/:username`. A username
  with surrounding whitespace therefore creates a session under the trimmed name
  while questions may be stored under the untrimmed name.
- **There is no username length limit.** A 2000-character username is accepted
  and stored.
- **The response to `/api/ask` is whatever the model produced**, passed through
  unvalidated. The server guarantees the JSON *envelope* parses but never checks
  that `explanation`, `topic`, `practice_questions` or `encouragement` exist or
  have the right types.

### AI response repair (three tiers)

`server.js:118–135` — on each `/api/ask`:

1. `JSON.parse(raw)`.
2. On failure, strip ``` / ```json fences and parse again.
3. On failure, fabricate
   `{explanation: raw, topic: "Study Topic", practice_questions: [], encouragement: "Keep going!"}`.

Tier 3 is a **silent degradation**: the client receives `200` with zero practice
questions and a placeholder topic, indistinguishable from a real answer.

---

## 6. Database schema

SQLite via `better-sqlite3` (synchronous, in-process). File:
`studypal-backend/studypal.db`, `journal_mode = WAL`.

The schema is created by `db.exec(...)` at import time with
`CREATE TABLE IF NOT EXISTS` — **there are no migrations**.

```sql
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL          -- ISO-8601 string
);

CREATE TABLE questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,          -- NOT a foreign key
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,          -- JSON.stringify of the whole AI object
  topic      TEXT DEFAULT 'Study Topic',
  has_file   INTEGER DEFAULT 0,      -- 0/1, mapped to boolean on read
  filename   TEXT,                   -- original client-supplied filename
  created_at TEXT NOT NULL           -- ISO-8601 string
);
```

### Observations

- **`answer` is a serialised JSON blob.** The whole model response is
  `JSON.stringify`-ed into one TEXT column, then re-parsed on read. `topic` is
  additionally denormalised into its own column.
- **No indexes** beyond the primary keys and the implicit unique index on
  `sessions.username`. Every `/api/history` and `/api/progress` call therefore
  performs a **full scan of `questions`**, and `ORDER BY created_at DESC` is an
  unindexed sort.
- **`created_at` is TEXT, not a date type.** Ordering works only because
  ISO-8601 sorts lexicographically. Ordering by a string also means ties
  (same-millisecond inserts) have undefined order.
- **No `updated_at`, no soft delete, no user table** — `sessions` is effectively
  a username registry, not a session store.
- `foreign_keys` pragma reports `1` (better-sqlite3 v12 default) but no foreign
  keys are declared, so it has no effect.

### Queries in use

| Location | Query |
| --- | --- |
| `server.js:45` | `INSERT OR IGNORE INTO sessions (username, created_at) VALUES (?, ?)` |
| `server.js:48` | `SELECT * FROM sessions WHERE username = ?` |
| `server.js:137` | `INSERT INTO questions (username, question, answer, topic, has_file, filename, created_at) VALUES (?,?,?,?,?,?,?)` |
| `server.js:158` | `SELECT question, answer, topic, has_file, filename, created_at FROM questions WHERE username = ? ORDER BY created_at DESC LIMIT 30` |
| `server.js:184` | `SELECT COUNT(*) as c FROM questions WHERE username = ?` |
| `server.js:187` | `SELECT topic, COUNT(*) as count FROM questions WHERE username = ? GROUP BY topic ORDER BY count DESC LIMIT 6` |

All six use bound parameters. **No string interpolation into SQL anywhere** — a
`' OR 1=1 --` username was probed and returned `[]`.

---

## 7. Gemini integration

```js
// server.js:6, 13
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// server.js:112–116  (inside the POST /api/ask handler)
const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents,
  config: { responseMimeType: "application/json" },
});
const raw = response.text.trim();
```

- SDK: `@google/genai@1.46.0`.
- Model id `gemini-3-flash-preview` is a hardcoded string literal inside the
  route handler.
- `responseMimeType: "application/json"` requests JSON mode, which is why the
  fence-stripping fallback rarely fires in practice — but it is still reachable.
- **The client is constructed at import time** with whatever
  `process.env.GEMINI_API_KEY` happens to be. If the variable is absent the
  client is still created; the failure only surfaces as a `500` on the first
  `/api/ask`.
- **No timeout, no retry, no token/cost accounting, no request logging.**
- The SDK issues its requests through the bare global `fetch`, which is the seam
  the baseline test suite uses to stub it.

### The prompt

The system prompt is a template literal at `server.js:60–71`, inside the
handler. It is concatenated with the student question as a single `text` part:

```js
const contents = [{ role: "user",
  parts: [{ text: systemPrompt + "\n\nStudent question: " + question }] }];
```

Notes:

- There is no `systemInstruction` — the "system prompt" is sent as user text.
- **The student's question is concatenated directly into the prompt** with no
  delimiting, so a question is free to contradict the instructions (prompt
  injection). This is inherent to the current design.
- No `responseSchema` is supplied even though JSON mode is on, so the key names
  are only requested in prose.

---

## 8. File upload flow

```js
// server.js:12
const upload = multer({ storage: multer.memoryStorage() });   // no limits
// server.js:55
app.post("/api/ask", upload.single("file"), async (req, res) => {
```

Dispatch is **by filename extension only** (`server.js:86`):

```js
const ext = filename.split(".").pop().toLowerCase();
```

| Extension | Handling |
| --- | --- |
| `jpg`, `jpeg`, `png`, `gif`, `webp` | base64 → `inlineData` part; MIME derived from the extension |
| `pdf` | dynamic `import("pdf-parse")`, text sliced to 4000 chars; on throw, a `[A PDF was uploaded but could not be parsed.]` text part |
| **anything else** | `buffer.toString("utf-8").slice(0, 4000)` as a text part |

Data flow:

```
browser <input accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.gif">
   ↓ FormData
multer memoryStorage  →  req.file.buffer  (entire file in RAM, unbounded)
   ↓ extension switch
Gemini `contents[0].parts`  (image inlineData, or ≤4000 chars of text)
   ↓
questions.has_file = 1, questions.filename = <client-supplied originalname>
```

The file itself is **never persisted** — only the filename is stored. There is
no `uploads/` directory in use (though `.gitignore` anticipates one).

Measured: `.exe`, extension-less files and an 8 MB text file are all accepted
with `200`. See §9 and [`security-baseline.md`](./security-baseline.md).

---

## 9. Known architectural problems

| # | Problem | Evidence |
| --- | --- | --- |
| A1 | **No separation of concerns.** HTTP, validation, prompt text, AI SDK, file parsing and SQL are interleaved in single handlers. | `server.js:55–154` |
| A2 | **Not testable.** `app.listen()` and `new GoogleGenAI()` run at import; `app` is never exported. | `server.js:13, 197` |
| A3 | **AI provider not abstracted.** Swapping or wrapping Gemini requires editing the route handler. | `server.js:112` |
| A4 | **Prompt is inline.** Cannot be versioned, diffed or reused. | `server.js:60–71` |
| A5 | **No error-handling middleware.** Unhandled throws produce Express's default HTML + stack trace. | measured, §9 below |
| A6 | **No validation layer.** Non-string `username` reaches `.trim()` and throws a `TypeError`. | `POST /api/session {username: 42}` → `500` |
| A7 | **Config read inline, unvalidated.** No single config module; a missing API key is not detected at startup. | `server.js:13, 196` |
| A8 | **No migrations.** Schema is `CREATE TABLE IF NOT EXISTS` at import; there is no way to evolve it. | `server.js:21–37` |
| A9 | **No indexes on `questions`.** Both read endpoints full-scan. | §6 |
| A10 | **Silent AI degradation.** Unparseable model output returns `200` with a placeholder answer. | `server.js:128–133` |
| A11 | **`answer` stored as an opaque JSON blob.** Not queryable; blocks the analytics work V2 needs. | §6 |
| A12 | **`dotenv/config` loads `.env`, but the repo ships `.env.local`.** The committed example says `.env`; the working tree has `.env.local`, which dotenv does **not** read by default. `GEMINI_API_KEY` is therefore silently `undefined` unless exported in the shell. | `server.js:1`; `ls studypal-backend` |
| A13 | **`.env.example` is not usable as written** — it contains `PORT=your_port`, which is not a port number. | `.env.example` |
| A14 | **README does not match the repository.** It documents `backend/` and `frontend/` (actual: `studypal-backend/`, `studypal-frontend/`) and tells the user to copy a `.env.local.example` that does not exist. | `README.md` |
| A15 | **`package.json` metadata is wrong.** `main: "index.js"` (no such file) and `"test": "npm run dev"` — running the test script starts a dev server that never exits. | `package.json` |
| A16 | **No request logging.** There is no way to see what the API served. | `server.js` (only `console.error`) |
| A17 | **Frontend ignores HTTP status on `/api/ask`.** It renders the parsed body as an AI message regardless, so a `500 {error}` shows as a blank assistant bubble. | `page.jsx:583–592` |
| A18 | **Username-as-identity.** Anyone who knows a username can read that user's entire history and progress. Anyone can also claim any username. | `/api/history/:username` |

### Measured error leakage

| Request | Status | Body |
| --- | --- | --- |
| `POST /api/session` `{username: 42}` | `500` | **HTML with full stack trace**, including absolute server paths |
| `POST /api/session` with no body | `500` | **HTML with full stack trace** |
| `POST /api/session` with malformed JSON | `400` | **HTML with `SyntaxError` stack trace** |
| `POST /api/session` with a 200 KB body | `413` | HTML `PayloadTooLargeError` stack trace |
| `POST /api/ask` with `content-type: text/plain` | `500` | **HTML with full stack trace** |
| `GET /nonexistent` | `404` | HTML `Cannot GET /nonexistent` |
| `POST /api/ask` when Gemini fails | `500` | `{"error":"AI request failed: <raw upstream message>"}` — echoes the provider's error verbatim |

---

## 10. Existing security concerns

Summarised here; the full assessment, with what was fixed and what was deferred,
is in [`security-baseline.md`](./security-baseline.md).

| Area | Current state |
| --- | --- |
| CORS | `app.use(cors())` — `Access-Control-Allow-Origin: *`. A preflight from `https://evil.example` is approved. |
| Security headers | None set deliberately. `X-Powered-By: Express` is advertised. No `helmet`. |
| JSON body limit | Express default 100 KB (enforced — `413` measured). |
| Upload size limit | **None.** `multer.memoryStorage()` with no `limits`; an 8 MB upload succeeded. Whole file is held in RAM. |
| Upload type restriction | **None.** Only the *frontend* restricts types via `accept=`. `.exe` accepted server-side. |
| Extension spoofing | Not checked — dispatch is on the filename extension; content is never sniffed. |
| Rate limiting | **None.** `/api/ask` is an unauthenticated, unmetered path to a paid AI API. |
| Error leakage | Stack traces returned to clients (see §9). Upstream AI errors echoed verbatim. |
| API key exposure | Key is server-side only and never returned to a client. Not logged. `.env`/`.env.local` are correctly git-ignored. |
| SQL injection | **Not vulnerable.** All six queries use bound parameters. |
| Path traversal | **Not applicable.** No filesystem path is ever built from user input; uploads stay in memory. `filename` is stored but never used as a path. |
| Authentication | None. Username is a self-asserted identifier (see A18). |
| Dependencies | `npm audit`: 1 critical, 3 high, 2 moderate, 1 low. Includes a **HIGH DoS in the direct `multer` dependency**. |

---

## 11. Existing technical debt

Ordered by how much it blocks V2.

1. **Monolith blocks all four V2 features.** Study plans, exam simulation, RAG
   and analytics each need to reuse question/AI/persistence logic that currently
   exists only inline inside HTTP handlers. — *addressed by SP-V2-001.*
2. **No test suite.** `"test": "npm run dev"`. Nothing verifies behaviour, so no
   refactor is safe. — *addressed by SP-V2-001.*
3. **`answer` as a JSON blob + no indexes.** Weak-area detection and analytics
   need to query practice-question outcomes and topics relationally.
   — *deferred to SP-V2-002.*
4. **No migration mechanism.** Any schema change is currently a manual
   `ALTER TABLE` against a live file. — *partially addressed (a `migrations/`
   home is created); real tooling deferred to SP-V2-002.*
5. **No auth / user model.** Analytics per student and any notion of ownership
   require real identity. — *explicitly out of scope for SP-V2-001.*
6. **SQLite single-file, in-process.** No concurrent writers, no vector support.
   — *SP-V2-002 (PostgreSQL/pgvector).*
7. **Uploads are transient.** Files are discarded after one request, so RAG over
   study material is impossible without a document store. — *deferred to the RAG
   phase.*
8. **Frontend is one 1271-line client component** with inline styles. Not in
   scope for this iteration, but it will not absorb four new features as-is.
9. **No observability.** No request logs, no AI latency/token metrics, no error
   aggregation.
10. **Dependency vulnerabilities**, including a direct `multer` HIGH.
    — *partially addressed in SP-V2-001.*

---

## 12. Data flow (current, end to end)

```
① Login
   page.jsx handleLogin()
     POST /api/session  {username}
       server.js:40  trim → INSERT OR IGNORE sessions → SELECT sessions
     ← {username, created_at}
   then, in parallel:
     GET /api/history/:username   → [] (new user)
     GET /api/progress/:username  → {total_questions: 0, topics: []}

② Ask
   page.jsx handleAsk()
     optimistic: push {type:"user"} + {type:"typing"} into messages
     POST /api/ask  multipart(username, question, file?)
       server.js:55
         validate username + question           → 400 on failure
         build systemPrompt + "\n\nStudent question: " + question
         if req.file:
            image → base64 inlineData part
            pdf   → pdf-parse → 4000-char text part
            other → utf-8 → 4000-char text part
         ai.models.generateContent(gemini-3-flash-preview, JSON mode)
         JSON.parse → de-fence → placeholder fallback
         INSERT INTO questions (…, answer = JSON.stringify(answerData), …)
     ← <answer object>
     page.jsx replaces the typing bubble with {type:"ai", data}
     then re-fetches history and progress (full reload, not incremental)

③ Replay from history
   clicking a history card appends {type:"user"} + {type:"ai", data: item.answer}
   to the transcript. No network call — the stored answer is replayed.
```

---

## 13. Environment variables (current)

| Variable | Read at | Default | Notes |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | `server.js:13` | none | No validation. Not actually loaded from `.env.local` (A12). |
| `PORT` | `server.js:196` | `4000` | |
| `NEXT_PUBLIC_API_URL` | `page.jsx:5` | `http://localhost:4000` | Frontend only. Undocumented in any example file. |

There is **no** environment variable for the database path, the allowed CORS
origins, the Gemini model, the upload limit or the log level.

---

## 14. Deployment / build configuration

- **No deployment configuration of any kind exists**: no `vercel.json`,
  `vercel.ts`, `Dockerfile`, `Procfile`, CI workflow or `.github/` directory.
- **Backend has no build step.** `npm start` → `node server.js`.
- **Frontend build** is stock `next build`.
- `better-sqlite3` is a **native module**, and the SQLite file is local state —
  the backend as written cannot run on a stateless/serverless platform without
  changing the storage layer. This is a constraint on SP-V2-002, not a defect
  today.
- Local database artefacts (`studypal.db`, `-shm`, `-wal`) are git-ignored. The
  working tree currently contains orphaned `studypal.db-shm` / `studypal.db-wal`
  files, which is harmless local cruft.

---

## 15. Existing tests

**None.** There is no test directory, no test framework in `devDependencies`,
and `package.json` defines `"test": "npm run dev"` — which starts a watching dev
server and never terminates.

The baseline suite added by SP-V2-001 is described in
[`api-contract.md`](./api-contract.md) and lives in `tests/`.

---

# 16. Architecture after SP-V2-001

Everything above this line describes the pre-refactor system. Everything below
describes the system as it stands now.

**Nothing about the product changed.** No feature was added, removed or
redesigned; the frontend was not touched apart from a lockfile security update;
the database file, schema and contents are unchanged. What changed is where the
code lives and what each part is allowed to know.

## 16.1 What the refactor actually changed

| | Before | After |
| --- | --- | --- |
| Backend source files | 1 (`server.js`, 199 lines) | 22 under `src/` + a 45-line `server.js` |
| Layers | none — routing, validation, SQL, prompt assembly, HTTP calls and error handling all interleaved in each route handler | routes → controllers → services → repositories, with AI isolated behind its own client |
| Testability | none possible: `app.listen()` and `new GoogleGenAI()` ran as import side effects, and `app` was never exported | `createApp()` returns an unstarted app; the Gemini client is built lazily |
| Modules reading `process.env` | 4 places, scattered | 1 (`src/config/env.js`) |
| Modules importing `@google/genai` | 1 (the whole server) | 1 (`src/ai/gemini.client.js`) — and nothing above the service layer can reach it |
| SQL statement sites | 6, inline in route handlers | 6, all in `src/repositories/` |
| Error handling | per-route `try/catch` on one route, nothing anywhere else | one central handler; layers throw, the boundary formats |
| Tests | 0 | 59 (35 contract + 24 hardening) |

## 16.2 Directory layout

```
studypal-backend/
├── server.js                  process entrypoint: warn, open DB, listen, shut down
├── src/
│   ├── app.js                 Express assembly + middleware order
│   ├── config/
│   │   ├── env.js             the only reader of process.env; frozen config object
│   │   └── database.js        SQLite connection, schema bootstrap, health probe
│   ├── routes/
│   │   ├── index.js           the route table — which prefixes exist
│   │   ├── health.routes.js
│   │   ├── session.routes.js
│   │   └── questions.routes.js
│   ├── controllers/           HTTP in, HTTP out — no SQL, no Gemini, no try/catch
│   │   ├── health.controller.js
│   │   ├── session.controller.js
│   │   └── questions.controller.js
│   ├── services/              use cases; the only layer that orchestrates
│   │   ├── session.service.js
│   │   ├── question.service.js     ask / history / progress
│   │   ├── ai.service.js           prompt → provider → parse
│   │   └── upload.service.js       file → model parts
│   ├── repositories/          the only modules that know SQL exists
│   │   ├── session.repository.js
│   │   └── question.repository.js
│   ├── ai/
│   │   ├── gemini.client.js   the ONLY importer of @google/genai
│   │   └── prompts/
│   │       └── study-question.prompt.js   the prompt, verbatim
│   ├── middleware/
│   │   ├── cors.js            environment-driven origin policy
│   │   ├── error-handler.js   central handler + JSON 404 + asyncHandler
│   │   ├── request-logger.js
│   │   ├── security-headers.js
│   │   ├── upload.js          multer config, limits, extension allowlist
│   │   └── validation.js      per-endpoint input checks
│   └── utils/
│       ├── app-error.js       AppError + status helpers
│       ├── logger.js          level-aware console wrapper
│       └── version.js         package.json version, read once
├── migrations/
│   └── 001_initial_schema.sql the current schema, recorded (no runner yet)
├── tests/
│   ├── baseline/contract.test.js   35 tests — must pass before AND after
│   ├── hardening.test.js           24 tests — the intended changes
│   ├── characterize.mjs            behaviour probe
│   └── helpers/
│       ├── fake-gemini.mjs         global-fetch stub, no API key needed
│       └── server-harness.mjs      spawns the server on an ephemeral port
└── docs/
    ├── current-architecture.md     this file
    ├── api-contract.md             every endpoint + §7 deliberate deviations
    └── security-baseline.md        protections, findings, fixes, deferrals
```

## 16.3 Layer rules

Four rules, each mechanically checkable:

1. **Controllers do not contain SQL, prompts, or provider calls.** They read
   `req.validated`, call one service, and send the result.
2. **Services do not touch `req` or `res`.** They take and return plain data, so
   they are callable from a test, a script or a future job queue.
3. **Only `src/repositories/` knows SQL.** Only `src/ai/gemini.client.js` imports
   `@google/genai`. Only `src/config/env.js` reads `process.env`.
4. **Layers throw; only the boundary formats.** No layer below `src/middleware/`
   sets a status code or writes a response body.

Verified with:

```bash
grep -rn "GoogleGenAI\|generateContent" src/controllers src/routes   # empty
grep -rln "@google/genai" src/            # gemini.client.js only (as an import)
grep -rln "process\.env" src/             # config/env.js only
grep -rnE "\breq\.|\bres\.[a-z]" src/services src/repositories        # empty
```

## 16.4 Request path

`POST /api/ask` — the most involved route — now reads end to end as:

```
app.js
  requestLogger → securityHeaders → cors → express.json
routes/index.js            /api → questions.routes.js
questions.routes.js        acceptOptionalFile → validateAskRequest → asyncHandler(ask)
  middleware/upload.js       multer: size + count limits, extension allowlist
  middleware/validation.js   username + question present; trimmed value attached
controllers/questions.controller.js   ask(): three lines
services/question.service.js          askQuestion(): orchestration
  services/upload.service.js            file → inlineData or extracted text
  services/ai.service.js                prompt assembly, then parse (3 tiers)
    ai/prompts/study-question.prompt.js   the prompt text
    ai/gemini.client.js                   the only generateContent() call
  repositories/question.repository.js   INSERT — only after the model answered
→ res.json(answer)                      returned verbatim, no envelope
```

On any throw, control skips to `middleware/error-handler.js`, which logs the
full error and responds with JSON carrying a client-safe message.

## 16.5 Status of the pre-refactor problems (A1–A18)

| | Status |
| --- | --- |
| A1 no separation of concerns | **Fixed** — §16.2 |
| A2 untestable (side effects at import) | **Fixed** — `createApp()`; 59 tests |
| A3 no error handling strategy | **Fixed** — central handler |
| A4 stack traces leaked | **Fixed** — S2 in security-baseline |
| A5 no input validation | **Fixed** — `middleware/validation.js` |
| A6 no upload limits or type checks | **Fixed** — S4, S5 |
| A7 CORS wide open | **Fixed** (configurable; permissive default retained deliberately) — S6 |
| A8 no health endpoint | **Fixed** — `GET /health` |
| A9 no index on `questions.username` | **Deferred to SP-V2-002** — schema preservation was required; recorded in `migrations/001_initial_schema.sql` |
| A10 no migrations | **Partially** — `migrations/` exists with the schema recorded; a runner is SP-V2-002 |
| A11 prompt embedded in a route handler | **Fixed** — `src/ai/prompts/` |
| A12 `.env` vs `.env.local` mismatch | **Fixed** — S11 |
| A13 `PORT=your_port` in `.env.example` | **Fixed** — S11; numeric env vars now validated |
| A14 README documents directories that do not exist | **Fixed** — READMEs rewritten |
| A15 `main: "index.js"`, `"test": "npm run dev"` | **Fixed** — `main: "server.js"`, real test scripts |
| A16 no logging | **Fixed** — S13 |
| A17 frontend ignores HTTP status on `/api/ask` | **Not fixed — backend accommodates it.** The frontend was out of scope, so `/api/ask` error bodies are guaranteed to stay JSON objects with an `error` key. Worth fixing in the frontend later. |
| A18 username is identity, no auth | **Deferred by instruction** — S1; the largest remaining gap |

## 16.6 What is deliberately still simple

Called out so nobody mistakes these for oversights:

- **SQLite, no ORM, no query builder.** Required by SP-V2-001 and still the right
  call at this size. Repositories keep the swap contained if it ever happens.
- **No dependency injection container.** Modules import their collaborators
  directly. At 22 files with one implementation each, a container would add
  indirection and remove nothing.
- **No DTO/mapper layer.** Repositories return rows; services shape them once.
  A mapping layer would be two more files restating the same field names.
- **Schema DDL still applied on boot** rather than by a migration runner. Same
  idempotent `CREATE TABLE IF NOT EXISTS` as before; a runner arrives with the
  data-layer work.
- **Zero new runtime dependencies.** `package.json` dependencies are byte-identical
  to the pre-refactor list.

## 16.7 Readiness for V2 features

| V2 feature | What now exists for it | What it still needs |
| --- | --- | --- |
| Study Plan Generator | prompt directory, `ai.service` seam, repository pattern to copy | `plan.service`, `plan.repository`, a prompt, a migration |
| Exam Simulator | same, plus the three-tier JSON repair to reuse for structured output | `exam.*` layers, timing/scoring rules |
| RAG study-material chat | upload handling already isolated in `upload.service`, so extraction is one module to extend | a vector store — needs the PostgreSQL/pgvector decision explicitly deferred by SP-V2-001 |
| Learning analytics / weak-area detection | `question.repository` already aggregates topics for `/api/progress` | richer schema (per-question correctness), which needs the migration runner |
| Any per-student feature | — | **authentication (S1)** — currently a username is an unverified claim, so nothing private can be built on it |
