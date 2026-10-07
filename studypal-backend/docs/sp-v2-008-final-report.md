# SP-V2-008 final report

## 1. Scope and result

Implemented real authentication and server-enforced authorization on `feature/studypal-v2-baseline`. HEAD remains `4dd92ad`. All changes are uncommitted and available for review; no commit, push, merge, rebase, reset, history rewrite or deployment was performed.

Every feature API authenticates a PostgreSQL-backed session and derives immutable identity as `req.user.id`. Controllers and services use that ID for ownership. Changing a query/body/path username cannot select another account's materials, chunks/RAG context, chats, plans/tasks, exams/attempts, analytics, history or uploaded documents. Raw-session A/B tests verify cross-owner and mixed-parent IDOR rejection, plus unchanged learning-data snapshots after denied mutations.

The work preserves PostgreSQL, pgvector, Gemini prompts, deterministic grading, analytics formulas, document processing and existing architecture/security tests. No application dependencies or lockfiles changed. Existing feature tests now explicitly opt into real persisted authenticated fixtures in isolated databases; application code contains no test/development bypass.

## 2. Authentication architecture

Chosen model: opaque server-side sessions in HttpOnly cookies, persisted in the existing PostgreSQL database. This avoids an unnecessary access/refresh-token lifecycle and supports immediate revocation without Redis or a signing secret. Random 256-bit tokens are stored only as SHA-256 digests, expire absolutely after 12 hours, rotate on login, and are revoked on logout. Password changes and operator reset revoke every account session. Session issuance locks the user and checks the verified hash against concurrent password changes.

Passwords use dependency-free asynchronous memory-hard scrypt (N=131072, r=8, p=1), unique random salts and constant-time comparison. Argon2id was evaluated; its new native dependency/platform requirements were unnecessary for this stack because built-in scrypt provides the documented OWASP fallback. New passwords require 15–128 characters, with no composition rules or trimming. Concurrency is bounded to two derivations per process. API account views expose only `id`, `username`, `created_at`.

The full decision and operational contract are in [authentication-architecture.md](authentication-architecture.md).

## 3. Database changes

Migration `006_authentication.sql` adds nullable `users.password_hash`, `auth_sessions` and `auth_rate_limits`, with session ownership/cascade/expiry constraints and owner/expiry indices. Existing users already had immutable IDs, unique usernames and timestamps; resource ownership was already stored as user IDs. Therefore no ownership backfill or table redesign was required. Existing composite owner/parent foreign keys, non-null ownership, indices and deletion behavior remain valid. No existing learning records are deleted or reassigned.

## 4. API changes

Added `POST /api/auth/register`, `/login`, `/logout`, `/password`, and `GET /api/auth/me`. There is no refresh endpoint because the selected model does not require refresh tokens. Added identity-free `GET /api/history` and `/api/progress`. All feature endpoints require authentication, and all mutations require `X-StudyPal-Request: 1`.

`POST /api/session` is a deprecated authenticated profile view; it no longer creates users or logs in by name. Legacy username parameters/path forms are optional compatibility assertions only: mismatching account names return 403, malformed claims 400. Resource owner mismatches generally return non-disclosing 404; generation with unavailable selected plan materials retains its generic 400. No insecure anonymous compatibility path remains. Errors retain `{error}`; rate-limit errors additionally carry `code: "RATE_LIMITED"` and `Retry-After`.

## 5. Authorization

The shared API gate authenticates before feature routing, upload buffering, controllers and expensive work. Feature services validate immutable user IDs and never implicitly upsert or resolve ownership through usernames. Repositories retain parameterized owner filters and composite FK constraints. Nested tasks/attempts must match the requested parent and owner. Chat and generation check selected material ownership before retrieval/provider calls. Existing chunks and uploads are not exposed through a public static/download endpoint. Architecture tests enforce the boundary for future feature router mounts and current service/controller conventions.

## 6. Frontend changes

The common auth provider implements registration/login, restoration through `/me`, logout, current-password-verified password change and expiry return to sign-in. Application views render only after restoration/authentication. The shared API client includes cookies and mutation headers automatically, removes username ownership inputs, and preserves 403/credential errors. Protected 401 responses trigger session expiry. No session secrets are stored in localStorage, sessionStorage or JavaScript state. Successful registration resets the form mode so logout presents login.

A fresh headless Chrome profile exercised 11 actual browser flows against a production-built frontend and isolated PostgreSQL-backed API: protected home, registration, authenticated home calls, exam navigation, analytics, reload restoration, logout plus reload, wrong login, successful login, password change and expired session. All 11 passed.

## 7. Security controls

- Production cookie: `__Host-studypal_session`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; development uses the HTTP-compatible cookie name.
- Production startup rejects absent/invalid exact HTTPS origins. Credentialed CORS never emits wildcard origins. Development allows configured origins and HTTP loopback only.
- Custom-header CSRF protection applies to POST/PATCH/PUT/DELETE, including login/logout, and validates supplied Origin. Foreign preflights cannot authorize the required header; Strict cookies add protection.
- PostgreSQL atomic rate limits distinguish registration, login and password operations from authenticated upload/chat/plan/exam/ask operations. Plan generation/regeneration share a quota. Limits run before multipart/provider work, persist across backend instances, reject spoofed forwarded-IP/identity attempts, and return typed 429.
- Existing upload size, material MIME/extension/magic-byte/content checks, storage-key safeguards and request-size bounds remain intact. The older ask attachment endpoint retains its existing size/extension policy.
- Anonymous requests and cross-owned material selections cannot trigger protected AI processing. Provider keys remain server-side. Error/log handling does not emit authentication credentials; request logs omit query strings. Auth/protected responses are no-store.

## 8. Existing data migration and rollout

Populated pre-auth migrations 001–005 were tested with three legacy users, including whitespace-distinct names, and a complete graph of materials/chunks, plans/tasks, exams/questions/attempts/answers and historical questions. Applying 006 preserved every learning snapshot and FK definition, left legacy hashes NULL, created no sessions, introduced no orphaned resources, and rerunning the migration ledger was a no-op. Fresh databases also migrated successfully in the complete suite.

Existing accounts remain locked until an operator verifies their owner and provisions credentials using `scripts/provision-auth.mjs` with private stdin JSON. Registration cannot claim a legacy username. Provisioning keeps the existing ID and revokes sessions. No developer or production database was migrated/provisioned during implementation. Before rollout, back up PostgreSQL, apply the existing migration runner, configure HTTPS/same-site origins and memory/edge capacity, then provision verified owners. Do not reopen username-only APIs.

## 9. Exact test results

Final complete `npm test` run: Node's PostgreSQL-backed regression suite, including the frontend API-client unit tests. All suites ran; Gemini responses are deterministic test doubles. PostgreSQL, HTTP, sessions, hashing, migrations and owner checks are real.

```text
Test suites: 202
Tests: 1049
Passed: 1049
Failed: 0
Skipped: 0
Cancelled: 0

Backend: PASS — complete 1049-test runner
Frontend: PASS — 5 API-client unit tests included above; 11 separate browser checks
Authentication: PASS — 19 authentication API/password tests
Authorization: PASS — 9 raw-session ownership/IDOR tests, plus existing feature suites
Cross-user: PASS — the same 9 raw-session tests (overlaps Authorization)
Migration: PASS — 3 populated-legacy migration tests, plus existing migration/schema suites
Architecture: PASS — 111 tests across 25 suites, independently rerun
```

The new auth directory has 63 automated tests in total: 19 auth/password, 9 cross-user, 3 populated migration, 11 abuse-limit, 10 browser-origin/CSRF, 6 architecture and 5 frontend-client tests. Category counts overlap the complete run and must not be added to 1049. The 11 browser checks are separate from Node's count. Existing tests were retained and adjusted only for the intentional authenticated contract or immutable service IDs.

Final complete suite duration was 97,168.84 ms. Architecture rerun: 111 passed, 0 failed/skipped/cancelled. Backend syntax: 91 files passed `node --check`. Production-mode integration startup, health, cookie flags and CORS checks passed in the complete suite. The backend has no separate build script.

## 10. Security and build verification

```text
npm audit:
Backend: PASS — 0 info/low/moderate/high/critical; 0 total
Frontend: PASS — 0 info/low/moderate/high/critical; 0 total

Build:
Backend: PASS — 91 syntax checks and production startup/integration checks
Frontend: PASS — clean-install Next.js production build; /, /exam, /analytics, /_not-found

Secret scan:
Result: PASS — 172 tracked/new nonignored files; 0 recognized secret-pattern matches;
        0 tracked private .env files. Credential-assignment/connection-string candidates
        reviewed as documented placeholders or intentional fake test credentials.

git diff --check:
Result: PASS
```

Fresh temporary backend/frontend installs ran `npm ci --ignore-scripts --no-audit --prefer-offline`, adding 136 and 27 packages respectively. Lifecycle scripts were intentionally disabled; the clean frontend production build still passed, and clean backend runtime dependency imports succeeded. The complete regression suite ran in the working checkout against the same unchanged lockfiles. No dependencies were added or upgraded.

Verified lock SHA-256 values:

- Backend: `d3f71bad9a50f4874cb1fee0e3ed05d7b3d7836c27b5cfd8a17420f212cd26cc`
- Frontend: `033e79f12177d10bf32e8c1f1656b1bba2e44b82bb759ea96751b03332fb624e`

Secret scanning was pattern-based and manually reviewed for credential assignments/connection strings; it is not a claim of exhaustive forensic detection. No real secret values were printed. Ignored local environment secrets were not included in tracked-source scanning or exposed. Audits are dependency snapshots at verification time.

## 11. Known limitations

Strict cookies require same-site frontend/API deployment, preferably one origin. Real deployed HTTPS/TLS termination was not tested. Shared proxy socket addresses share auth IP limits because forwarded headers are deliberately untrusted. PostgreSQL is a per-request authentication dependency, and scrypt/counters need adequate capacity. Local material storage needs shared storage for multiple instances; auth counters/sessions already share PostgreSQL. Limits bound frequency rather than provider spend. The 12-hour lifetime has no idle extension/timeout; registration exposes username availability. Public registration has targeted limits without invitation controls. Browser verification used a fresh isolated profile, not a deployed production environment. External Gemini was faked, so provider availability/billing were not tested. This is not an external penetration test.

## 12. Deferred work

Self-service email recovery/verification, MFA, federation, privileged roles, compromised-password screening, account deletion, upload malware scanning/content disarm and provider-spend quotas are not implemented. Trusted operator credential provisioning/reset is available. These items do not reopen the removed username impersonation path.

## Final verdict

**PASS** — authentication and immutable server-enforced ownership are implemented, all 1049 automated tests and 11 browser checks pass, populated/fresh migrations preserve ownership, production build/syntax and audits pass, and secret/whitespace checks pass. Deployment still requires the documented migration, verified legacy provisioning and HTTPS configuration. Changes remain available in the working tree for review.
