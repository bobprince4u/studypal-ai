# StudyPal Backend

Express API for StudyPal. Answers a student's study question with Gemini,
stores the exchange in PostgreSQL, and serves that student's history and topic
counts back.

- Node.js 22+ (uses the built-in `node:test` runner and global `fetch`)
- Express 5, `pg`, `@google/genai`
- PostgreSQL 16
- No build step; no ORM; no query builder; no migration framework

## Setup

```bash
cd studypal-backend
npm install
cp .env.example .env
```

Then edit `.env`:

```
GEMINI_API_KEY=...                    # https://aistudio.google.com/apikey
POSTGRES_PASSWORD=...                 # any value; used by the local container
DATABASE_URL=postgresql://studypal:<that password>@127.0.0.1:5434/studypal
STUDYPAL_TEST_DATABASE_URL=postgresql://studypal:<that password>@127.0.0.1:5434/studypal_test
```

`docker compose` reads the same `.env`, so one file configures the app and the
database. To generate a password:

```bash
printf 'POSTGRES_PASSWORD=dev_%s\n' "$(openssl rand -hex 12)" >> .env
```

### Database

```bash
npm run db:up        # postgres:16-alpine on 127.0.0.1:5434, waits for healthy
npm run migrate      # create the schema
npm run db:down      # stop it; the volume and data survive
```

Port **5434**, not 5432, so the container cannot collide with a PostgreSQL
already installed on the host. `compose.yaml` binds to `127.0.0.1` only and has
no default password — `docker compose up` fails rather than starting a cluster
with a password guessable from this repository.

An existing PostgreSQL works just as well; point `DATABASE_URL` at it and skip
`db:up`. Either way the test database has to exist before `npm test`:

```bash
createdb studypal_test
# or, against the container:
docker exec studypal-postgres createdb -U studypal studypal_test
```

There is **no SQLite fallback**. If `DATABASE_URL` is unset the server refuses to
start; if PostgreSQL is unreachable it starts and reports `degraded` on
`GET /health` rather than crash-looping. Both behaviours are deliberate and
explained in [`docs/database-architecture.md`](./docs/database-architecture.md).

## Running

```bash
npm run dev     # node --watch, restarts on change
npm start       # plain node
```

Listens on <http://localhost:4000> by default. `GET /health` confirms it is up.

## Environment variables

`DATABASE_URL` and `GEMINI_API_KEY` are the two you need. Everything else has a
working default — `.env.example` documents each with its default value.

Both `.env` and `.env.local` are read, with `.env.local` taking precedence, and a
real environment variable beating both. Neither file is committed.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** `postgresql://user:pass@host:port/db`. No fallback: the server will not start without it. |
| `STUDYPAL_TEST_DATABASE_URL` | — | **Required for `npm test`**, ignored otherwise. Must have `test` in its name. `DATABASE_URL` is never used as a fallback here — see [Tests](#tests). |
| `GEMINI_API_KEY` | — | Required for `POST /api/ask`. Every other endpoint works without it. |
| `PORT` | `4000` | Must be numeric; a non-numeric value fails at startup. |
| `NODE_ENV` | `development` | `production` enables HSTS and drops the automatic localhost CORS allowance. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` \| `silent`. |
| `DB_POOL_MAX` | `10` | Connections in the pool. One pool per process. |
| `DB_IDLE_TIMEOUT_MS` | `30000` | How long an unused connection is kept. |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Fail a request rather than queue behind an unreachable host. |
| `DB_SSL` | `false` | Set `true` for a managed provider (Neon, Supabase, RDS). |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Only `false` for a self-signed certificate; logs a warning. |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | — | Read by `compose.yaml` for the local container, not by the server. |
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

`GET /health` runs `SELECT 1` against PostgreSQL and nothing else. It never
contacts Gemini, so a provider outage will not take the service out of rotation
and probes cost no quota. With the database unreachable it returns
`503 {status: "degraded", database: "unavailable"}` — never the host, user or
driver error, which would leak connection details to an unauthenticated caller.

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
npm test              # 99 tests
npm run test:baseline # 35 — the API-contract subset
npm run characterize  # print observed behaviour across ~30 request variants
```

Requires a running PostgreSQL and `STUDYPAL_TEST_DATABASE_URL`. No Gemini API key
is needed: the suite spawns the real server on an ephemeral port and replaces the
global `fetch` for Gemini requests only, via a `node --import` preload
([`tests/helpers/fake-gemini.mjs`](./tests/helpers/fake-gemini.mjs)), so nothing
in `src/` is modified or mocked for testing.

**PostgreSQL, by contrast, is real in every test.** A mocked database cannot tell
you that a CHECK constraint rejects a row, that a migration applies cleanly, or
that the planner uses an index, which is most of what these tests are for.

### Test database isolation

Two barriers stand between `npm test` and your development data, and both have to
be defeated deliberately to lose anything:

1. Under `NODE_ENV=test` the connection string comes **only** from
   `STUDYPAL_TEST_DATABASE_URL`. `src/config/env.js` throws if it is missing and
   never falls back to `DATABASE_URL`, which is set on every developer machine
   and would therefore make a fallback actively dangerous.
2. `assertTestDatabase()` in
   [`tests/helpers/test-database.mjs`](./tests/helpers/test-database.mjs) refuses
   any database whose name does not contain `test`, before every destructive
   operation. `studypal_test` passes; `studypal` does not.

The named test database is migrated once per run and then used as a template.
Every spawned server and every SQL-level suite gets its own database created with
`CREATE DATABASE … TEMPLATE`, dropped when the suite ends. Because `node --test`
runs each test *file* in its own process, both the template reset and the clone
are taken under a PostgreSQL advisory lock — a per-process cache cannot serialise
work on a resource shared between processes. Leftovers from a crashed run are
named `studypal_test_run_%` and cleared by `dropStaleTestDatabases()`.

### The suites

- **`tests/baseline/contract.test.js`** (35) — behaviour that must not change,
  including the AI-response repair path. It passes against the pre-refactor
  `server.js` too, which is what makes it evidence rather than assertion. To
  replay it:

  ```bash
  mkdir -p .baseline
  git show 634c9d8:studypal-backend/server.js > .baseline/server.mjs
  STUDYPAL_ENTRY=.baseline/server.mjs npm run test:baseline   # 35 pass
  rm -rf .baseline
  ```

  The old server is SQLite-based, so this replay ignores the PostgreSQL wiring
  entirely and writes its own `studypal.db`. The subdirectory is what keeps that
  file out of the way: the extracted module has to live under this directory
  because Node resolves imports from a module's own location and a copy in `/tmp`
  cannot find `express`, but one level down `__dirname` is `.baseline/`, so the
  throwaway database is created there and disappears with `rm -rf`.

- **`tests/hardening.test.js`** (26) — the changes SP-V2-001 and SP-V2-002
  introduced deliberately, including the degraded-health behaviour when the
  database is unreachable. Each test maps to a numbered row in
  `docs/api-contract.md` §7.

- **`tests/migrations.test.js`** (12) — the runner against real PostgreSQL: a
  fresh database gets the schema, a second run applies nothing, a failing
  migration rolls back and records nothing, an edited migration is refused.

- **`tests/schema.test.js`** (26) — the constraints, through SQL rather than
  HTTP, so what is asserted is that the *database* refuses a bad row. Also
  asserts both query plans use the documented indexes, and that no table
  reserved for a later V2 ticket has been created early.

## Architecture

```
server.js          bootstrap: probe the database, check migrations, listen, drain
src/
  app.js           Express assembly and middleware order
  config/          env.js (the only reader of process.env), database.js (the pool),
                   pg-types.js (BIGINT → number, TIMESTAMPTZ → ISO string)
  db/              migrator.js — the migration runner
  routes/          URL → controller
  controllers/     HTTP in, HTTP out
  services/        use cases: session, question, ai, upload
  repositories/    the only modules containing SQL
  ai/              gemini.client.js (the only @google/genai importer) + prompts/
  middleware/      cors, validation, upload, security headers, error handler
  utils/           logger, AppError, version
scripts/migrate.mjs        CLI for the runner: `up` and `status`
migrations/postgres/       the applied schema, forward-only
migrations/legacy-sqlite/  the pre-PostgreSQL schema, never executed
compose.yaml               local PostgreSQL 16 on 127.0.0.1:5434
```

Controllers contain no SQL and no provider calls; services never touch `req` or
`res`; layers throw and only the HTTP boundary formats a response. `pg` is
imported by `src/config/database.js`, `src/config/pg-types.js` and the test
helpers, and by nothing else.

[`docs/database-architecture.md`](./docs/database-architecture.md) covers the
schema, the indexes and why each exists, the migration strategy, and connection
management. [`docs/current-architecture.md`](./docs/current-architecture.md)
describes both the pre-refactor system and the current one, and
[`docs/security-baseline.md`](./docs/security-baseline.md) records what is fixed
and what is knowingly deferred.

## Deployment notes

- **Run the migrations as a deploy step**, before the new version serves traffic:
  `npm run migrate`. The server does not migrate on startup — a running instance
  must never mutate DDL — but it does log a warning if anything is pending.
- **Migrations are forward-only.** There is no `down`, and no rollback command.
  A wrong migration is corrected by writing the next one; see
  `docs/database-architecture.md` §5.
- **Set `DB_SSL=true`** for any managed provider. Without it, credentials and
  student data cross the network in the clear, and the server warns at startup
  when `NODE_ENV=production`.
- **Multiple instances are fine now.** PostgreSQL is a server, not a file, so the
  single-instance restriction SQLite imposed is gone. Size `DB_POOL_MAX` against
  the server's `max_connections` divided by the number of instances.
- **Back up the database.** Data now lives in PostgreSQL, so a mounted volume is
  the database server's concern; `pg_dump` on a schedule is yours.
- **Set `FRONTEND_URL`** so CORS is not wide open.
- **Rate limiting is not implemented.** `POST /api/ask` bills a Gemini call per
  request with no ceiling and no authentication. Put a limit in front of it
  before exposing it publicly — see `docs/security-baseline.md` (S7).
- `SIGTERM` is handled: the listener stops, in-flight requests drain, the
  connection pool closes.
