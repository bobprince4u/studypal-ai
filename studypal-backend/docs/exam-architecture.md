# Exam Architecture — AI Exam Simulator

> **Status.** SP-V2-006. Describes the six endpoints under `/api/exams` and
> `/api/exam-attempts`, and the domain behind them: validation, material
> grounding, structured generation, server-side grading, and the attempt
> lifecycle.
>
> The companion documents are
> [`database-architecture.md`](./database-architecture.md) for the schema and
> indexes, [`rag-architecture.md`](./rag-architecture.md) for the retrieval this
> feature reuses rather than reimplements,
> [`study-plan-architecture.md`](./study-plan-architecture.md) for the sibling
> generator this one is modelled on, and
> [`security-baseline.md`](./security-baseline.md) for the ownership model every
> endpoint here depends on.
>
> Everything below is asserted by `tests/exams/` — 200 tests across five suites.
> Where a claim is subtle, the assertion that holds it is named.

---

## 1. The flow

```
POST /api/exams
  {username, subject, topics[], difficulty, questionCount, questionTypes[],
   materialIds[]}
        │
        ▼
  validateCreateExamBody              ── every field, server-side, before anything
        │                                else runs. Bounds come from config.exam.
        ▼
  exam.controller.js                  ── HTTP in, HTTP out. No SQL, no provider,
        │                                no grading.
        ▼
  exam.service.js                     ── the use case, and the only orchestrator
        │
        ├─► user.repository            resolve username → user_id
        │
        ├─► material-brief.js          resolve materialIds against THIS user,
        │     ├─► material.repository    retrieve per-material extracts for a
        │     ├─► retrieval.service      query composed from subject + topics,
        │     └─► context-builder        build a bounded [Source N] block
        │
        ├─► exam-generator.js          ── the only module here that calls a model
        │     └─► gemini.client         generateJsonContent(schema)
        │           └─► exam-output.validator   reject or accept; at most one retry
        │
        └─► exam.repository            BEGIN … INSERT exam … INSERT questions … COMMIT
                                       (the transaction starts here, after the
                                        provider call has already returned)
        │
        ▼
  201 {id, title, subject, difficulty, questionCount, status, sourceType,
       topics, materialIds, createdAt, updatedAt, questions[]}
       └── questions carry NO correctAnswer and NO explanation
```

Then the sitting, which is a separate request per stage:

```
POST /api/exams/:id/attempts          → 201 {…attempt…, exam: {…questions…}}
                                             status 'in_progress', every result
                                             field null, still no answer key

POST /api/exams/:id/attempts/:aid/submit
  {username, answers: [{questionId, answer}]}
        │
        ▼
  ownership → belongs to exam → is active → question ids → answer formats
        │
        ▼
  BEGIN … load key FOR SHARE … grade … INSERT answers … UPDATE attempt … COMMIT
        │
        ▼
  200 {…result…, questions: [{…, correctAnswer, explanation,
                              selectedAnswer, isCorrect}]}
```

Three properties of that order are the point of the whole design, and all three
are tested rather than asserted here:

- **The provider call happens outside any transaction.** Generation can take
  seconds; a transaction open across it holds a pooled connection and an idle
  PostgreSQL backend for the duration. Under load that is pool exhaustion, and it
  is invisible in every test that runs one request at a time.
  `architecture.test.js` asserts the ordering positionally — `generateExam(`
  appears before `insertExamWithQuestions` in the service — and that neither the
  generator nor the validator mentions `withTransaction` at all.

- **Nothing is persisted until the exam is fully valid.** A rejected model
  response costs a provider call and nothing else — there is no partial exam to
  clean up, because there is no row. Eleven kinds of unusable output are each
  refused with a controlled 500; two of them then assert `{exams: 0,
  questions: 0}` across both tables, because an exam with no questions and an
  orphaned question are different bugs with the same symptom. The same test
  drives several refusals through one server and then checks the pool still
  answers, since a leaked transaction would show up as a later request hanging
  rather than as a bad row.

- **Grading happens inside the submission transaction**, against a key read with
  `FOR SHARE`. The key that was marked against and the key stored at COMMIT are
  provably the same rows.

---

## 2. Schema

Four tables, added by migration `005`. The columns and constraints are covered in
[`database-architecture.md`](./database-architecture.md) §2; what follows is only
what a reader of this feature needs.

```
users
  └── exams                  one row per generated exam
        ├── exam_questions   one row per question, ordered, WITH the answer key
        └── exam_attempts    one row per sitting
              └── attempt_answers   one row per ANSWERED question
```

**The answer key lives in `exam_questions.correct_answer`, server-side, and no
query that serves a learner taking an exam selects that column.** That is the
mechanism behind §4's "the client MUST NOT receive the correct answer while
taking the exam" — see §6 below, where it is a choice between two repository
functions rather than a field filter.

Every ownership foreign key here is **composite**, carrying `user_id`:

| Constraint | Makes unrepresentable |
| --- | --- |
| `exam_questions (exam_id, user_id) → exams (id, user_id)` | A question on another learner's exam |
| `exam_questions (source_material_id, user_id) → materials (id, user_id)` | A question citing another learner's document |
| `exam_attempts (exam_id, user_id) → exams (id, user_id)` | An attempt against another learner's exam |
| `attempt_answers (attempt_id, user_id) → exam_attempts (id, user_id)` | An answer on another learner's attempt |

§12's four rules are therefore database rules, not service checks that a future
handler could forget. `schema.test.js` asserts each one by attempting the
crossing INSERT and expecting it to fail.

### `attempt_answers_attempt_question_key`

`UNIQUE (attempt_id, exam_question_id)` is §4's "prevent duplicate answers for
the same question within one attempt". The service also rejects a payload
containing the same id twice with a `400`, but the constraint is what makes a
duplicate unrepresentable under a concurrent double-submit.

### `exam_attempts_result_matches_status`

The state machine as a CHECK: either the attempt is `in_progress` with
`submitted_at`, `score`, `total_questions`, `correct_answers`, `percentage` and
`passed` all NULL, or it is `completed` with all six present. No third shape is
storable, so a half-graded attempt cannot exist even if a writer tried.

Three more bound the result itself. `correct_answers <= total_questions` is the
one that matters: it makes an impossible grade fail loudly at the INSERT rather
than quietly becoming a 120% result. `score = correct_answers` catches the two
writers of §9's two names for one count disagreeing.

### An unanswered question is the absence of a row

`attempt_answers.selected_answer` is `NOT NULL`. A question the learner skipped
has no row at all, rather than a row with a NULL selection. That distinction is
what lets "unanswered" be counted as wrong (§4 of this document) without being
confused for "answered with nothing", and it is why the grading tests can assert
on row count as well as on score.

### `attempt_answers_question_fkey` is `DEFERRABLE INITIALLY DEFERRED`

Unusual enough to justify here as well as in the migration. Two deletions have to
behave differently:

- **Deleting a user or an exam must succeed.** The cascade reaches these rows by
  two paths — exam → questions, and exam → attempts → answers — and PostgreSQL
  runs each cascade as its own statement. An immediate or end-of-statement check
  fires while the sibling cascade has not run yet and aborts the whole delete.
- **Deleting one question of an attempted exam must fail.** It would leave an
  attempt whose `total_questions` no longer matches its questions: a silently
  corrupted grade, and corrupted input for SP-V2-007.

Deferring to COMMIT gives both. `CASCADE` would be the conventional choice and
would also permit the user delete, but it would silently delete graded history on
a single-question delete — and graded history is exactly what SP-V2-007 reads.

---

## 3. Input validation

Every field is checked server-side before anything else runs, by
`exam-validation.middleware.js`. Bounds come from `config.exam`, and each is
validated at startup against the CHECK constraint it corresponds to, so a
configuration that would let the API accept a value the database refuses fails at
boot rather than at the first request.

| Field | Rule |
| --- | --- |
| `username` | Required, non-blank, within `MAX_USERNAME_LENGTH` |
| `subject` | Required, non-blank, ≤ `maxTextChars` (200) |
| `topics[]` | Optional, ≤ `maxTopics` (20), each non-blank and ≤ `maxTextChars` |
| `difficulty` | One of `easy`, `medium`, `hard` |
| `questionCount` | Integer in `minQuestions`…`maxQuestions` (1…50); defaults to `defaultQuestionCount` (10) |
| `questionTypes[]` | Non-empty subset of `multiple_choice`, `true_false` |
| `materialIds[]` | Optional, ≤ `maxMaterials` (10), each a positive integer |

Path ids are validated before the body or query, so the more specific error wins:
a malformed exam id is a `400` about the id, not about a missing username.
`validateAttemptParams` covers both ids in one pass because the route has two.

On submit, the username is validated before the answers, so a request with no
username gets `"Username is required."` rather than a complaint about its answer
array.

---

## 4. Grading: the backend owns every number

`src/exams/grader.js` is a **pure function** over an exam's answer key and a
learner's submission. No database, no request, no clock, no Gemini — the same
inputs give the same result every time. That is what §5's "all grading must be
deterministic" means in practice, and it is what lets `grading.test.js` exercise
38 cases without a server or a provider.

```js
isCorrect  = selectedAnswer === question.correctAnswer   // §10, verbatim
percentage = Math.round((correctAnswers / totalQuestions) * 100)
passed     = percentage >= config.exam.passingPercentage // 70, at or above
```

Four decisions inside that are worth stating:

- **The loop iterates the QUESTIONS, not the submission.** The answer key decides
  what is on the paper. A submission carrying an extra entry cannot add a
  question and one missing an entry cannot remove one.

- **Unanswered questions count as wrong.** The percentage is over every question
  in the exam, not over the ones attempted: a 10-question paper with one correct
  answer and nine blank is 10%, not 100%. Scoring it the other way would make
  skipping the hard questions optimal, and would make two attempts at the same
  exam incomparable — which is the data SP-V2-007 is going to read.

- **The comparison is strict, case-sensitive, untrimmed.** Both sides are option
  ids the backend itself produced — the key from `exam_questions`, the selection
  validated against that question's own options — so any difference is a real
  difference and not a formatting artefact. Anything looser would be the grader
  deciding that `"b"` means `"B"`, which is a marking judgement, not arithmetic.

- **The threshold is stated once.** `config.exam.passingPercentage`, read by the
  grader and by nothing else; every other layer reads the boolean it returns.
  §10 forbids hardcoding it in multiple places, and `architecture.test.js` holds
  that two ways: the literal `70` appears nowhere under `src/` except as the
  environment variable's default in `env.js`, and `passingPercentage` occurs in
  the grader exactly three times — the parameter, its default, and the one
  comparison.

**Gemini is never asked to mark anything.** `architecture.test.js` asserts that
`grader.js` imports no AI module, and the score cannot be computed anywhere else
because nothing else knows how.

---

## 5. Materials: reuse, not a second RAG

§14 is explicit: "Do not implement a new vector-search system here. Reuse
SP-V2-004." `src/exams/material-brief.js` is the single module that reaches
across, and it reaches for three things — `material.repository`,
`retrieval.service` and `context-builder` — adding no similarity SQL of its own.

The difference from the study-plan brief is the query. A study plan retrieves per
topic; an exam has no typed question at all, so this module **composes a query
from the subject and the topics** and retrieves per material, interleaving the
results so one document cannot crowd out the rest of a multi-material exam.

`tests/materials/architecture.test.js` names the exact set of modules permitted
to import a material module — now three — and `tests/exams/architecture.test.js`
holds the same boundary from the other side, asserting that nothing under
`src/exams/` contains a vector operator, a cosine computation, or an embedding
call. That second rule carries a control: the same pattern is asserted to still
match `src/materials/retrieval.repository.js` and
`src/materials/retrieval.service.js`, so a green run is evidence the check was
looking rather than that the pattern had stopped matching anything.

### `sourceType` records what was retrieved, not what was asked for

`exams.source_type` is `'material'` only when material actually reached the
model. A request that named documents none of whose chunks were retrievable —
unindexed, or nothing above the similarity threshold — produced a topic-only
exam, and recording it as material-sourced would misdescribe it to SP-V2-007.

### A material the caller does not own is a 404, not a silent omission

`resolveMaterials` counts what is missing and the service refuses the whole
request. The learner asked for an exam on five documents; an exam on the four
they own, with no indication which is missing, is not that exam.

---

## 6. The answer key never leaves the server before submission

This is §4's central rule, and it is enforced structurally in four places rather
than by one filter:

1. **`findQuestionsForTaking` does not select `correct_answer` or
   `explanation`.** The fields are absent from the input to `toQuestionShape`,
   not filtered out of its output, so a mistake in that mapper could not expose
   them.
2. **`getAttempt` branches on status** and calls a *different* repository
   function for a completed attempt. The branch is a choice between two queries.
3. **The create and start-attempt responses go through the same taking shape**,
   even though the rows behind `POST /api/exams` do carry the key — §4's rule is
   about the moment, not the endpoint.
4. **`api.test.js` walks the response structurally.** `assertNoAnswerKey` recurses
   the whole JSON body looking for the key by name at any depth, rather than
   checking the fields it expects to be absent — a substring check would be
   satisfied by `"correctAnswers": null`, which is a different field.

`grading.test.js` asserts the negative directly: an in-progress attempt fetched
mid-exam contains no `correctAnswer` anywhere, and the same attempt after
submission contains one per question.

---

## 7. What the model decides, and what it does not

| The model decides | The backend decides |
| --- | --- |
| The exam title | Every id, and `question_order` (array position) |
| Each question's text | Which questions exist (the count is enforced) |
| The options and which is correct | Whether an answer is correct, at marking time |
| The explanation | The score, the percentage, and pass/fail |
| Which source it drew on (a number) | What that number resolves to, or that it resolves to nothing |

The model returns a **1-based source number** that means nothing outside the
prompt. It is resolved to a real `material_id` and `chunk_id` in the service —
the only layer still holding the list it was numbered against — and a number
outside the range is dropped, leaving both columns NULL. The question survives;
its false claim about provenance does not. Because the list was retrieved for
this user, `exam_questions_material_user_fkey` cannot be violated by an
attribution to someone else's document: there was no such document in the list to
attribute to.

### The validator rejects, it never repairs

`exam-output.validator.js` returns `null` for output it refuses; it does not trim,
pad, default or reorder. §8's rules, each with a test:

| Rejected | Rule |
| --- | --- |
| No questions at all | §7 — an exam with no questions is not a short exam |
| Wrong question count | §8 — checked before the per-question loop |
| A type outside what was requested | §2's two types, and the request's subset |
| MCQ without exactly 4 options | §8 |
| True/false without exactly 2 | §8, normalised rather than string-compared |
| Duplicate option ids | §7 — two options labelled "B" make the key ambiguous |
| A correct answer matching no option | §8 |
| Blank question text | — |
| Blank or missing explanation | §7 — rejected, not defaulted |

The one thing it *accepts* and modifies is over-long text: `clampText` shortens
at a word boundary to the configured limit. That is a formatting concern, not a
correctness one, and rejecting a good exam because one explanation ran long would
cost the learner a regeneration for nothing.

### The retry

At most one, and **only** for output the validator refused. Never for a provider
error. Unusable content is a sampling outcome — the same prompt sent again very
often produces a well-formed exam, and one extra call is a better outcome than an
error page after a generation the learner waited for. A provider *failure* is not
that: a 503, a timeout or an auth rejection will be the same the second time, and
retrying turns one outage into two calls per request at the moment the provider
is least able to serve them.

`config.exam.generationRetries` is the count of retries, and the generator makes
`retries + 1` attempts, so a configured `0` still makes the single call it was
asked for.

---

## 8. Attempt lifecycle

```
        POST /api/exams/:id/attempts
                    │
                    ▼
            ┌───────────────┐
            │  in_progress  │  score, percentage, passed … all NULL
            └───────────────┘
                    │  POST …/submit
                    ▼
            ┌───────────────┐
            │   completed   │  immutable
            └───────────────┘
                    │  POST …/submit again
                    ▼
              409, original result unchanged
```

Two states, not five. §4 sketched a longer lifecycle; nothing in SP-V2-006
expires or abandons an attempt, and a state nothing writes would be a guess about
SP-V2-007 encoded as a CHECK constraint. The same reasoning gives `exams.status`
two values — `ready` and `cancelled` — where `cancelled` is a seam with no writer,
following the convention `001` and `004` set.

### Double submission

Checked twice, deliberately:

1. An `if` at the top of `submitAttempt`, for the clean `409` in the ordinary
   case where the second request arrives after the first has finished.
2. A **compare-and-set** inside `completeAttempt` — the `UPDATE` carries
   `WHERE status = 'in_progress'` and the service treats "no rows matched" as the
   same conflict. This is what makes §11 hold when two submissions *race* rather
   than merely when they queue.

Either way the original result stands and nothing of the second submission is
written. `api.test.js` asserts the second response is a `409` **and** that a
subsequent `GET` returns the first submission's score.

---

## 9. Endpoints

| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| `POST` | `/api/exams` | JSON — subject, topics, difficulty, count, types, materials | `201` — the exam with its questions, **no key** |
| `GET` | `/api/exams/:id` | `?username=` | `200` — the same shape |
| `POST` | `/api/exams/:id/attempts` | JSON `{username}` | `201` — the attempt, questions nested under `exam` |
| `POST` | `/api/exams/:id/attempts/:attemptId/submit` | JSON `{username, answers[]}` | `200` — the graded result, **with** the key |
| `GET` | `/api/exams/:id/attempts/:attemptId` | `?username=` | `200` — in-progress without the key, completed with it |
| `GET` | `/api/exam-attempts` | `?username=` | `200` — array, newest first, ≤ `MATERIAL_LIST_LIMIT` |

Responses follow the existing envelope (§20): camelCase, no raw database rows,
and **a list is a bare array** — the same as `GET /api/history`,
`GET /api/materials` and `GET /api/study-plans`. Object envelopes in this API
carry an aggregate (`GET /api/progress` is `{total_questions, topics}`, a summary
rather than a collection). `architecture.test.js` asserts `listAttempts` returns
`rows.map(…)` and not an object, because the code did once return
`{attempts: […]}` — a wrapper worn by exactly one endpoint in the whole API,
which is what would have made it a second style.

### Knowing an exam id is not authorisation

All four ownership rules are a `WHERE` clause rather than an `if`:

```
retrieve someone else's exam      findOwnedExamById(id, userId)
use someone else's material       findOwnedByIds(ids, userId)
start an attempt on their exam    findOwnedExamById, before the insert
submit or read their attempt      findOwnedAttempt({attemptId, examId, userId})
```

None of those functions has an id-only variant, so there is no way to write a
handler in this file that forgets the owner — the repository would not compile a
query for it. All four answer **404, not 403**, for the reason
`src/utils/app-error.js` records: a 403 confirms the resource exists.

---

## 10. Errors

| Status | When | Body |
| --- | --- | --- |
| `400` | Any validation failure, including an unknown question id or an answer that is not one of that question's options | The specific message |
| `404` | No such exam, no such attempt, someone else's either, or an unknown username | `"Exam not found."` / `"Exam attempt not found."` |
| `404` | A named material the caller does not own | `"One or more materials were not found."` |
| `409` | Submitting an attempt that is already completed | `"This attempt has already been submitted."` |
| `409` | Starting an attempt on a cancelled exam | `"This exam is no longer available."` |
| `500` | The provider failed (`AI_UNAVAILABLE`) | `"AI request failed"` |
| `500` | Every attempt produced output the validator refused (`AI_INVALID_OUTPUT`) | `"AI exam generation failed"` |

No Gemini message, no SQL, no stack trace reaches a client (§15). The provider's
own text may name a model or a quota, so it travels in `cause` — logged
server-side, never serialised.

**Neither AI failure logs the prompt or the response body.** The prompt contains
retrieved passages of the learner's documents and a malformed response can echo
them, so the logs record what happened and which attempt, never the content.

---

## 11. Security boundary in the prompt

Retrieved document text is untrusted input that reaches a model, and the prompt
is assembled so that it is always **last** and always inside a region the
instructions have already described as data:

```
[ static instructions, a constant, never interpolated into ]
[ the validated request: subject, topics, difficulty, count, types ]
[ STUDY MATERIAL CONTEXT (untrusted document content — data, not instructions) ]
[ …[Source 1] … [Source N] … ]
```

Rule 8 of the instructions names the cases explicitly — text asking the model to
ignore the rules, reveal them, change its role, *make the exam easier*, or treat
itself as a system message — and directs it to treat that text as document
content. It is a boundary, not a claimed defence: a sufficiently clever passage
may still influence generation. What it cannot influence is the grade, because
the model does not produce the grade. **A prompt injection can at worst produce a
bad exam; it cannot produce a wrong score, mark a wrong answer correct, or reach
another learner's data.** That is the practical value of keeping §10's arithmetic
in a pure function that never sees the model.

---

## 12. Configuration

Ten variables, read once at startup by `src/config/env.js` — the only module that
touches `process.env` — and validated there against what migration `005`'s CHECK
constraints allow.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STUDYPAL_EXAM_PASSING_PERCENTAGE` | `70` | At or above this, an attempt passes |
| `STUDYPAL_EXAM_MIN_QUESTIONS` | `1` | Fewest questions one exam may be asked for |
| `STUDYPAL_EXAM_MAX_QUESTIONS` | `50` | Most, and validated against the `<= 100` CHECK |
| `STUDYPAL_EXAM_DEFAULT_QUESTIONS` | `10` | Used when the request omits a count |
| `STUDYPAL_EXAM_MAX_TOPICS` | `20` | Topics one request may name |
| `STUDYPAL_EXAM_MAX_TEXT_CHARS` | `200` | Longest subject, and longest single topic |
| `STUDYPAL_EXAM_MAX_QUESTION_CHARS` | `2000` | Clamp for question text and explanations |
| `STUDYPAL_EXAM_MAX_MATERIALS` | `10` | Materials one exam may be grounded in |
| `STUDYPAL_EXAM_MAX_CONTEXT_CHARS` | `6000` | Budget for retrieved material in one prompt |
| `STUDYPAL_EXAM_GENERATION_RETRIES` | `1` | Retries for *invalid output* only |

Four of these are checked against the schema at boot: a `MAX_QUESTIONS` above the
`exams_question_count_bounded` CHECK, or a `MAX_TEXT_CHARS` above
`exams_subject_bounded`, would let the API accept a request the database then
refuses — a 500 for input that passed validation. The startup check turns that
into a boot failure with the constraint named.

---

## 13. Tests

200 tests in five suites under `tests/exams/`, all against **real PostgreSQL** —
no SQLite, no in-memory substitute. Gemini and the embedding provider are faked by
patching `globalThis.fetch`, switched per server through `FAKE_EXAM_MODE`,
`FAKE_GEMINI_MODE` and `FAKE_EMBEDDING_MODE`.

| Suite | Tests | Covers |
| --- | --- | --- |
| `schema.test.js` | 47 | Tables, columns, constraints, indexes, cascade and deferred-FK behaviour |
| `grading.test.js` | 38 | The grader as a pure function, and the key's absence before submission |
| `api.test.js` | 56 | The six endpoints over real HTTP: contract, validation, ownership, lifecycle, double submit |
| `generation.test.js` | 24 | Malformed model output, the retry, clamping, source resolution, atomicity |
| `architecture.test.js` | 35 | The §4, §5, §7, §12, §13, §14, §23 and §24 boundaries, by reading the source tree |

`api.test.js` and `generation.test.js` are separate files because the test harness
fixes the child process's environment at spawn: exercising a different fake mode
requires a different server. `api.test.js` shares one default-mode server across
everything that does not care about the mode; `generation.test.js` pays for one
server per mode, only where the mode is the point. The fake provider offers
**seventeen** exam modes, one per validator rule plus `retry-once` and a
`long-text` mode that tests the accepting path.

Three claims the suites make structurally rather than by example:

- **The answer key is absent** is checked by recursing the entire response body
  for the key by name at any depth, not by asserting on the fields expected to be
  missing. A substring check passes on `"correctAnswers": null`, which is a
  different field — that false positive was found and fixed during the manual E2E
  pass.
- **Nothing is persisted on failure** is checked in *both* `exams` and
  `exam_questions`, because an exam with no questions and an orphaned question
  are different bugs with the same symptom. The same test also drives several
  refusals through one server and then queries the pool, since a leaked
  transaction shows up as a later request hanging rather than as a bad row.
- **No rule is vacuous.** Each source-tree assertion is paired with a control
  asserting its pattern still matches something — the no-vector-search rule
  asserts the same pattern *does* match the two retrieval modules in
  `src/materials/`.

---

## 14. Deferred, deliberately

| Not built | Why |
| --- | --- |
| Learning analytics, weak-area detection | §1 and §18 — that is SP-V2-007. The attempt and answer data it needs is already stored cleanly |
| Essay, free-text, coding, audio/video questions | §2. Two question types, both deterministically markable |
| A timer, or any time limit on an attempt | Nothing in §2 asks for one, and it would need an expiry state the lifecycle deliberately does not have |
| `GET /api/exams` — a list of a learner's exams | §9 names six routes and that is not one of them. `idx_exams_user_created` would serve it |
| Cancelling an exam or abandoning an attempt | `exams.status = 'cancelled'` exists with no writer, the same deliberate seam as `study_plans` |
| Retaking with shuffled questions or options | Order is `question_order`, stable by design, which is what makes two attempts comparable |
| Pagination of the attempt history | Capped at the material list ceiling, newest first, no cursor — the same limitation as the other three list endpoints |
| Partial credit, negative marking, per-question weighting | §10 defines one marking rule. Anything else is a product decision no requirement has asked for |

---

## 15. Related documents

- [`database-architecture.md`](./database-architecture.md) — schema, indexes,
  transactions, migrations
- [`study-plan-architecture.md`](./study-plan-architecture.md) — the sibling
  generator; the reject-never-repair validator and the retry rule are the same
  design
- [`rag-architecture.md`](./rag-architecture.md) — the retrieval this feature
  reuses; §4 and §5 cover the ownership predicate and the context budget
- [`material-processing.md`](./material-processing.md) — how the materials being
  examined got into the database
- [`security-baseline.md`](./security-baseline.md) — the unauthenticated
  username model every ownership check here rests on
- [`api-contract.md`](./api-contract.md) — the five original endpoints, frozen;
  the endpoints here are documented in §9 above rather than there
