# StudyPal Backend

Express API for StudyPal. Answers a student's study question with Gemini,
stores the exchange in SQLite, and serves that student's history and topic
counts back.

- Node.js 22+ (uses the built-in `node:test` runner and global `fetch`)
- Express 5, `better-sqlite3`, `@google/genai`
- No build step; no ORM; no external services besides the Gemini API

## Setup

```bash
cd studypal-backend
npm install
cp .env.example .env
```

Then put a Gemini API key in `.env`:

```
GEMINI_API_KEY=...
```

Get one free at <https://aistudio.google.com/apikey>.

`npm install` compiles `better-sqlite3`, a native module. If that fails, install
a C++ toolchain (`build-essential` and `python3` on Debian/Ubuntu, Xcode command
line tools on macOS).

## Running

```bash
npm run dev     # node --watch, restarts on change
npm start       # plain node
```

Listens on <http://localhost:4000> by default. `GET /health` confirms it is up.

## Environment variables

`GEMINI_API_KEY` is the only one you need. Everything else has a working
default — `.env.example` documents each with its default value.

Both `.env` and `.env.local` are read, with `.env.local` taking precedence, and a
real environment variable beating both. Neither file is committed.

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required for `POST /api/ask`. Every other endpoint works without it. |
| `PORT` | `4000` | Must be numeric; a non-numeric value fails at startup. |
| `NODE_ENV` | `development` | `production` enables HSTS and drops the automatic localhost CORS allowance. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` \| `silent`. |
| `DATABASE_PATH` | `studypal.db` | Relative paths resolve against this directory. |
| `FRONTEND_URL`, `CORS_ORIGINS` | unset | See below. |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | |
| `AI_TIMEOUT_MS` | `0` (off) | Abort a generation after this long. |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MB) | |
| `JSON_BODY_LIMIT` | `100kb` | |
| `MAX_USERNAME_LENGTH` | `200` | |
| `HISTORY_LIMIT` | `30` | Items from `/api/history`. |
| `PROGRESS_TOPICS_LIMIT` | `6` | Topics from `/api/progress`. |
| `DOCUMENT_TEXT_CHARS` | `4000` | Characters of an uploaded document sent to the model. |

### CORS

With neither `FRONTEND_URL` nor `CORS_ORIGINS` set, the API accepts requests
from **any** origin and logs a warning at startup. That is convenient locally and
too permissive in production — set one of them to an allowlist before deploying:

```
FRONTEND_URL=https://your-frontend.example
CORS_ORIGINS=https://staging.example,https://preview.example
```

Outside `NODE_ENV=production`, `localhost` and `127.0.0.1` on any port stay
allowed regardless, so configuring a deployment does not break local work.

## Endpoints

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `200 {status, uptime_seconds, version, database}` |
| `POST` | `/api/session` | JSON `{username}` | `200 {username, created_at}` |
| `POST` | `/api/ask` | multipart `username`, `question`, optional `file` | `200` — the answer object |
| `GET` | `/api/history/:username` | — | `200` — array, newest first, ≤ `HISTORY_LIMIT` |
| `GET` | `/api/progress/:username` | — | `200 {total_questions, topics[]}` |

Errors are always JSON: `{"error": "<message>"}`.

`GET /health` checks only the local database. It never contacts Gemini, so a
provider outage will not take the service out of rotation and probes cost no
quota.

`POST /api/ask` also accepts a plain JSON body (`{username, question}`) when
there is no file. Uploads are accepted for `.pdf`, `.png`, `.jpg`, `.jpeg`,
`.gif`, `.webp`, `.txt`, `.md`, `.csv`, `.json` and `.log`; anything else is
`415`, and anything over the size limit is `413`.

Full request/response detail for every endpoint, including each error case, is in
[`docs/api-contract.md`](./docs/api-contract.md).

### Note on identity

A "username" is an unverified string. There is no password, no token and no
authorization check: anyone who knows or guesses a username can read that
student's history. This is the pre-existing behaviour, kept deliberately for
now — see [`docs/security-baseline.md`](./docs/security-baseline.md) (S1).

## Tests

```bash
npm test              # 59 tests
npm run test:baseline # 35 — the API-contract subset
npm run characterize  # print observed behaviour across ~30 request variants
```

No Gemini API key is needed. The suite spawns the real server on an ephemeral
port and replaces the global `fetch` for Gemini requests only, via a
`node --import` preload ([`tests/helpers/fake-gemini.mjs`](./tests/helpers/fake-gemini.mjs)),
so nothing in `src/` is modified or mocked for testing. Each run uses a
temporary database.

Two suites, with different jobs:

- **`tests/baseline/contract.test.js`** (35) — behaviour that must not change.
  It passes against the pre-refactor `server.js` too, which is what makes it
  evidence rather than assertion. To replay it:

  ```bash
  git show 634c9d8:studypal-backend/server.js > .baseline-server.mjs
  STUDYPAL_ENTRY=.baseline-server.mjs npm run test:baseline   # 35 pass
  rm .baseline-server.mjs
  ```

  The extracted file has to sit inside this directory — Node resolves a module's
  imports from its own location, so a copy in `/tmp` cannot find `express`.

- **`tests/hardening.test.js`** (24) — the changes SP-V2-001 introduced
  deliberately. Each test maps to a numbered row in `docs/api-contract.md` §7.

## Architecture

```
server.js          bootstrap: open the database, listen, shut down cleanly
src/
  app.js           Express assembly and middleware order
  config/          env.js (the only reader of process.env), database.js
  routes/          URL → controller
  controllers/     HTTP in, HTTP out
  services/        use cases: session, question, ai, upload
  repositories/    the only modules containing SQL
  ai/              gemini.client.js (the only @google/genai importer) + prompts/
  middleware/      cors, validation, upload, security headers, error handler
  utils/           logger, AppError, version
migrations/        the current schema, recorded — no runner yet
```

Controllers contain no SQL and no provider calls; services never touch `req` or
`res`; layers throw and only the HTTP boundary formats a response.

[`docs/current-architecture.md`](./docs/current-architecture.md) describes both
the pre-refactor system and the current one, and
[`docs/security-baseline.md`](./docs/security-baseline.md) records what is fixed
and what is knowingly deferred.

## Deployment notes

- **Set `DATABASE_PATH` to a mounted volume.** SQLite is a file; on an ephemeral
  container filesystem every restart loses all student data.
- **Run one instance.** `better-sqlite3` is in-process, so multiple instances
  would each hold their own connection to the same file. Horizontal scaling needs
  the database migration deferred to SP-V2-002.
- **Set `FRONTEND_URL`** so CORS is not wide open.
- **Rate limiting is not implemented.** `POST /api/ask` bills a Gemini call per
  request with no ceiling and no authentication. Put a limit in front of it
  before exposing it publicly — see `docs/security-baseline.md` (S7).
- `SIGTERM` is handled: the listener stops, in-flight requests drain, the
  database closes.
