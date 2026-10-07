# 📚 StudyPal — AI Study Companion

A student asks a question — typing it, or uploading a photo of a page, a PDF or
a text file — and gets back a short explanation, two practice questions with
model answers, and a line of encouragement. Each exchange is saved, so a student
can see what they have asked and which topics they keep coming back to.

Answers come from Google Gemini. PostgreSQL stores authoritative application data, including authenticated identities and sessions.

## Project structure

```
studypal-frontend/            ← repository root
├── studypal-backend/         ← Express 5 API + PostgreSQL  (port 4000)
└── studypal-frontend/        ← Next.js 16 UI           (port 3000)
```

> The repository root happens to be named `studypal-frontend` and contains a
> `studypal-frontend` subdirectory. Both `cd` commands below are correct as
> written.

Requires **Node.js 22+**.

## Quick start

Two terminals, from the repository root.

**Terminal 1 — backend:**

```bash
cd studypal-backend
npm install
cp .env.example .env          # then add your GEMINI_API_KEY
npm run dev
```

Get a free Gemini key at <https://aistudio.google.com/apikey>.
The API listens on <http://localhost:4000>; `curl localhost:4000/health` confirms it.

**Terminal 2 — frontend:**

```bash
cd studypal-frontend
npm install
npm run dev
```

Open <http://localhost:3000>.

The frontend needs no configuration locally — it defaults to
`http://localhost:4000`. To point it elsewhere, copy
`studypal-frontend/.env.local.example` to `.env.local` and set
`NEXT_PUBLIC_API_URL`.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness — checks the database, never calls Gemini |
| `POST` | `/api/session` | Create or resume a session |
| `POST` | `/api/ask` | Ask a question, with an optional file |
| `GET` | `/api/history/:username` | Recent questions and answers |
| `GET` | `/api/progress/:username` | Question count and top topics |

Request and response detail for every endpoint, including error cases, is in
[`studypal-backend/docs/api-contract.md`](./studypal-backend/docs/api-contract.md).

## Tests

```bash
cd studypal-backend
npm test          # 59 tests, no Gemini API key required
```

The frontend has no test suite; `npm run build` type-checks and compiles it.

## Documentation

| Document | Contents |
| --- | --- |
| [`studypal-backend/README.md`](./studypal-backend/README.md) | Backend setup, every environment variable, deployment notes |
| [`docs/current-architecture.md`](./studypal-backend/docs/current-architecture.md) | The system before and after the SP-V2-001 refactor |
| [`docs/api-contract.md`](./studypal-backend/docs/api-contract.md) | Full API contract, and the deliberate changes in §7 |
| [`docs/security-baseline.md`](./studypal-backend/docs/security-baseline.md) | Protections, findings, what was fixed, what was deferred |

## Current limitations

Worth knowing before deploying this anywhere real:

- **Authentication is required.** PostgreSQL-backed sessions enforce account ownership.
  Existing accounts require operator-provisioned credentials; see the
  [authentication architecture](./studypal-backend/docs/authentication-architecture.md).
- **AI operations have per-user request rate limits.** Provider-spend and billing quotas remain a deployment concern.
- **Uploaded files use local storage.** PostgreSQL stores identities and sessions;
  multiple backend instances need shared document storage.
- **Questions and uploaded documents are sent to Google.** Students are not told
  this anywhere in the UI.

These are recorded with context and a recommended order in
[`docs/security-baseline.md`](./studypal-backend/docs/security-baseline.md).
