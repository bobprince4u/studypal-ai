# StudyPal authentication architecture — SP-V2-008

## Decision and inspected baseline

StudyPal uses PostgreSQL, direct parameterized SQL repositories, Express 5 and a Next.js browser frontend. Inspection found that `users.id` was already an immutable BIGINT primary key, usernames were unique, timestamps already existed, and materials, chunks, questions, study plans/tasks, exams/questions/attempts/answers already carried stable ownership or an enforced parent ownership chain. Existing migrations 001–005 deliberately enforce composite ownership foreign keys. The missing boundary was proof of identity: clients supplied usernames and services resolved or created users from them. The frontend used those names as its session. PostgreSQL integration tests already used isolated databases, and errors already followed `{error: "message"}`.

We chose **PostgreSQL-backed opaque server sessions in HttpOnly cookies**. Short-lived access tokens with rotating refresh tokens would require two credential lifecycles and more browser handling without improving this application's needs. Sessions reuse the existing database, support immediate revocation, and require no Redis, JWT signing key, ORM, new infrastructure or dependency. Every protected request reads an unexpired session and establishes frozen `req.user = {id, username, created_at}`. `req.auth` is a compatibility alias, not a second identity source.

The implementation sequence was: inspect identity/schema/config/test isolation; add credentials and sessions without changing existing ownership; establish the shared API boundary; move controllers/services to immutable IDs; migrate the browser client; add raw-session cross-user, migration and abuse tests; run regression, clean-install, audit, build, browser and secret checks. No developer/production database was migrated during implementation.

## Passwords and accounts

Registration accepts unique usernames of 1–100 ASCII letters, digits, dots, underscores or hyphens and passwords of 15–128 characters. Passwords are not trimmed and have no arbitrary composition rules. There is no email field or email authentication in this phase. Legacy nonblank usernames up to the configured existing 200-character limit, including whitespace-distinct names, remain valid login profiles. Ownership uses the user ID and does not canonicalize or merge these accounts.

Passwords use Node's asynchronous **scrypt**, with N=131072, r=8, p=1, random 16-byte salts, 64-byte keys and constant-time comparison. Argon2id is the preferred general choice, but adding a native dependency and platform/install requirements would expand this repository's dependency policy. Built-in memory-hard scrypt meets the [OWASP fallback guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) without a dependency change; bcrypt's password truncation and additional package were unnecessary. SHA-256 is used only for high-entropy session/limiter keys, never as password hashing.

At most two password derivations run concurrently per backend process; saturation returns 503. Each needs approximately 128 MiB of working memory, with a 160 MiB allocation bound. Capacity planning must account for process count. Unknown users, locked users and wrong passwords execute derivation and receive the same 401 message. Registration conflicts return a generic 409 but username availability remains observable. Responses never include hashes, passwords or session tokens in JSON. Account disablement is represented by a NULL password hash; there is no new status/role system.

## Session lifecycle and revocation

Registration and login create random 256-bit opaque tokens. Only the SHA-256 token digest is stored in `auth_sessions`; the original is delivered only in the cookie. Sessions expire absolutely after 12 hours, without a refresh endpoint or sliding extension. Login rotates the supplied cookie and revokes its previous token. Session issuance locks the user row and verifies that the password hash still matches the credentials verified by the service, preventing a concurrent password reset from issuing a session from stale credentials.

Logout deletes the current session and clears the cookie. Password change requires the current password, updates by authenticated user ID with an old-hash concurrency condition, revokes **all** account sessions transactionally, and clears the browser cookie. Operator provisioning/reset also revokes all sessions. Expired records are rejected on every request and removed during issuance. Missing, invalid, malformed or duplicate session cookies receive 401. Authorization headers are not an alternate credential mechanism. Safe `/me` responses contain only `id`, `username` and `created_at`.

## Backend boundary and authorization

`/health` is public. `/api/auth/register`, `/login` and `/logout` are the minimum unauthenticated auth operations; `/me` and `/password` authenticate explicitly. A shared `requireAuthentication` middleware then protects **every feature router** mounted under `/api`, including future feature mounts placed after that boundary. State-changing API requests first pass CSRF protection. Authentication and expensive-operation limits precede multipart buffering and provider/controller work.

Feature controllers pass `req.user.id` into services. Services validate an immutable user ID and call repositories scoped by `user_id`; they do not resolve usernames, create users or trust client IDs for ownership. Materials, material status/deletion, chat/RAG, plans, tasks, regeneration, exams, attempts, history, progress and every analytics view use the authenticated owner. Material selection for chat/plan/exam generation checks ownership before Gemini sees any content. A child ID must match its requested parent and owner. Cross-owner resources return the same 404 as missing resources; invalid generation material selections preserve the existing generic 400 convention. Learning queries retain their parameterization and existing composite foreign keys.

Chunks are accessible only through owner-scoped processing/retrieval. There is no public static uploads mount, chunks API or document download endpoint. Guessing storage/chunk paths returns 404. Files use existing generated storage keys and guarded storage paths, not client filenames as filesystem paths. Material PDF/TXT MIME/extension/content validation, PDF magic-byte checks, upload limits and safe extraction remain intact. The older `/ask` attachment endpoint retains its existing extension/size controls; it has not gained a claim of universal MIME/magic-byte validation or antivirus scanning.

## API and client migration

| Method | Endpoint | Input / result |
| --- | --- | --- |
| POST | `/api/auth/register` | `{username,password}` → 201 safe account view and cookie |
| POST | `/api/auth/login` | `{username,password}` → 200 safe account view and rotated cookie |
| GET | `/api/auth/me` | Cookie → 200 safe account view, otherwise 401 |
| POST | `/api/auth/logout` | 204; revoke current session and clear cookie |
| POST | `/api/auth/password` | Cookie + `{currentPassword,newPassword}` → 204; revoke all sessions |

Every mutation needs `X-StudyPal-Request: 1`. Existing feature response DTOs remain stable. Remove usernames from query/body/FormData ownership inputs and send the session cookie. `/api/history` and `/api/progress` are the identity-free forms. The old username path forms and optional username inputs are deprecated **assertions only**: a mismatched name receives 403, a malformed name 400, and a matching name cannot override the authenticated ID. `POST /api/session` returns the authenticated profile and never creates or authenticates a user. Anonymous clients now receive 401; there is no anonymous compatibility fallback. Remove these deprecated forms after supported clients have adopted auth and identity-free requests; do not reopen anonymous access during rollout.

Frontend `AuthProvider` restores `/auth/me`, gates all application views, provides registration/login/logout/password change, and returns expired sessions to sign-in. The shared `apiFetch` includes credentials and mutation headers automatically. Protected 401 responses trigger expiry handling; login/password credential errors and 403 responses retain their meaningful error bodies. Feature views surface 403/resource errors. Password changes sign out everywhere. No credential token is put in localStorage, sessionStorage or JavaScript state; the HttpOnly cookie is authoritative. The frontend gate is usability only: the backend enforces access even for raw HTTP clients.

## Browser, CORS and CSRF

Production uses `__Host-studypal_session`, **Secure, HttpOnly, SameSite=Strict, Path=/**, with no Domain attribute. HTTP development uses `studypal_session`. Protected and auth responses are `Cache-Control: no-store`. Existing security headers remain enabled. Loggers record method/path/status/duration without query strings, bodies, passwords, cookies, authorization headers or tokens.

Production startup requires explicit exact HTTPS origins in `FRONTEND_URL` / `CORS_ORIGINS`. Origins with paths, credentials, wildcards or non-HTTPS schemes are rejected. Credentialed CORS reflects an allowed exact origin, never `*`, and permits `Content-Type` and `X-StudyPal-Request`. Development additionally allows HTTP localhost/127.0.0.1 origins. CORS itself is not authorization.

POST/PATCH/PUT/DELETE requests must carry the custom header with value `1`; supplied browser Origin must also be allowed. A foreign page cannot supply that header without an allowed preflight. SameSite=Strict and host-only cookies add defense in depth, including against same-site foreign origins through the explicit Origin check. API clients without Origin are allowed only with the custom header. This is the [OWASP custom-header CSRF pattern](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), rather than a redundant synchronizer-token lifecycle. GET/HEAD/OPTIONS do not mutate application data. XSS within an allowed frontend origin can make authenticated requests; HttpOnly mitigates token theft, not that threat.

Frontend and API must be **same-site**, preferably same-origin through a reverse proxy, for Strict cookies. Separate unrelated hosting domains are not supported by this cookie policy. Set `NEXT_PUBLIC_API_URL` at build time and terminate HTTPS at a trusted proxy. Production HTTPS cookie flags and origin rejection were tested over isolated HTTP integration transport; real deployed TLS termination was not exercised.

## Abuse protection

PostgreSQL atomic counters are shared across backend instances. Expired counters are cleaned up and key material is hashed. The common default window is 900 seconds, configurable with `STUDYPAL_RATE_WINDOW_SECONDS`.

| Operation | Default attempts/window | Configuration |
| --- | ---: | --- |
| Registration | 10 per socket IP and username | `STUDYPAL_RATE_REGISTER_LIMIT` |
| Login | 20 per socket IP and username | `STUDYPAL_RATE_LOGIN_LIMIT` |
| Password change | 5 per socket IP and authenticated account | `STUDYPAL_RATE_PASSWORD_LIMIT` |
| Document upload / processing | 20 per authenticated user ID | `STUDYPAL_RATE_UPLOAD_LIMIT` |
| Material chat | 60 per authenticated user ID | `STUDYPAL_RATE_CHAT_LIMIT` |
| Study-plan generation and regeneration, shared | 20 per authenticated user ID | `STUDYPAL_RATE_STUDY_PLAN_LIMIT` |
| Exam generation | 20 per authenticated user ID | `STUDYPAL_RATE_EXAM_LIMIT` |
| Ask / attachment generation | 60 per authenticated user ID | `STUDYPAL_RATE_ASK_LIMIT` |

429 responses include `{error,code:"RATE_LIMITED"}` and `Retry-After` equal to the configured window (a conservative retry bound). Counters include failed and successful requests, and may charge a request that later fails validation. These are request-frequency limits, not token-cost or billing quotas. No untrusted forwarded-IP header is accepted. A reverse proxy makes its socket IP the shared authentication IP bucket; size defaults and add appropriate edge limits for the deployment. Limiter/database failure fails closed. JSON and multipart bounds remain in force. Anonymous requests cannot reach protected AI work, and ownership is checked before provider calls.

## Database migration and rollout

`006_authentication.sql` adds nullable `users.password_hash`, `auth_sessions` (user FK with cascade, token/expiry constraints and indices), and `auth_rate_limits` (expiry index). Existing username uniqueness, timestamps, immutable IDs, ownership indices, non-null owner columns and composite/cascading FKs remain intact. No resources need a username-to-ID backfill because the inspected baseline already stored their user IDs. No accounts, materials, plans, exams, attempts or analytics evidence are deleted or reassigned.

Back up PostgreSQL and run the existing `npm run migrate` before deploying. The SQL follows the existing forward-only ledger: the runner applies it once and repeated migration runs are no-ops. It is not a standalone script to execute repeatedly outside that ledger. Populated 001–005 databases, whitespace-distinct users, complete learning graphs, preserved snapshots/FK definitions, fresh migrations, no orphans and repeated runner execution were verified in isolated PostgreSQL tests.

Existing NULL-hash accounts remain locked. Public registration cannot claim one. An operator must verify the owner's identity through a trusted process before using `node scripts/provision-auth.mjs` with a private stdin JSON object containing `username` and `password`. Never place secrets in command-line arguments, shell history, source or logs. This script hashes credentials, updates the existing ID and revokes sessions transactionally. There are no seeded/default credentials. Application auth secrets are generated randomly, not embedded in environment files; database/provider credentials remain environment configuration. Restrict access to PostgreSQL, backups and the provisioning workflow; require database TLS over untrusted networks.

## Known limitations and deferred work

This phase does not add email verification/delivery, self-service password recovery, MFA, external federation, roles, account deletion or compromised-password screening. Trusted operator reset is available. Registration can reveal username availability. Twelve-hour absolute expiry has no idle timeout. PostgreSQL is contacted per authenticated request; DB unavailability denies access. Counters and scrypt require deployment capacity planning, and signup remains publicly available with targeted limits rather than an invitation system. Distributed edge protections and spend quotas are deployment/product work, not Redis infrastructure added here. Upload antivirus/content-disarm is not provided. Future resource handlers must keep immutable owner filters and nested-parent checks; mounting behind authentication alone is insufficient.

The final verification counts and practical test limits are in [sp-v2-008-final-report.md](sp-v2-008-final-report.md). Session choices also follow [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
