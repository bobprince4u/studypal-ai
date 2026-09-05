# StudyPal — API Contract

> **Status.** This is the contract as **measured** against the pre-refactor
> `server.js` at commit `634c9d8`, and re-verified against the refactored backend
> at the end of SP-V2-001. Every status code and body below was observed, not
> inferred from reading the source.
>
> Reproduce with: `node tests/characterize.mjs` (dumps raw responses) or
> `npm test` (asserts them).
>
> A short list of **deliberate, documented deviations** introduced by SP-V2-001
> is at the end (§7). Everything not listed there is byte-for-byte unchanged.

- Base URL: `http://localhost:4000` (override with `PORT`)
- Frontend base URL: `process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"`
- All request and response bodies are JSON unless stated otherwise.
- There is **no authentication**. `username` is a self-asserted plaintext
  identifier sent on every request.

---

## Shared shapes

### `AnswerObject`

What `POST /api/ask` returns and what is stored (serialised) in
`questions.answer`. **The server does not validate these fields** — it guarantees
only that the value is a JSON object. The keys below are what the prompt asks the
model for, and what the frontend reads.

```ts
{
  explanation: string,
  topic: string,                       // 2–4 words, e.g. "Photosynthesis"
  practice_questions: Array<{
    question: string,
    answer: string
  }>,                                  // prompt asks for exactly 2
  encouragement: string
}
```

**Degraded form.** If the model's output cannot be parsed as JSON even after
fence-stripping, the server substitutes:

```json
{
  "explanation": "<the raw model text>",
  "topic": "Study Topic",
  "practice_questions": [],
  "encouragement": "Keep going!"
}
```

This is returned with `200`. The client cannot distinguish it from a real answer.

### `ErrorObject`

```ts
{ error: string }
```

---

## 1. `POST /api/session`

Create or resume a study session. Idempotent.

**Purpose.** Registers a username so the app has an identity to attach questions
to. Called once, from the login screen.

### Request

`Content-Type: application/json`

```json
{ "username": "Amara" }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | string | yes | Trimmed server-side. Must be non-empty after trimming. |

### Response `200`

```json
{
  "username": "Amara",
  "created_at": "2026-09-05T00:37:31.233Z"
}
```

`created_at` is an ISO-8601 string. On a repeat call for an existing username the
**original** `created_at` is returned (`INSERT OR IGNORE`), not a new one.

### Errors

| Condition | Status | Body |
| --- | --- | --- |
| `username` missing, `null`, `""` or whitespace-only | `400` | `{"error":"Username required"}` |
| `username` is not a string (e.g. `42`) | `400` | `{"error":"Username required"}` — see §7.1 |
| Request has no body / non-JSON content type | `400` | `{"error":"Username required"}` — see §7.1 |
| Malformed JSON | `400` | `{"error":"Invalid JSON body"}` — see §7.2 |
| Body > 100 KB | `413` | `{"error":"Request body too large"}` — see §7.2 |

### Behaviour notes

- The username is **trimmed**: `"  Amara  "` creates and returns `"Amara"`.
- There is **no length limit** in the pre-refactor server (a 2000-character
  username was accepted). See §7.3.
- `username` is `UNIQUE` in `sessions`, so this endpoint can never create a
  duplicate row.

### Frontend usage

[`app/page.jsx:543`](../../studypal-frontend/app/page.jsx#L543) — `handleLogin()`:

```js
const res  = await fetch(`${API}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: inputName.trim() }),
});
const data = await res.json();
if (data.error) throw new Error(data.error);
setUsername(data.username);
```

The frontend **ignores the HTTP status** and branches on `data.error`. It reads
only `data.username`; `created_at` is not used. If `res.json()` throws (an HTML
error page), the `catch` shows a fixed string: *"Could not connect to backend.
Is it running?"*

---

## 2. `POST /api/ask`

Ask an academic question, optionally with a study file. Calls Gemini and persists
the interaction.

**Purpose.** The core product loop. This is the only endpoint that costs money.

### Request

`Content-Type: multipart/form-data`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | text | yes | **Not** trimmed on this endpoint. Not checked against `sessions`. |
| `question` | text | yes | Must be non-empty after trimming. |
| `file` | file | no | Single file, field name exactly `file`. |

> **`application/json` is also accepted.** `express.json()` is registered
> globally and multer passes non-multipart requests through, so
> `{"username":"…","question":"…"}` behaves identically (without a file). This is
> unintentional but part of the measured contract and is preserved.

### Response `200`

An [`AnswerObject`](#answerobject), returned **verbatim from the model** (or the
degraded form). No wrapper, no metadata, no id.

```json
{
  "explanation": "Photosynthesis is how green plants make their own food using sunlight.",
  "topic": "Photosynthesis",
  "practice_questions": [
    { "question": "What gas do plants take in?",      "answer": "Carbon dioxide." },
    { "question": "Where does photosynthesis happen?", "answer": "In chloroplasts." }
  ],
  "encouragement": "You are doing great — keep it up!"
}
```

### Errors

| Condition | Status | Body |
| --- | --- | --- |
| `username` missing/empty, or `question` missing/empty/whitespace | `400` | `{"error":"Username and question required"}` |
| Gemini returns an HTTP error | `500` | `{"error":"AI request failed"}` — see §7.4 |
| Gemini unreachable (transport failure) | `500` | `{"error":"AI request failed"}` — see §7.4 |
| Upload exceeds the size limit | `413` | `{"error":"File too large"}` — see §7.5 |
| Upload type not supported | `415` | `{"error":"Unsupported file type"}` — see §7.5 |
| `content-type: text/plain` (unparseable body) | `400` | `{"error":"Username and question required"}` — see §7.1 |

Validation runs **before** any AI call, so a `400` costs nothing and writes
nothing.

### File handling

Dispatch is by **filename extension**, lower-cased, taken as the substring after
the last `.`:

| Extension | Sent to Gemini as | Notes |
| --- | --- | --- |
| `jpg`, `jpeg`, `png`, `gif`, `webp` | `inlineData` part, base64 | MIME derived from the extension (`jpg` → `image/jpeg`) — the client's declared MIME type is ignored |
| `pdf` | text part, **first 4000 chars** of extracted text | `pdf-parse`, loaded lazily. On any parse failure the part becomes `[A PDF was uploaded but could not be parsed.]` and the request still returns `200` |
| `txt`, `md`, `csv`, `json`, `log` | text part, **first 4000 chars** decoded as UTF-8 | |
| anything else | *pre-refactor:* same UTF-8 text path (`.exe` returned `200`) | *post-refactor:* `415` — see §7.5 |

On success the row records `has_file = 1` and `filename = <client-supplied
originalname>`. **The file content itself is never persisted** — only the name.

### Frontend usage

[`app/page.jsx:577`](../../studypal-frontend/app/page.jsx#L577) — `handleAsk()`:

```js
const formData = new FormData();
formData.append("username", username);
formData.append("question", q);
if (f) formData.append("file", f);

const res  = await fetch(`${API}/api/ask`, { method: "POST", body: formData });
const data = await res.json();
setMessages(prev => [...prev.filter(m => m.type !== "typing"), { type: "ai", data }]);
await Promise.all([loadHistory(username), loadProgress(username)]);
```

> **Compatibility hazard (pre-existing).** The frontend checks **neither
> `res.ok` nor `data.error`** here. An error body is pushed into the transcript
> as an AI message, so `data.explanation` is `undefined` and the user sees an
> empty assistant bubble rather than an error. This is recorded as
> [A17](./current-architecture.md#9-known-architectural-problems); it is a
> frontend bug and was **not** changed in SP-V2-001 (no frontend rewrite).
> Because of it, **the error body shape for this endpoint must keep an `error`
> key and must not become a non-object**, or the UI will crash instead of
> rendering a blank bubble.

The frontend reads `data.topic`, `data.explanation`,
`data.practice_questions[].question`, `data.practice_questions[].answer`, and
`data.encouragement`. `practice_questions` is accessed with `?.length`, so an
absent or empty array is safe; `topic` falls back to the literal `"General"` in
the UI.

---

## 3. `GET /api/history/:username`

Return the user's most recent questions, newest first.

**Purpose.** Populates the history sidebar; clicking an entry replays the stored
answer without another AI call.

### Request

| Param | Type | Notes |
| --- | --- | --- |
| `username` | path | URL-encoded by the frontend. Matched exactly — **not** trimmed. |

No query parameters. The limit of **30** is fixed and not configurable.

### Response `200`

A **JSON array** (not an object) of up to 30 items, ordered by `created_at`
descending:

```json
[
  {
    "question": "Explain photosynthesis",
    "answer": {
      "explanation": "…",
      "topic": "Photosynthesis",
      "practice_questions": [{ "question": "…", "answer": "…" }],
      "encouragement": "…"
    },
    "topic": "Photosynthesis",
    "has_file": false,
    "filename": null,
    "created_at": "2026-09-05T00:37:34.958Z"
  }
]
```

| Field | Type | Notes |
| --- | --- | --- |
| `question` | string | As submitted. |
| `answer` | object | The stored blob, **re-parsed**. If it fails to parse, becomes `{ "explanation": "<raw string>" }` — note this form has no `topic`/`practice_questions`/`encouragement`. |
| `topic` | string | Denormalised column, defaults to `"Study Topic"`. |
| `has_file` | **boolean** | Converted from the `0`/`1` INTEGER column. |
| `filename` | string \| null | Client-supplied original filename. |
| `created_at` | string | ISO-8601. |

### Errors

| Condition | Status | Body |
| --- | --- | --- |
| Unknown username | `200` | `[]` — an empty array, **not** a 404 |
| Any username, including SQL metacharacters | `200` | `[]` (queries are parameterised) |

There is no error path: this endpoint returns `200` with an array in every
observed case.

### Frontend usage

[`app/page.jsx:525`](../../studypal-frontend/app/page.jsx#L525):

```js
const res = await fetch(`${API}/api/history/${encodeURIComponent(user)}`);
setHistory(await res.json());
```

The result is assigned directly to state and then `.map()`-ed, so **the response
must always be an array** — an object here would crash the render. Called after
login and after every successful `/api/ask`.

---

## 4. `GET /api/progress/:username`

Return aggregate study statistics.

**Purpose.** Populates the progress sidebar (a total counter and a topic
breakdown).

### Request

| Param | Type | Notes |
| --- | --- | --- |
| `username` | path | URL-encoded by the frontend. Matched exactly. |

### Response `200`

```json
{
  "total_questions": 10,
  "topics": [
    { "topic": "Photosynthesis", "count": 9 },
    { "topic": "Study Topic",    "count": 1 }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `total_questions` | number | `COUNT(*)` over all of the user's questions — not capped. |
| `topics` | array | Top **6** topics by count, descending. Always present. |

### Errors

| Condition | Status | Body |
| --- | --- | --- |
| Unknown username | `200` | `{"total_questions": 0, "topics": []}` |

No error path observed.

### Frontend usage

[`app/page.jsx:530`](../../studypal-frontend/app/page.jsx#L530):

```js
const res = await fetch(`${API}/api/progress/${encodeURIComponent(user)}`);
setProgress(await res.json());
```

Initial state is `{ total_questions: 0, topics: [] }`. The component reads
`progress.topics.length` **unguarded**, so `topics` must always be an array.

---

## 5. `GET /health`

**New in SP-V2-001.** There was no health endpoint before (`/health`,
`/api/health` and `/` all returned `404` with an HTML body).

### Response `200`

```json
{
  "status": "ok",
  "uptime_seconds": 12.4,
  "version": "1.0.0",
  "database": "ok"
}
```

`database` reports the result of a trivial `SELECT 1`. **The health check does
not contact Gemini** — a healthy API must not report itself unhealthy because a
third-party AI provider is degraded.

Returns `503` with `"status": "degraded"` only if the local database is
unreachable.

### Frontend usage

None. Added for deployment probes and local diagnostics.

---

## 6. Cross-cutting behaviour

### CORS

| | Pre-refactor | Post-refactor |
| --- | --- | --- |
| Unconfigured | `Access-Control-Allow-Origin: *` (any origin, incl. `https://evil.example`) | unchanged — `*`, plus a startup warning |
| `CORS_ORIGINS` / `FRONTEND_URL` set | n/a | strict allowlist; other origins get no CORS headers |

Defaulting to the permissive behaviour is deliberate: locking it down by default
would break the existing deployed frontend, and this iteration prioritises
backward compatibility. See §7.6.

### Unmatched routes

| | Pre-refactor | Post-refactor |
| --- | --- | --- |
| `GET /nope` | `404` **HTML** (`Cannot GET /nope`) | `404` `{"error":"Not found"}` |

### Response headers

`X-Powered-By: Express` was advertised pre-refactor and is now disabled. See
[`security-baseline.md`](./security-baseline.md) for the headers now set.

---

## 7. Deliberate deviations introduced by SP-V2-001

Everything else is unchanged. Each item here was a stack-trace leak, a crash, or
a security gap, and each was checked against actual frontend usage before being
changed.

| # | Endpoint | Before | After | Why |
| --- | --- | --- | --- | --- |
| **7.1** | `POST /api/session`, `POST /api/ask` | `500` + **HTML stack trace** for a non-string `username`, an absent body, or a `text/plain` body | `400` + the endpoint's existing `{"error":…}` message | The old response leaked absolute server paths and internal frames. The frontend already branches on `data.error`, so a JSON `400` is strictly *more* usable than an HTML `500` it could not parse. |
| **7.2** | all | `400`/`413` + **HTML stack trace** for malformed JSON / oversized body | `400 {"error":"Invalid JSON body"}`, `413 {"error":"Request body too large"}` | Same leak. Status codes preserved. |
| **7.3** | `POST /api/session` | any length username accepted | `>200` chars → `400 {"error":"Username required"}` | Unbounded identifier written to the database on an unauthenticated endpoint. 200 chars is far above any real name or student id. |
| **7.4** | `POST /api/ask` | `500 {"error":"AI request failed: <raw upstream message>"}` | `500 {"error":"AI request failed"}` | The verbatim provider error can carry quota, project and key-state detail. Status and body **shape** are identical; the full error is logged server-side. |
| **7.5** | `POST /api/ask` | unlimited upload size; **any** file type accepted (`.exe` → `200`) | `413` over the limit (default 10 MB); `415` for types outside the allowlist | Unbounded `memoryStorage()` is a memory-exhaustion vector. The allowlist matches what the frontend's `accept=` attribute already permits, plus the text formats the old code handled usefully — so no upload a user could actually make through the UI is newly rejected. |
| **7.6** | all | CORS `*` always | `*` when unconfigured (+ warning); allowlist when `CORS_ORIGINS`/`FRONTEND_URL` is set | Makes lockdown possible without breaking the current deployment or local dev. |
| **7.7** | unmatched routes | `404` HTML | `404 {"error":"Not found"}` | Consistency; no client depends on the HTML. |
| **7.8** | `GET /health` | `404` | `200` | New endpoint; nothing previously depended on the `404`. |

**Unchanged and verified identical:** every `200` body on all four original
endpoints, the `400` messages `"Username required"` and `"Username and question
required"`, `/api/session` trimming and idempotency, `/api/ask` accepting JSON as
well as multipart, `/api/ask` not requiring a registered session, the
history array shape and its 30-item limit, the progress object shape and its
6-topic limit, empty-result behaviour for unknown users, the three-tier AI JSON
repair including the exact degraded-answer literals, and the `500` status and
`{error}` shape on AI failure.
