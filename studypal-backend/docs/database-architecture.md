# Database Architecture

How StudyPal stores data, and why it stores it that way. Written for SP-V2-002,
which replaced SQLite with PostgreSQL, and extended by SP-V2-003 (`materials`,
`material_chunks`) and SP-V2-004 (pgvector embeddings and the indexing
lifecycle).

Companion documents: [`current-architecture.md`](./current-architecture.md) for
the application layers, [`api-contract.md`](./api-contract.md) for the
request/response contract these tables serve,
[`material-processing.md`](./material-processing.md) for how an upload becomes
chunks, [`rag-architecture.md`](./rag-architecture.md) for how those chunks
become searchable, and
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
| Uploaded-material search (SP-V2-00x) | No vector type, no trigram index, `LIKE '%x%'` only. | `pgvector` is an extension away — **now installed**, by migration `003`. |
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
- **No Redis, no queue, no ORM, and exactly two extensions** — the default
  `plpgsql` plus `vector`, which migration `003` enables because the retrieval
  query needs it. `pg_trgm` is still not installed. Asserted by a test, so adding
  a third is a deliberate act.

---

## 2. Schema overview

Six application tables plus the migration runner's bookkeeping. `users` and
`questions` came from SP-V2-002; `materials` and `material_chunks` were added by
SP-V2-003; `study_plans` and `study_plan_tasks` by SP-V2-005.

```
users
  ├── questions               one row per question asked      (SP-V2-002)
  ├── materials               one row per uploaded document   (SP-V2-003)
  │     └── material_chunks   one row per text chunk, ordered (SP-V2-003)
  └── study_plans             one row per generated plan      (SP-V2-005)
        └── study_plan_tasks  one row per scheduled session   (SP-V2-005)
                └╌╌╌╌╌╌╌╌╌╌╌ may cite one material, optionally, and only
                             ever one belonging to the same user
```

Everything hangs off `users.id`, and **every foreign key that expresses
ownership is `ON DELETE CASCADE`** — deleting a user removes their questions,
their materials, those materials' chunks, their study plans and those plans'
tasks, in one statement. The two references added by `004` that are *not*
ownership — a task's optional `material_id`, and a plan's optional
`parent_plan_id` — are `ON DELETE SET NULL`, because losing the thing referred
to does not invalidate the row referring to it.

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

┌─────────────────────────────────────────────┐
│ materials                                   │
├─────────────────────────────────────────────┤
│ id                BIGINT       PK identity  │
│ user_id           BIGINT       NOT NULL  FK │ → users (id), CASCADE
│ original_filename TEXT         NOT NULL     │ metadata only, never a path
│ storage_key       TEXT         NOT NULL   ∪ │ generated, opaque
│ mime_type         TEXT         NOT NULL     │ determined from content
│ file_size         BIGINT       NOT NULL     │
│ status            TEXT         NOT NULL     │ = 'uploaded'
│ page_count        INTEGER      NULL         │ NULL for .txt
│ error_message     TEXT         NULL         │ set iff status = 'failed'
│ indexing_status   TEXT         NOT NULL     │ = 'pending'  (003)
│ indexing_error    TEXT         NULL         │ set iff indexing_status='failed'
│ created_at        TIMESTAMPTZ  NOT NULL     │
│ updated_at        TIMESTAMPTZ  NOT NULL     │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ material_chunks                             │
├─────────────────────────────────────────────┤
│ id           BIGINT       PK identity       │
│ material_id  BIGINT       NOT NULL       FK │ → materials (id), CASCADE
│ chunk_index  INTEGER      NOT NULL        ∪ │ ∪ = (material_id, chunk_index)
│ content      TEXT         NOT NULL          │
│ page_number  INTEGER      NULL              │ NULL when unknown
│ char_count   INTEGER      NOT NULL          │ = char_length(content)
│ embedding    vector(1536) NULL              │ NULL until indexed  (003)
│ created_at   TIMESTAMPTZ  NOT NULL          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ study_plans                                 │
├─────────────────────────────────────────────┤
│ id              BIGINT      PK identity     │◄──┐ ∪ also (id, user_id)
│ user_id         BIGINT      NOT NULL     FK │ → users (id), CASCADE
│ title           TEXT        NOT NULL        │   │
│ subject         TEXT        NOT NULL        │   │
│ goal            TEXT        NOT NULL        │   │
│ start_date      DATE        NOT NULL        │   │ first scheduled task
│ end_date        DATE        NOT NULL        │   │ last scheduled task
│ exam_date       DATE        NOT NULL        │   │ ≥ end_date
│ daily_minutes   INTEGER     NOT NULL        │   │ 1…1440
│ difficulty_level TEXT       NOT NULL        │   │ beginner|intermediate|advanced
│ status          TEXT        NOT NULL        │   │ = 'active'
│ topics          TEXT[]      NOT NULL        │   │ = '{}'
│ study_days      TEXT[]      NOT NULL        │   │ 1-7 lowercase weekdays
│ material_ids    BIGINT[]    NOT NULL        │   │ = '{}'  request record, not FK
│ parent_plan_id  BIGINT      NULL         FK │ ──┘ SET NULL. The plan this one
│ created_at      TIMESTAMPTZ NOT NULL        │     regenerated from
│ updated_at      TIMESTAMPTZ NOT NULL        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ study_plan_tasks                            │
├─────────────────────────────────────────────┤
│ id             BIGINT      PK identity      │
│ study_plan_id  BIGINT      NOT NULL      FK ╗ (study_plan_id, user_id)
│ user_id        BIGINT      NOT NULL         ╝ → study_plans (id, user_id), CASCADE
│ scheduled_date DATE        NOT NULL       ∪ │ ∪ = (study_plan_id,
│ position       INTEGER     NOT NULL       ∪ │      scheduled_date, position)
│ title          TEXT        NOT NULL         │
│ description    TEXT        NULL             │
│ topic          TEXT        NULL             │
│ task_type      TEXT        NOT NULL         │ study|review|practice|recap
│ duration_minutes INTEGER   NOT NULL         │ 1…1440
│ status         TEXT        NOT NULL         │ = 'pending'
│ material_id    BIGINT      NULL          FK ╗ (material_id, user_id)
│                                             ╝ → materials (id, user_id),
│ created_at     TIMESTAMPTZ NOT NULL         │   SET NULL (material_id)
│ updated_at     TIMESTAMPTZ NOT NULL         │
└─────────────────────────────────────────────┘

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

**Relationships:** one user has many questions, many materials and many study
plans; one material has many chunks; one plan has many tasks. `ON DELETE
CASCADE` on every path back to `users` means deleting a user deletes all of it —
chosen so the first data-deletion request is a `DELETE` rather than a migration.
The one thing the cascade cannot reach is the filesystem: deleting a user through
SQL orphans their uploaded bytes on disk. Nothing does that today, and it is
recorded as a limitation in §9 rather than worked around with a trigger.

**Embeddings live in `material_chunks.embedding`**, added by migration `003` as
002 predicted: a nullable `ALTER TABLE … ADD COLUMN embedding vector(1536)` that
rewrites no rows. NULL is a legitimate state — a chunk exists the moment the
processing pipeline persists it, and embedding happens afterwards over the
network, so a `NOT NULL` column would force the two into one transaction held
open across a Gemini call.

`materials.indexing_status` is a **second, orthogonal lifecycle column** rather
than new values in `status`: `ready` means the document was parsed and chunked,
`indexed` means it is searchable, and a material can be one without the other.
Widening `status` instead would have silently redefined `ready` to mean less than
it already did, while every existing test and client kept passing.

**No ANN index on the vector column**, deliberately — exact search has perfect
recall, and the user filter already reduces each query to tens or low thousands of
candidate rows. The full reasoning, the trigger for revisiting it, and the one
`CREATE INDEX` it would take are in
[`rag-architecture.md`](./rag-architecture.md) §4 and inline in the migration.

The full DDL, with a comment on every non-obvious decision, is
[`migrations/postgres/001_core_schema.sql`](../migrations/postgres/001_core_schema.sql),
[`migrations/postgres/002_materials.sql`](../migrations/postgres/002_materials.sql),
[`migrations/postgres/003_material_embeddings.sql`](../migrations/postgres/003_material_embeddings.sql)
and
[`migrations/postgres/004_study_plans.sql`](../migrations/postgres/004_study_plans.sql).
Those files are the source of truth; this section describes them.

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

### `materials` and `material_chunks`

Added by SP-V2-003 for uploaded study documents. The pipeline that writes them —
validation, storage, extraction, normalization, chunking — is documented in
[`material-processing.md`](./material-processing.md); what follows is only the
part that is a schema decision.

- **`storage_key`, not a path.** Uploaded filenames are attacker-controlled, so
  the key is generated (a hyphen-stripped UUID plus the validated extension) and
  the original filename is stored as metadata that nothing resolves. The
  `materials_storage_key_safe` CHECK enforces the same character rule the storage
  service enforces in code — one stops a bad key being *stored*, the other stops
  one being *used*, and they fail at different times.
- **`status` is a CHECK constraint, not a PostgreSQL enum**, following the
  convention 001 set for `topic`. Adding a state to a CHECK is one migration that
  rewrites no rows, whereas `ALTER TYPE … ADD VALUE` cannot run inside a
  transaction block on older servers and cannot remove a value at all.
- **`error_message` is tied to `status` by a constraint.**
  `materials_error_message_matches_status` requires it exactly when `status =
  'failed'` and forbids it otherwise, so a failure cannot reach a client with
  nothing to show and a success cannot carry a stale error.
- **`char_count` is denormalised** and checked against `char_length(content)`, so
  a mismatch between the chunker's arithmetic and what was written is a write
  error rather than silent drift.
- **`page_number` is nullable on purpose.** `.txt` has no pages, and a PDF page
  whose text the parser cannot attribute gets `NULL` rather than an invented
  number — a wrong citation is worse than an absent one.
- **`UNIQUE (material_id, chunk_index)`** because ordering is part of the data: a
  duplicate index is a corrupt document, not a tolerable retry artefact.

`tests/materials/schema.test.js` asserts each of these through SQL — what is
tested is that the *database* refuses the bad row, not that the application
avoids writing it.

`topic` is denormalised out of `answer` on purpose: `GET /api/progress` groups by
it, and a plain indexed column beats a JSONB expression for the one field that is
queried rather than merely displayed.

### `study_plans` and `study_plan_tasks`

Added by SP-V2-005. The domain that writes them — validation, scheduling,
generation, normalization — is documented in
[`study-plan-architecture.md`](./study-plan-architecture.md); what follows is
only the part that is a schema decision.

- **`study_plan_tasks.user_id` is denormalised, and nothing reads it.** A task's
  owner is derivable by joining to its plan. The column exists so two foreign
  keys can be composite — `(study_plan_id, user_id) → study_plans (id, user_id)`
  and `(material_id, user_id) → materials (id, user_id)` — which makes **a task
  citing another learner's material unrepresentable** rather than merely
  prevented by a check in the service layer. That is also why `004` adds
  `materials_id_user_key UNIQUE (id, user_id)` to a table it otherwise does not
  touch: a composite FK needs a composite key to point at. The cost is one
  redundant `BIGINT` per task, which the column's `COMMENT` admits.
- **`material_ids BIGINT[]` is a record of the request, not a live reference.**
  The ids are re-resolved against `materials` with the owner in the `WHERE`
  clause every time they are used, so a material deleted afterwards simply
  resolves to nothing. An array of foreign keys is not something PostgreSQL can
  enforce anyway, and a join table would imply a currency the column does not
  have.
- **`ON DELETE SET NULL (material_id)`**, not cascade. Deleting a material nulls
  the citation and leaves the task intact — a study session does not stop being
  one because the PDF behind it was removed, and cascading would silently delete
  work a learner had already completed.
- **`parent_plan_id` rather than a `version` column.** Regeneration inserts a new
  plan pointing at the old one and archives the old one; it never mutates a row
  a learner may have worked through. `study_plans_parent_not_self` forbids the
  one-row cycle; the reference is `ON DELETE SET NULL` so deleting an ancestor
  does not take its descendants with it.
- **`UNIQUE (study_plan_id, scheduled_date, position)`** because order within a
  day is part of the data, exactly as `(material_id, chunk_index)` is for
  chunks. It also *is* the index §51 asks for on `(study_plan_id,
  scheduled_date)`, so no second index was created.
- **`end_date >= start_date` and `end_date <= exam_date` are CHECK
  constraints**, not service-layer assertions. A plan that ends after the exam it
  prepares for is meaningless, and the constraint holds for any writer, including
  a future one.
- **`study_days` is constrained to the seven lowercase weekday names** by
  `study_days <@ ARRAY['monday', …]` plus a cardinality check of 1–7. The
  application lowercases and deduplicates before writing; the constraint means a
  writer that forgets cannot produce a plan whose schedule cannot be interpreted.
- **Status values are CHECK constraints, not enums**, following the convention
  001 set. `cancelled` is accepted and nothing writes it — a deliberate seam, not
  an oversight.

`tests/study-plans/schema.test.js` asserts each of these through SQL — including
that the database itself rejects a task whose `material_id` belongs to another
user, which is the whole reason the composite key exists.

### Types, and why the API did not change

| Decision | Reason |
| --- | --- |
| `BIGINT GENERATED ALWAYS AS IDENTITY` | The SQL-standard spelling. `ALWAYS` stops an INSERT supplying its own id, which would leave the sequence behind the table. `BIGINT` because widening a PK later means rewriting every referencing row. |
| No UUIDs | Nothing here needs a client-generated or globally-unique id. A UUID PK would cost index size and locality for a property no requirement asks for. |
| `TIMESTAMPTZ`, not `TIMESTAMP` | An instant, not a wall-clock reading. The pool pins the session to UTC so the same row renders identically on every machine. |
| `DATE` for everything a study plan schedules | A calendar day, not an instant. "Monday the 14th" does not move when a learner travels, and a `TIMESTAMPTZ` would make it depend on the reader's offset. `pg-types` keeps these as raw `YYYY-MM-DD` strings for the same reason. |
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

Six indexes exist beyond what the PK and UNIQUE constraints create, and each
one serves a query in the code today. No speculative indexes: every index costs
write throughput and disk, and an unused one is pure loss.

| Index | Serves | Why this shape |
| --- | --- | --- |
| `idx_questions_user_created (user_id, created_at DESC)` | `GET /api/history/:username` — `WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30` | Equality column first, then the sort column. PostgreSQL finds the user's rows and walks them already in order, so the `LIMIT` stops after 30 with no sort step. This is the index SP-V2-001 deferred (A9). |
| `idx_questions_user_topic (user_id, topic)` | `GET /api/progress/:username` — `WHERE user_id = $1 GROUP BY topic ORDER BY count DESC LIMIT 6` | Including `topic` lets the grouping read the index rather than fetching every matching row. A second index on the same leading column is only worth it because progress is called on every page load alongside history. |
| `idx_materials_user_created (user_id, created_at DESC)` | `GET /api/materials?username=…` — `WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2` | Same shape and same reasoning as the history index, and the only material query no PK or UNIQUE constraint already covers. This is §29's "index material ownership". |
| `idx_study_plans_user_created (user_id, created_at DESC)` | `GET /api/study-plans?username=…` — `WHERE user_id = $1 ORDER BY created_at DESC, id DESC` | The third instance of the same shape, for the third list-my-own-rows endpoint. This is §51's "index `user_id`". |
| `idx_study_plan_tasks_material (material_id, user_id) WHERE material_id IS NOT NULL` | The referential check behind `DELETE /api/materials/:id` — PostgreSQL must find tasks pointing at the material being deleted | **Partial.** Most tasks cite no material (§7: not every task has one), and a NULL row has nothing to find, so the predicate keeps the index proportional to the grounded tasks rather than to all of them. Without it, every material deletion sequentially scans every task in the database. Column order matches the foreign key's own. |
| `users_username_key` (from the UNIQUE constraint) | Every endpoint — each resolves a username to a `user_id` first | Also the constraint `POST /api/session` relies on via `ON CONFLICT (username)`. |

`material_chunks` gets **no added index**. Its `UNIQUE (material_id,
chunk_index)` constraint already provides the index for both queries against it —
the ordered read (`WHERE material_id = $1 ORDER BY chunk_index`) and the
chunk-count aggregate — so §29's "index chunk ordering" is satisfied by a
constraint that had to exist anyway. Adding a second index on `material_id` alone
would duplicate that one's leading column for no gain.

**`study_plan_tasks` gets nothing for the read that matters either**, for the
same reason. `UNIQUE (study_plan_id, scheduled_date, position)` is exactly the
index SP-V2-005 §51 asks for on `(study_plan_id, scheduled_date)`, and it serves
both the ordered read of a plan's tasks and the per-day grouping the normalizer's
output is checked against. The per-plan ownership check — `WHERE id = $1 AND
user_id = $2`, the only way a plan is ever fetched — is served by
`study_plans_id_user_key`, which had to exist anyway as the composite foreign
key's target. Two constraints that were required for correctness happen to be the
two indexes the query plan wants, so `004` creates only the two above.

**And no index on `material_chunks.embedding`.** pgvector's HNSW and IVFFlat are
*approximate*: they trade recall for speed. Retrieval here answers a student's
question from their own notes, where a missed chunk is a wrong answer or a false
"your materials do not cover this" — recall is the product. The per-user (and
often per-material) filter already reduces each query to tens or low thousands of
candidate rows, which is a fast exact scan, whereas an ANN index is built over the
whole table and searched *before* that filter is applied, so at this scale it can
return fewer than K rows for the user while also being less accurate. Exact search
is intentional and documented; §4 of [`rag-architecture.md`](./rag-architecture.md)
records the trigger for revisiting it and the single `CREATE INDEX … USING hnsw
(embedding vector_cosine_ops)` it would take. `materials.indexing_status` gets no
index either — the one query filtering on it is already scoped by primary key, and
a single-column index on a four-value column would never be chosen.

`tests/schema.test.js` asserts the exact index list on `questions`,
`tests/materials/schema.test.js` does the same for both material tables, and
`tests/study-plans/schema.test.js` for both plan tables, so adding one fails a
test and prompts a justification. All three suites also run `EXPLAIN` against the
queries these indexes exist for, at a few thousand rows, and assert the planner
actually uses them — an index PostgreSQL declines to use is the same as no index,
and at fixture scale a sequential scan genuinely is cheaper, so the tests build
enough rows to reach the regime the index exists for.

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
3. **Embedding persistence** — every vector for one material plus its
   `indexing_status` in one transaction, so a material can never be marked
   `indexed` with some of its chunks unembedded.

**No transaction is ever held open across a provider call.** Indexing reads the
chunks needing embeddings (connection taken and released), calls Gemini with
nothing held however long it takes, then writes vectors and status in the one
transaction above. Embedding chunk-by-chunk inside the persistence transaction
would hold a pooled connection for every network round trip, and `DB_POOL_MAX` is
10. `POST /api/materials/chat` holds no transaction at all.

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
API key is needed to run the suite. The same preload fakes **embedding** requests
as well as generation, each with its own switch for the failure modes — and the
retrieval tests use fixture vectors built from an orthonormal basis, so
similarity scores and nearest-neighbour ordering are exact known values rather
than whatever a provider happens to return.

### Local setup

```bash
cd studypal-backend
cp .env.example .env          # then set POSTGRES_PASSWORD
npm run db:up                 # pgvector/pgvector:pg16 on 127.0.0.1:5434
npm run migrate
npm test
```

`compose.yaml` pins **`pgvector/pgvector:pg16`** — not the official `postgres`
image, which does not ship the `vector` extension that migration `003` requires —
binds only to `127.0.0.1`, and takes its password from the environment with no
default: `POSTGRES_PASSWORD:?` fails the command rather than starting a database
with a known password. Port **5434** rather than 5432, so it cannot collide with a
PostgreSQL already installed on the host. Nothing about it is committed except the
compose file itself.

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

These do **not exist yet**. A table with no code reading it is a guess about a
future requirement rather than a schema, and `tests/schema.test.js` asserts by
name that none of the reserved tables exist, so creating one early fails a test.

| Feature | Expected shape | Attaches to |
| --- | --- | --- |
| Exams and attempts | `exams`, `exam_questions`, `exam_attempts`, `attempt_answers` | `exams.user_id → users.id` |
| Learning analytics | `learning_events` | `learning_events.user_id → users.id` |
| Real accounts | `password_hash`, `email_verified_at` on `users`; a `sessions` table that actually holds sessions | The nullable columns already on `users` |
| Multi-turn material chat | `conversations`, `conversation_messages` | `conversations.user_id → users.id`; each question is independent today |

Three rows have left this table by being built. SP-V2-003 created `materials` and
`material_chunks`; **SP-V2-004 added semantic search over them** — the `vector`
extension, `material_chunks.embedding` as `vector(1536)`, and the
`indexing_status` lifecycle, all in migration `003`; and **SP-V2-005 created
`study_plans` and `study_plan_tasks`** in migration `004`. All now live in §2,
and [`rag-architecture.md`](./rag-architecture.md) and
[`study-plan-architecture.md`](./study-plan-architecture.md) document the
features built on them.

The study-plan tables landed with one shape this table did not predict:
`study_plan_tasks` attaches to `study_plans` through a **composite** foreign key
carrying `user_id`, not through `study_plan_id` alone. The prediction
`study_plans.user_id → users.id` was right and is what the plan table does; the
task table needed more, because a task can also cite a material, and only a
composite key can make "cite *someone else's* material" impossible rather than
merely checked. §2 covers the reasoning.

What `003` deliberately did **not** create is an ANN index on the vector column:
exact search has perfect recall, the per-user filter keeps each query small, and
an approximate index searched before that filter can return fewer than K rows for
the user *and* be less accurate. `tests/materials/schema.test.js` asserts the
exact index list on these tables, so adding one fails a test and demands a
justification — the same rule every other index here is held to.

Everything hangs off `users.id`, which is the reason SP-V2-002 introduced a
surrogate key rather than keying `questions` on `username`. Each of these is a
new numbered file in `migrations/postgres/`; the existing ones are immutable.

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
| 8 | **The cascade stops at the database.** Deleting a user removes their materials and chunks but not the uploaded files those rows pointed at | Orphaned bytes in the storage directory. Nothing triggers it today — there is no user-deletion endpoint, and `DELETE /api/materials/:id` removes the file explicitly — so it is recorded rather than solved with a trigger that would have to reach outside PostgreSQL. |
| 9 | `materials.updated_at` is maintained by the repository, not by a trigger | Every status transition sets it in its `UPDATE`. A future writer that forgets to would leave it stale, the same exposure as limitation 4. |
| 10 | `material_chunks.content` is stored inline, so PostgreSQL TOASTs and compresses it | Fine at a 10 MB upload cap: a chunk is ~1800 characters and a large document is a few thousand rows. A corpus large enough to care would want the text out of the row, which is a decision for whichever iteration hits it. |
| 11 | No deduplication of identical uploads | The same document uploaded twice is two `materials` rows, two storage keys and two chunk sets. Content addressing would fix it and is a later decision. |
| 12 | The embedding dimension is baked into the DDL as `vector(1536)` | `STUDYPAL_EMBEDDING_DIM` is validated against it at startup only as a **warning**, not a refusal. Set them differently and uploads still succeed, extraction still succeeds, and every embedding write then fails at the column's type check — visible as `indexing_status = 'failed'`, not as a startup error. Changing the dimension for real is a new migration plus a full re-index, never a config edit. |
| 13 | **A vector is bigger than the text it indexes.** 1536 four-byte floats is ~6 KB per chunk against ~1.8 KB of content | Indexing roughly quadruples what a material costs on disk. Acceptable at a 10 MB upload cap and one of the three reasons the dimension is 1536 rather than the model's native 3072; a much larger corpus would want a smaller dimension or the vectors in their own table. |
| 14 | **Nothing detects a mixed embedding space.** Vectors written under one model and a query embedded under another are still comparable *to PostgreSQL* | `<=>` returns a number for any two vectors of equal width, so the failure mode is not an error but confident nonsense in the ranking. No column records which model produced a row. The remedy is `reindexMaterial` run deliberately after any model change, which is why that consequence is documented in three places rather than left to be discovered. |
| 15 | **`study_plans.material_ids` can dangle.** It is a `BIGINT[]`, so no foreign key constrains it and deleting a material leaves its id in the array of every plan that named it | Harmless by construction — the ids are re-resolved against `materials` with the owner in the `WHERE` clause on every use, so a deleted one resolves to nothing. But the column is a record of the request, not a live reference, and anything that reads it as a live reference will be wrong. §2 covers why it is not a join table. |
| 16 | **"Today" is the server's UTC today**, and study plans are `DATE` columns | A learner in UTC+13 asking for a plan at 10am on the 15th gets one starting on the 14th, because that is still the date in UTC. The alternative — trusting a client-supplied date — is worse, since it lets a caller schedule into the past. A real fix is a per-user timezone on `users`, which is a product decision no requirement has asked for yet. |
| 17 | **Archived plans accumulate.** Every regeneration inserts a new plan and archives the old one; nothing prunes the chain | Deliberate — the old plan holds task progress a learner may have made, and §30 is explicit that regeneration must not overwrite. But a learner who regenerates twenty times has twenty rows, all returned by `GET /api/study-plans`, which has no status filter. Same family as limitation 6: fine at current scale, a retention decision later. |
| 18 | **`GET /api/study-plans` is capped, not paginated** | It reuses the material list ceiling and returns the newest N with no cursor, so a learner past that count cannot reach their oldest plans through the API. The cap exists to bound the response; pagination is the thing that was not built, and the same is true of the other two list endpoints. |
| 19 | **`updated_at` on both new tables is maintained by the repository, not by a trigger** | Every `UPDATE` sets it explicitly. Identical exposure to limitations 4 and 9: a future writer that forgets leaves it stale, and nothing catches that. The consistent fix across all four tables is one trigger function, which is a migration nobody has needed badly enough yet. |
