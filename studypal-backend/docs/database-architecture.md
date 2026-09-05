# Database Architecture

How StudyPal stores data, and why it stores it that way. Written for SP-V2-002,
which replaced SQLite with PostgreSQL.

Companion documents: [`current-architecture.md`](./current-architecture.md) for
the application layers, [`api-contract.md`](./api-contract.md) for the
request/response contract these tables serve, and
[`security-baseline.md`](./security-baseline.md) for what is and is not
protected.

---

## 1. Why PostgreSQL

SQLite was the right choice for SP-V2-001, which was a refactor with no
infrastructure budget. It stops being the right choice the moment the V2 features
are real, for four reasons that are properties of the engine rather than
preferences:

| Requirement | SQLite | PostgreSQL |
| --- | --- | --- |
| More than one API instance | One process owns the file. Two instances means two writers on one file over a filesystem that may not lock correctly. | A server. Instances are clients. |
| Uploaded-material search (SP-V2-00x) | No vector type, no trigram index, `LIKE '%x%'` only. | `pgvector` and `pg_trgm` are extensions away — deliberately *not* installed yet. |
| Concurrent writes during a study session | One writer at a time; a long write blocks readers unless WAL is tuned. | MVCC. Readers never block writers. |
| Structured AI output | JSON as `TEXT`, parsed in application code on every read. | `JSONB` — validated on write, queryable, indexable. |
| Survives a container restart | Only if the file sits on a mounted volume. | Storage is the database server's problem, not the app's. |

There is a fifth, less glamorous reason: constraints. The SQLite schema accepted
a blank username, a question belonging to a user that did not exist, and
`has_file = 1` with `filename = NULL`. All three are now rejected by the
database, which means a future code path that skips the request validator still
cannot write an unusable row. `tests/schema.test.js` asserts each one.

**PostgreSQL is now the authoritative store. There is no SQLite fallback of any
kind** — not a hidden one, not a development-only one. `better-sqlite3` has been
removed from `package.json`, and the old schema is kept unexecuted at
`migrations/legacy-sqlite/001_initial_schema.sql` purely as history.

### What was NOT adopted

- **No ORM, no query builder.** Every statement is SQL in a repository module.
  The queries here are five SELECTs and two INSERTs; an ORM would add a
  dependency, a mapping layer and a second thing to learn in exchange for
  nothing.
- **No migration framework.** See §5.
- **No Redis, no pgvector, no extensions beyond the default `plpgsql`.** Asserted
  by a test, so adding one is a deliberate act.

---

## 2. Schema overview

Two application tables plus the migration runner's bookkeeping.

```
┌─────────────────────────────────────┐
│ users                               │
├─────────────────────────────────────┤
│ id              BIGINT   PK identity│◄────────┐
│ username        TEXT     NOT NULL ∪ │         │
│ email           TEXT     NULL     ∪ │         │
│ display_name    TEXT     NULL       │         │
│ education_level TEXT     NULL       │         │
│ created_at      TIMESTAMPTZ NOT NULL│         │
│ updated_at      TIMESTAMPTZ NOT NULL│         │ user_id
└─────────────────────────────────────┘         │ FK, ON DELETE CASCADE
                                                │
┌─────────────────────────────────────┐         │
│ questions                           │         │
├─────────────────────────────────────┤         │
│ id         BIGINT   PK identity     │         │
│ user_id    BIGINT   NOT NULL  ───────────────┘
│ question   TEXT     NOT NULL        │
│ answer     JSONB    NOT NULL        │
│ topic      TEXT     NOT NULL  = 'Study Topic'
│ has_file   BOOLEAN  NOT NULL  = false
│ filename   TEXT     NULL            │
│ created_at TIMESTAMPTZ NOT NULL     │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ schema_migrations   (bookkeeping)   │
├─────────────────────────────────────┤
│ filename    TEXT PK                 │
│ checksum    TEXT NOT NULL           │
│ applied_at  TIMESTAMPTZ NOT NULL    │
│ duration_ms INTEGER NOT NULL        │
└─────────────────────────────────────┘

∪ = UNIQUE
```

**Relationship:** one user has many questions. That is the only relationship in
the schema. `ON DELETE CASCADE` means deleting a user deletes their questions —
chosen so the first data-deletion request is a `DELETE` rather than a migration.

The full DDL, with a comment on every non-obvious decision, is
[`migrations/postgres/001_core_schema.sql`](../migrations/postgres/001_core_schema.sql).
That file is the source of truth; this section describes it.

### `users` replaces `sessions`

The SQLite schema had a `sessions` table that held no session state: one row per
username, written on first login, never updated, never expired. It was a user
registry with a misleading name. It is now called `users`, and it gained the
identity column that lets `questions` reference it.

Three columns (`email`, `display_name`, `education_level`) are nullable and
nothing writes them yet. They are here because adding a nullable column to a
table with rows is free while backfilling a `NOT NULL` one is not, and because a
real account needs somewhere to put an email before authentication can exist.

`username` is an **unauthenticated identity claim**, not a verified identity.
Anyone may `POST /api/session` with any name and read that name's history. This
table is where authentication will attach; until then every row in it is public
data. See `security-baseline.md` S1.

### `questions.answer` is JSONB

The model returns an object — `{explanation, topic, practice_questions[],
encouragement}` — whose shape varies with the prompt. Under SQLite it was stored
as a JSON string that `question.service.js` had to `JSON.parse` on every read, a
parse that could throw on a single poisoned row and take down the history
endpoint.

`JSONB` validates on write, comes back as an object, and can be indexed and
queried if a later feature needs to reach inside it. No `JSON.parse` remains
anywhere above the driver.

**It holds a JSON object, never a JSON string containing JSON.** Passing
`JSON.stringify(answer)` as a `jsonb` parameter stores the object itself; passing
an already-stringified string stores a JSON *string*, and every reader then gets
text where it expected an object. The `questions_answer_is_object` CHECK makes
that mistake a write error instead of a subtly wrong response weeks later, and
`tests/schema.test.js` asserts all five wrong shapes are rejected.

`topic` is denormalised out of `answer` on purpose: `GET /api/progress` groups by
it, and a plain indexed column beats a JSONB expression for the one field that is
queried rather than merely displayed.

### Types, and why the API did not change

| Decision | Reason |
| --- | --- |
| `BIGINT GENERATED ALWAYS AS IDENTITY` | The SQL-standard spelling. `ALWAYS` stops an INSERT supplying its own id, which would leave the sequence behind the table. `BIGINT` because widening a PK later means rewriting every referencing row. |
| No UUIDs | Nothing here needs a client-generated or globally-unique id. A UUID PK would cost index size and locality for a property no requirement asks for. |
| `TIMESTAMPTZ`, not `TIMESTAMP` | An instant, not a wall-clock reading. The pool pins the session to UTC so the same row renders identically on every machine. |
| `BOOLEAN has_file` | Was `INTEGER` 0/1, which is why the old service wrapped every read in `Boolean()`. The column now has the right type and the conversion is gone. |
| `TEXT`, never `VARCHAR(n)` | Identical performance in PostgreSQL; a length limit belongs in validation, where the error message can be useful. `MAX_USERNAME_LENGTH` is enforced there. |

`COUNT(*)` returns `BIGINT`, which the driver renders as a **string** by default,
and `TIMESTAMPTZ` as a JS `Date`. Both would have been visible API changes —
`total_questions: "3"` instead of `3`, and a `created_at` that fails the
contract's `new Date(x).toISOString() === x`. `src/config/pg-types.js` registers
parsers that fix both. That module exists separately from the pool because pg's
type registry is **process-global**: anything that opens its own client (the test
helpers, tooling) must install the same parsers or silently read different
shapes.

---

## 3. Indexes

Three indexes exist beyond what the PK and UNIQUE constraints create, and each
one serves a query in the code today. No speculative indexes: every index costs
write throughput and disk, and an unused one is pure loss.

| Index | Serves | Why this shape |
| --- | --- | --- |
| `idx_questions_user_created (user_id, created_at DESC)` | `GET /api/history/:username` — `WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30` | Equality column first, then the sort column. PostgreSQL finds the user's rows and walks them already in order, so the `LIMIT` stops after 30 with no sort step. This is the index SP-V2-001 deferred (A9). |
| `idx_questions_user_topic (user_id, topic)` | `GET /api/progress/:username` — `WHERE user_id = $1 GROUP BY topic ORDER BY count DESC LIMIT 6` | Including `topic` lets the grouping read the index rather than fetching every matching row. A second index on the same leading column is only worth it because progress is called on every page load alongside history. |
| `users_username_key` (from the UNIQUE constraint) | Every endpoint — each resolves a username to a `user_id` first | Also the constraint `POST /api/session` relies on via `ON CONFLICT (username)`. |

`tests/schema.test.js` asserts the exact index list on `questions`, so adding one
fails a test and prompts a justification. It also runs `EXPLAIN` against both
queries at a few thousand rows and asserts the planner actually uses these
indexes — an index PostgreSQL declines to use is the same as no index, and at
fixture scale a sequential scan genuinely is cheaper, so the test builds enough
rows to reach the regime the index exists for.

---

## 4. Connection management

One `pg.Pool` per process, created lazily by `getPool()` in
`src/config/database.js`, and never one connection per request — a new TCP
connection and PostgreSQL backend per HTTP request would dominate the latency of
every endpoint and exhaust `max_connections` under trivial load.

| Setting | Default | Env var |
| --- | --- | --- |
| `max` | 10 | `DB_POOL_MAX` |
| `idleTimeoutMillis` | 30 000 | `DB_IDLE_TIMEOUT_MS` |
| `connectionTimeoutMillis` | 5 000 | `DB_CONNECT_TIMEOUT_MS` |
| `application_name` | `studypal-backend` | — |
| `options` | `-c timezone=UTC` | — |

Two details that are easy to get wrong:

- **`pool.on("error")` is registered.** An idle client erroring — a server
  restart, a network drop, an admin terminating the backend — emits `error` on
  the pool. Without a listener that is an unhandled `error` event, so a database
  restart would kill the API process. pg discards the broken client on its own;
  logging is all that is needed.
- **The session time zone is pinned.** Without it, `TIMESTAMPTZ` comes back with
  the server's local offset and the same row renders differently on two machines.

### Transactions

`withTransaction(fn)` runs a callback on one dedicated client inside
`BEGIN`/`COMMIT`, rolling back on any throw. It is used **deliberately, not
everywhere**: a lone INSERT or SELECT is already atomic and wrapping it adds two
round trips for nothing. Current callers:

1. **`POST /api/ask`** — upsert the user, then insert the question. Two
   statements that must not come apart, or a question is written against a user
   row that does not exist.
2. **The migration runner** — each migration file, so a failure half-way leaves
   no partial schema.

### Failure behaviour

The spec asked for a choice between failing at startup and reporting through
health. Both, at different layers:

| Failure | Behaviour |
| --- | --- |
| `DATABASE_URL` missing or blank | **Fatal at startup.** `src/config/env.js` throws before the server listens. A misconfigured deployment must not start and pretend to work. |
| `NODE_ENV=test` and `STUDYPAL_TEST_DATABASE_URL` missing | **Fatal at startup**, and deliberately *not* defaulted to `DATABASE_URL`. See §6. |
| PostgreSQL unreachable | **Server starts, `GET /health` returns `503 {status: "degraded", database: "unavailable"}`.** Data endpoints fail with a clean JSON 500. |
| Migrations pending at startup | Logged as a warning; the server starts. |
| A migration file changed after being applied | Logged as an error; the server starts. `npm run migrate` refuses. |

An unreachable database is a *transient* condition, and a process that exits on
it crash-loops under an orchestrator — which removes the instance from rotation,
produces no useful logs, and recovers no faster than a process that stays up and
reports its own state. A missing connection string is not transient: no amount of
waiting fixes it, so that one is fatal. `tests/hardening.test.js` covers both.

Connection errors name the host, port and user, so they are **logged, never
serialised into a response**. The health response says `"unavailable"` and
nothing more; a test asserts the response body contains no host, user, or
`ECONNREFUSED`.

---

## 5. Migration strategy

`src/db/migrator.js`, about 250 lines, no dependency.

**Why not a framework.** What node-pg-migrate, Umzug or Knex add beyond this file
is a rollback DSL, a JavaScript migration format and a CLI. This project wants
none of them. The whole mechanism is: read the `.sql` files, compare against a
tracking table, apply the missing ones in order, inside transactions. That is one
file, no new dependency, and nothing about how the schema is created hidden
behind someone else's abstraction.

```bash
npm run migrate         # apply everything pending
npm run migrate:status  # what has run, what has not, what changed
```

Guarantees, each with a test in `tests/migrations.test.js`:

- **Deterministic order.** Filenames sort by their numeric prefix compared *as a
  number*, so `010` follows `009` rather than sorting lexically.
- **Applied exactly once.** Recorded in `schema_migrations`, skipped thereafter.
  A second `npm run migrate` applies nothing.
- **All-or-nothing per file.** Each migration runs in its own transaction, and
  the tracking row is written in that same transaction — so "schema changed" and
  "migration recorded" cannot come apart. PostgreSQL has transactional DDL, so a
  syntax error on the last statement of a file rolls back the tables the earlier
  statements created.
- **Tamper-evident.** The checksum of each applied file is stored and rechecked.
  Editing a migration that has already run is a hard error, not a silent
  divergence between environments.
- **Loud failure.** The failing filename, the message and PostgreSQL's character
  position are reported, and the CLI exits non-zero.

### Forward-only

**There are no down migrations and no rollback command.** A wrong migration is
corrected by writing the next one.

This is a decision, not an omission. A down migration that has never been
executed is not a safety net — it is untested code that gets run for the first
time during an incident. And recovering from a genuinely destructive migration
(a dropped column, a lossy type change) is a restore-from-backup problem that a
rollback script does not solve, because the data is already gone.

### File numbering

`migrations/postgres/001_core_schema.sql` is the first migration of the
PostgreSQL era. The SQLite schema that used to be `migrations/001_initial_schema.sql`
was **moved**, not renumbered, to `migrations/legacy-sqlite/001_initial_schema.sql`
and is never read by anything. Two files therefore both begin `001`, in different
directories, and that is intentional: `001` means "the original SQLite tables"
under `legacy-sqlite/` and "the initial PostgreSQL schema" under `postgres/`.
Renumbering the historical file would have made git history harder to follow for
no gain.

---

## 6. Test database strategy

Two independent barriers stand between `npm test` and a developer's real data.
**Both must be defeated deliberately** for a test run to destroy anything.

1. **Under `NODE_ENV=test`, the connection string comes only from
   `STUDYPAL_TEST_DATABASE_URL`.** `src/config/env.js` throws if it is missing
   and never falls back to `DATABASE_URL`. A fallback would be actively
   dangerous: `DATABASE_URL` is set on every developer machine, so falling back
   would silently point a destructive suite at the working database.
2. **A name guard.** `assertTestDatabase()` in
   `tests/helpers/test-database.mjs` runs before every destructive operation and
   throws unless the database name looks like a test database. `studypal_test`
   passes; `studypal`, `postgres`, `production` and `studypal_prod` do not. Its
   error message redacts the password.

### Isolation

The base test database is migrated once per run and then acts as a **template**.
Each spawned server, and each suite that needs raw SQL, gets its own database
created with `CREATE DATABASE … TEMPLATE`, which is a file copy inside PostgreSQL
— far cheaper than re-running migrations, and a private schema with no cross-talk.

Databases are named `<base>_run_<pid>_<n>_<label>` so a leftover is traceable to
the suite that made it, and dropped in `stop()` with `WITH (FORCE)`.
`dropStaleTestDatabases()` clears anything a crashed run left behind, matching
only `<base>_run_%`.

`node --test` runs each test **file** in its own process, so the template is
shared between processes that know nothing about each other. Two collisions
follow: two processes resetting the template at once (PostgreSQL reports a
duplicate key on `pg_namespace`), and one process cloning the template while
another is connected to it (`CREATE DATABASE … TEMPLATE` requires the source to
have no other sessions). Both operations are taken under a **PostgreSQL advisory
lock** keyed on the base database name — cross-process by construction, and
released automatically if a test process dies.

### What is real and what is faked

**PostgreSQL is real in every test.** A mocked database cannot tell you that a
CHECK constraint rejects a row, that a migration applies cleanly, or that the
planner uses an index — which is most of what these tests are for.

**Gemini is faked**, by a `node --import` preload that replaces global `fetch`
for provider requests only (`tests/helpers/fake-gemini.mjs`). The provider is a
paid third party and its output is nondeterministic; the database is neither. No
API key is needed to run the suite.

### Local setup

```bash
cd studypal-backend
cp .env.example .env          # then set POSTGRES_PASSWORD
npm run db:up                 # postgres:16-alpine on 127.0.0.1:5434
npm run migrate
npm test
```

`compose.yaml` pins `postgres:16-alpine`, binds only to `127.0.0.1`, and takes
its password from the environment with no default — `POSTGRES_PASSWORD:?` fails
the command rather than starting a database with a known password. Port **5434**
rather than 5432, so it cannot collide with a PostgreSQL already installed on the
host. Nothing about it is committed except the compose file itself.

---

## 7. Migrating existing SQLite data

**Nothing was migrated, because there was nothing to migrate.**

The SQLite database in the working tree contained only characterization and test
data generated by `npm run characterize` and the baseline suite — no genuine user
data. Copying it into PostgreSQL would have polluted the new database with
fixtures.

Had it contained real data, the path would have been: export each table to CSV
from SQLite, load `users` first (a `sessions` row becomes a `users` row), then
`questions`, resolving `username` to `user_id` on the way and validating each
`answer` string parses to an object before inserting it as `JSONB`. The rows the
new CHECK constraints reject — blank usernames, `has_file` disagreeing with
`filename` — would need deciding on individually rather than being force-loaded,
which is exactly why the constraints exist.

No SQLite file is tracked by git, and none ever was.

---

## 8. Where V2 features attach

These tables are **not created yet**. A table with no code reading it is a guess
about a future requirement rather than a schema, and `tests/schema.test.js`
asserts by name that none of them exist, so creating one early fails a test.

| Feature | Expected shape | Attaches to |
| --- | --- | --- |
| Uploaded study materials | `materials` (one row per file), `material_chunks` (text + embedding) | `materials.user_id → users.id` |
| Semantic search over materials | `pgvector` extension, an HNSW index on `material_chunks.embedding` | Requires the extension; deliberately not installed |
| Study plans | `study_plans`, `study_plan_tasks` | `study_plans.user_id → users.id` |
| Exams and attempts | `exams`, `exam_questions`, `exam_attempts`, `attempt_answers` | `exams.user_id → users.id` |
| Learning analytics | `learning_events` | `learning_events.user_id → users.id` |
| Real accounts | `password_hash`, `email_verified_at` on `users`; a `sessions` table that actually holds sessions | The nullable columns already on `users` |

Everything hangs off `users.id`, which is the reason SP-V2-002 introduced a
surrogate key rather than keying `questions` on `username`. Each of these is a
new numbered file in `migrations/postgres/`; the existing one is immutable.

---

## 9. Known limitations

| # | Limitation | Consequence |
| --- | --- | --- |
| 1 | `POST /api/ask` stores the username **untrimmed** while `POST /api/session` trims it | `"ann"` and `"ann "` are two users. Pre-existing behaviour the API contract depends on; recorded as debt rather than changed inside a migration ticket. |
| 2 | Usernames are byte-compared | `"Ada"` and `"ada"` are two accounts. A case-insensitive login needs a migration, not a code change. Asserted so the behaviour is at least documented. |
| 3 | `answer` has no application-level schema validation | The CHECK constraint proves it is an object, not that it has `explanation` or `practice_questions`. A malformed model response is stored as-is. |
| 4 | `users.updated_at` is never updated | No trigger, and nothing writes it after insert. It exists for the profile editing a later ticket adds. |
| 5 | No connection retry or backoff | A blip surfaces as a 500 for the request that hit it. The pool recovers on the next request; nothing retries on the caller's behalf. |
| 6 | No read replicas, no partitioning, no archival | `questions` grows without bound. Fine at current scale; a retention policy is a later decision. |
| 7 | Data at rest is unencrypted | Same posture as the SQLite file. A deployment holding real student data needs disk encryption and a backup policy. |
