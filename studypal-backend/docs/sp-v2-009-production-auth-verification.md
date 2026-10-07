# SP-V2-009 — Production authentication migration and verification

## Verdict and environment distinction

**NOT READY for a complete production verification claim.** The configured real **development** database was backed up, migration 006 was applied safely, authentication and owner-scoped application flows were exercised against that database, and final integrity checks passed. A complete real Gemini-backed journey succeeded for A. B's additional exam generation failed twice because Gemini returned 503 UNAVAILABLE/high demand, leaving symmetric exam verification incomplete. No public staging/production origins or deployment were identified, so public HTTPS, persistent production environment configuration and deployed behavior remain unverified. These are explicit incomplete gates, not a fabricated production success.

The configured target was confidently identified as local development: `studypal-postgres`, image `pgvector/pgvector:pg16`, bound to loopback port 5434; database `studypal`, database role `studypal`; PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2). Configuration selected development and local compose agreed. Application branch is `feature/studypal-v2-baseline`, HEAD `4dd92ad`. No Git history operation or deployment occurred. Existing SP-V2-008 changes remain uncommitted.

The database initially contained **zero users and zero learning records**. Thus no real legacy account existed to provision, and no populated legacy account could be verified on this target. The populated legacy preservation tests in SP-V2-008 remain isolated-test evidence, not evidence of populated developer/production migration. Existing migration records 001–005 matched the disk checksums, and 006 was the only pending migration.

## Backup and recovery readiness

- Backup timestamp: `2026-10-06T10:08:43.822Z`.
- Database identifier: local development `studypal`, loopback 5434.
- Format: PostgreSQL custom-format archive, pg_dump 16.15.
- Location: `/home/princewill/Desktop/studypal-frontend/studypal-backend/data/backups/sp-v2-009/studypal-before-auth-2026-10-06T10-08-43.822Z.dump`.
- Size: **54,543 bytes**.
- SHA-256: `a3e79b5b1bdaeceb953cd95ebf0e5924af1d99831ddb51680146d2863050c884`.
- Verification: pg_dump exited 0; pg_restore TOC contained every expected application table; pg_restore decoded the complete archive into `/dev/null` with exit 0. No database restore was performed.
- Permissions: backup directory 0700, archive/verification manifest 0600. Backups are inside the existing ignored `studypal-backend/data/` directory and are not tracked.

The archive includes the complete pre-migration application schema/data, ownership constraints, migrations and pgvector definitions. Authentication tables did not exist at that time. This is a verified logical archive, **not a rehearsed database restore or a backup of material files**; the target had no materials/files before migration. Preserve it outside the development workstation under the environment's backup policy before a real deployment.

If recovery becomes necessary, stop rollout, preserve current evidence and first take a fresh backup of current data. Have the database operator restore the verified pre-migration archive into an explicitly approved separate recovery database with compatible PostgreSQL/pgvector, verify schema/counts/ownership, then plan cutover. Do not run a destructive in-place restore or invent a down migration. The pre-migration backup predates the verification accounts/resources and would not retain them. No successful migration was rolled back.

## Migration review and application

Migration 006 was reviewed line by line and matched SP-V2-008's tested checksum `987801f4a697c88d`. It only adds nullable `users.password_hash`, `auth_sessions`, `auth_rate_limits`, indices, session constraints and a table comment. It does not delete, truncate, drop, rename or reassign user-owned data. Session ownership cascades from users; token digests are primary keys; expiry follows creation. Existing user uniqueness/IDs and composite resource ownership FKs remain intact.

The existing `npm run migrate` runner applied only `006_authentication.sql`, skipped 001–005, and recorded the DDL and migration row in one transaction. Recorded timestamp: `2026-10-06T10:11:04.393Z`. Post-migration inventory showed all six migrations applied, unchanged checksums and all 15 FKs validated. The runner is forward-only and checksum-checked; migration 006 was not edited or manually replayed.

## Counts and ownership integrity

| Table | Before migration | Immediately after migration | Final verification inventory |
| --- | ---: | ---: | ---: |
| users | 0 | 0 | 3 |
| materials | 0 | 0 | 2 |
| material_chunks | 0 | 0 | 2 |
| study_plans | 0 | 0 | 2 |
| study_plan_tasks | 0 | 0 | 16 |
| exams | 0 | 0 | 1 |
| exam_questions | 0 | 0 | 2 |
| exam_attempts | 0 | 0 | 1 |
| attempt_answers | 0 | 0 | 2 |
| questions | 0 | 0 | 0 |
| auth_sessions | 0 | 0 | 8 |
| auth_rate_limits | 0 | 0 | 6 |
| schema_migrations | 5 | 6 | 6 |

All pre-existing learning counts remained unchanged immediately after migration. Final increases are dedicated verification registrations and genuine API-created resources; no account/resource cleanup was performed. Normal session revocation, session expiry and limiter expiry cleanup operated as designed; authentication counts are transient.

Final inventory timestamp: `2026-10-06T10:46:14.044Z`. All 15 FKs validated; **0 orphaned FK relationships**, **0 answer/exam ownership mismatches**, **0 source-chunk/material mismatches**. Materials/plans belong to A and B; A has the generated exam, submitted attempt and two persisted answers. The third account was used only for browser registration. There are 3 credentialed users, 0 locked users, and 0 invalid password-hash formats. No original learning record was deleted/overwritten; there were none before verification.

Added [scripts/verify-auth-environment.mjs](../scripts/verify-auth-environment.mjs), which runs a repeatable-read **read-only** transaction, prints only safe target metadata/counts/owner IDs/migration states, checks all catalog FKs (including composite keys), and checks answer/attempt/exam and chunk/material semantics. It never prints connection strings, profiles, hashes or passwords. Reproduce against the configured target with `node scripts/verify-auth-environment.mjs`. It does not invoke the migration-status function that can create a tracking table.

## Account handling and authentication

No legacy provisioning was necessary or performed because the initial user count was zero. Three dedicated synthetic verification accounts were registered through the actual API/browser; no known/default password was used. Random unique credentials were generated privately for these test identities, never put into source, argv or report output. Current verification credentials are in the ignored, mode-0600 `studypal-backend/data/verification/sp-v2-009/test-credentials.json`; this is private test-account material, not a public provisioning mechanism. No real user password was invented or reset. Account/resource data was retained because no explicit deletion policy was supplied.

Actual development DB/API checks passed for registration, duplicate registration 409, correct login, generic wrong-password 401, `/me` identity, rotation, logout immediate 401, password changes/all-session revocation and new-password login. Expiration was tested by moving expiry into the past **only for dedicated verification sessions**; no 12-hour wait or real user's session alteration was needed. Session digests in PostgreSQL were checked against the cookie-token digest and differed from raw tokens. Password hash format counts and real logins confirmed hashed credential storage. No sensitive API fields were returned.

## Actual product journey and AI boundary

A completed this actual flow against the configured database and live Gemini transport:

registration/login → upload TXT material → extraction/chunking/pgvector indexing → grounded material chat → study-plan generation → task completion → exam generation → start attempt → submit answers → deterministic score **100%** → aggregate analytics/history/progress → logout/password/session checks.

Both A and B uploaded and indexed materials. A and B now have real generated plans with 8 tasks each. A has a 2-question exam and its completed attempt. The initial A journey made 6 real provider requests (including embedding/query embedding); later B verification brought the observed total to **10**, including **3 genuine provider 503 responses**. B plan creation succeeded on retry; B exam creation returned safe 500 twice and produced no partial exam or attempt. No fake provider, database, identity or success response was used in real-database checks. Existing isolated regression tests still use deterministic Gemini fixtures and are labeled separately.

Provider observation wrapped fetch only to count calls to the Gemini hostname, without logging URLs/headers/bodies, changing responses or substituting transport. The final 19-probe ownership matrix left all learning-table fingerprints unchanged and added **zero provider calls**. Cross-owned chat, plan material selection and exam material selection were rejected before Gemini.

## Authorization and forged identity

Real-database tests denied symmetric A/B material reads, status, deletion, unsupported material PATCH, plan reads, nested task mutations and plan analytics. Mixed-parent task IDs were rejected. B could not read A's exam/attempt, create an A-exam attempt or submit A's attempt. Denied mutations left learning snapshots unchanged. PATCH material is not an implemented mutation route and returns 404; that probe is not a claim of an existing edit API.

Final matrix: **19 probes passed**, covering symmetric materials/plans/tasks, A's exam/attempt, and unauthorized AI selections. B's own exam could not be created due provider 503, so A-against-B-exam and two-existent-exam mixed-parent attempt verification remain incomplete on this real target. The complete isolated regression suite verifies those broader cases but does not replace this missing real-target evidence.

Forged query usernames across materials/plans/attempts/all analytics, legacy history/progress path names, session body usernames and identity-like headers could not change the authenticated user. Conflicting assertions returned 403; `/me` retained B's actual ID.

## Local HTTPS, cookies, CORS and CSRF

Real-database verification ran the actual backend in `NODE_ENV=production` through a temporary same-origin local HTTPS reverse proxy, with exact HTTPS origins set for that process. It did not change `.env` or public hosting configuration. A short-lived localhost certificate was explicitly validated by the Node client; fresh headless Chrome pinned its public key. Private key/certificate artifacts are ignored and restricted. This proves local encrypted transport and production cookie behavior; it **does not prove public CA trust, real deployment TLS termination or public origin correctness**. Local verification processes were stopped afterward.

Real HTTPS registration set `__Host-studypal_session`, Secure, HttpOnly, SameSite=Strict, host-only, Path=/. Chrome reported a secure context, could authenticate/reload through the cookie, and could not read it via `document.cookie`. Cookie scope follows host-only semantics; public-domain deployment behavior remains unverified.

Credentialed CORS accepted the configured exact local HTTPS frontend, emitted no wildcard, allowed its preflight, omitted foreign-origin allow headers, and supported documented API requests without Origin. Foreign mutations and missing mutation headers were rejected. All **8 final POST/PATCH/PUT/DELETE CSRF probes returned 403**. CSRF was never disabled.

An initial DELETE probe was incorrectly framed by the temporary Node verification client and received HTTP parser rejection before application routing; adding explicit content length corrected the harness. The backend had rejected the preceding seven probes correctly. Two initial browser expectations were also corrected: the dashboard has no material list (the exam selector does), and checks must wait for enabled action buttons. Reruns passed. These were verification harness fixes, not application security relaxations.

## Browser verification

Fresh headless Chrome exercised the real production-built frontend against the real development database over pinned localhost HTTPS. Verified registration and session establishment, HttpOnly invisibility, logout, correct/incorrect login, reload restoration, authenticated dashboard requests, real-material selection on the exam page, analytics navigation, current-password rejection, successful password change, new-password login and expired-session return to sign-in. Expiry produced bounded requests with no retry loop. No cookie/password values were captured in report output or screenshots. Browser accounts were actual API/database accounts; no auth fixture bypass was used.

Browser coverage proves auth/navigation/API behavior. The complete AI study/exam journey was verified through actual HTTPS APIs; it was not claimed as an entirely clicked visual journey. No public deployed browser session was available.

## Rate limits and error/observability checks

Documented default PostgreSQL counters were exercised on the real database. Normal auth/AI operations were allowed; excessive login/registration requests and upload/chat/plan/exam/ask requests reached typed 429 with `Retry-After`. Expensive quota probes used invalid bodies after genuine successful operations to avoid unnecessary provider work. Per-user database digest counters exceeded their configured threshold, while an unrelated B request still reached normal validation. Socket-IP auth sharing was intentional. Later verification used another genuine loopback source address after the tested IP bucket was exhausted; no forwarded-header trust, counter reset, lowered limit or auth bypass was introduced.

401/403/404/409/429 were checked directly; real upstream failures exercised safe 500 responses. Runtime logs and response field checks exposed no passwords, cookies, raw/session/password hashes, authorization values, API keys or database passwords. Provider failures were logged internally but API clients received only the safe error convention. The health endpoint returned 200 with safe status/version/database availability, not connection details. No raw secret values were printed.

## Regression, install, build and security checks

```text
Suites: 202
Tests: 1049
Passed: 1049
Failed: 0
Skipped: 0
Cancelled: 0
```

This new complete `npm test` run used **isolated test databases**, not the real `studypal` database. Duration: 90,735.30 ms. No tests were excluded or removed. Adding the read-only operational script changed no application behavior; its SQL was verified directly against the real target.

- Backend syntax: **92 source/script/entrypoint files passed**. Actual production-mode startup/health and migration verification passed on the development target.
- Frontend: fresh SP-V2-009 clean-install production build passed for `/`, `/exam`, `/analytics`, `/_not-found`. Real browser checks used a production build configured for the local HTTPS origin.
- Fresh backend/frontend `npm ci --ignore-scripts --no-audit --prefer-offline` succeeded in separate temporary directories, adding 136/27 packages. Lifecycle scripts were disabled as requested. Clean runtime dependency imports were checked.
- npm audit: backend/frontend each **0 total vulnerabilities**, including moderate/high/critical.
- Package manifests and lockfiles are unchanged. Backend lock SHA-256 `d3f71bad9a50f4874cb1fee0e3ed05d7b3d7836c27b5cfd8a17420f212cd26cc`; frontend `033e79f12177d10bf32e8c1f1656b1bba2e44b82bb759ea96751b03332fb624e`.
- Final tracked/new nonignored source scan: **174 files**, **0 recognized secret-pattern matches**, **0 tracked private environment files**; credential candidates reviewed as placeholders/intentional isolated-test fixtures. Ignored private backups/test credentials/TLS keys are not source artifacts and must remain private.
- `git diff --check`: passed.

## Remaining gates and continuation

1. Gemini availability prevented B's additional exam and symmetric two-existent-exam real-target checks. Retry only that incomplete creation/verification when the configured provider recovers; reuse the existing dedicated accounts/plans/materials. Do not repeatedly generate duplicate resources or substitute fake success.
2. No public frontend/API origins or production deployment were supplied. Verify actual public HTTPS/CA chain, exact CORS origins, cookie scope and production browser behavior before claiming production verification. The configured persistent environment is development with loopback CORS and HTTP defaults; temporary production-mode checks do not deploy it.
3. No legacy accounts existed. Provision any accounts found in a different actual target only after backup and trusted owner verification; never copy these test credentials or pretend the populated-test migration was that target's migration.
4. Backup decoding succeeded, but a full restore rehearsal and off-machine retention were not performed. Recovery must be operator-approved and rehearsed before destructive restore/cutover.

No production incident, data loss or broken ownership was observed. The migration is retained and the working tree remains available for review. This phase has **not** been marked fully complete and no next major feature was started.
