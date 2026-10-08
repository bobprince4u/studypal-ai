# SP-V2-009 — Remaining verification gate closure

## Current verdict

**NOT READY.** Gates 1–4 and 7 are complete against the real configured development database. Regression/build/security verification for gate 8 is recorded below. Gates **5 and 6 cannot be verified**: the user explicitly confirmed StudyPal has never been deployed. No public HTTPS frontend/API, production origins, production credentials or deployed session-expiration controls exist to test. Local evidence is not labeled production evidence. No deployment was attempted or invented.

Branch: `feature/studypal-v2-baseline`; current HEAD at inspection: `4954796` (updated by the user since the earlier report). The working tree was clean at inspection. This run performed no commit, push, merge, rebase, reset or history change. Authentication design, controllers, middleware, services, migrations and product behavior were not changed.

## Gate status

| Gate | Status | Evidence |
| --- | --- | --- |
| 1. Symmetric A↔B exams/attempts | Complete on real development DB | Both users own an actual generated exam and attempt; foreign read/start/submit denied |
| 2. Two-existent-exam mixed parents | Complete on real development DB | Both directions: own exam + foreign attempt, foreign exam + own attempt; GET/submit denied |
| 3. Isolated backup restore | Complete | Actual pg_restore into a new recovery DB; original counts and schema integrity verified |
| 4. B Gemini exam E2E | Complete on real development DB | Real provider returned 200; exam/attempt persisted; deterministic grade 100% |
| 5. Actual deployed HTTPS behavior | Unverified | User confirmed no deployment exists |
| 6. Actual production origins | Unverified | No public frontend/API origins exist |
| 7. Documented cleanup | Complete | Backup first; exact verification users/files/resources removed; unrelated data preserved |
| 8. Regression/security | Complete subject to final checks below | Full suite, clean installs/build, audits, native sharp smoke, syntax and source scan |

## Environment and migration

The actual target remains local development `studypal` on `127.0.0.1:5434`, PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2), container `studypal-postgres` with pgvector. Migration 006 was previously applied at `2026-10-06T10:11:04.393Z`. All six current migration checksums match. No new migration, schema reset or destructive database operation was performed.

The original target had zero users/learning records before authentication migration. No legacy credentials were invented or provisioned. Verification reused the three existing dedicated accounts; no duplicate accounts were created in this closure run.

## Gates 1, 2 and 4 — actual Gemini and exam matrix

Real authenticated login established A/B sessions through the actual API and PostgreSQL. B exam generation succeeded on the **first retry** with the unchanged configured Gemini model and prompts; provider HTTP status was 200. The earlier 503 was transient upstream availability and did not require an authentication or application change. There is no claim that future provider outages are eliminated.

Actual objects: A exam `1`, A attempt `1`, B exam `2`, B attempt `2`. Both exams and attempts existed throughout the matrix. For **each direction**, the following returned non-disclosing 404:

- Read the foreign exam.
- Start an attempt against the foreign exam.
- Read/submit the foreign exam's foreign attempt.
- Read/submit the authenticated owner's exam with the foreign attempt ID.
- Read/submit the foreign exam with the authenticated owner's attempt ID.

**16 denied probes passed**. Owner exam reads and attempt-list scoping also passed. All learning-table fingerprints remained identical after denied mutations, and unauthorized requests made **zero Gemini calls**. B's own attempt was then submitted through the real API and persisted a deterministic **100%** result. No mocked provider, database, session, user identity or generated exam was substituted.

Private evidence: `data/verification/sp-v2-009/exam-matrix-closure.json`. These resources were subsequently removed under gate 7; their backup/evidence remains available.

## Gate 3 — actual backup restore rehearsal

Original verified archive:

- Path: `data/backups/sp-v2-009/studypal-before-auth-2026-10-06T10-08-43.822Z.dump`.
- Timestamp: `2026-10-06T10:08:43.822Z`; size 54,543 bytes.
- Verified SHA-256: `a3e79b5b1bdaeceb953cd95ebf0e5924af1d99831ddb51680146d2863050c884`.

The archive checksum was rechecked before executing **pg_restore --exit-on-error --single-transaction** into the newly created isolated database `studypal_recovery_sp009_1791411796863`. No `--clean`, in-place restore, real-database deletion or rollback was used. Restore exited successfully. Every original application count matched, including zero original users/learning records and 5 migration rows. All **109 original constraints** were present and equivalent, all **14 restored FKs** were validated, and pgvector `0.8.6` was restored. One associative AND check was printed with different redundant parentheses after pg_restore; only that known formatting difference was normalized, with all operators/operands unchanged. No ownership test was weakened.

Recovery verification timestamp: `2026-10-07T22:26:20.498Z`. Original auth tables are correctly absent because this is the pre-006 archive. The recovery database is intentionally retained for review. Private evidence: `data/verification/sp-v2-009/recovery-verification.json`.

This rehearses restoration of the actual original **empty** development database, not restoration of populated production data. A different production target needs its own identified backup and recovery verification.

## Gate 7 — cleanup policy and execution

Policy: [sp-v2-009-verification-cleanup-policy.md](sp-v2-009-verification-cleanup-policy.md). The user authorized establishing and executing verification cleanup. Targets were proven by exact manifest username, successful password authentication and immutable IDs **1, 2 and 4**. ID 3 was consumed by the earlier duplicate-registration insert; IDs were not assumed contiguous. An initial temporary-harness allowlist assertion stopped before deletion and was corrected to the proven IDs, without relaxing manifest or authentication checks.

Before mutation, cleanup checked exact owned resource counts and unrelated-data fingerprints. A fresh full PostgreSQL custom archive was taken and completely decoded with pg_restore, and both owned 262-byte document files were copied and hashed privately. Recovery archive:

- Path: `/home/princewill/Desktop/studypal-frontend/studypal-backend/data/backups/sp-v2-009/cleanup-1791413596099/before-cleanup.dump`.
- Size: 70,532 bytes.
- SHA-256: `b68a5ce6d9f5364b07bdad07d198eaf3b3cee21ba65dd47f22e776c540dc1b7d`.
- Restricted backup directory/files: 0700/0600; existing ignored data directory.

The two materials/files were deleted through authenticated owner-scoped API requests. Only the three exact ID/name pairs were deleted in a transaction; existing cascades removed their owned learning records and sessions. Unrelated learning fingerprints were verified unchanged before commit. Only per-account/per-user hashed limiter keys were removed; the shared IP bucket was preserved. Old cookies immediately received 401. Raw verification credentials and the obsolete local TLS private key were removed after success. No real database, recovery database, unrelated account or schema was deleted.

Cleanup timestamp: `2026-10-07T22:53:17.317Z`. Private evidence: `data/verification/sp-v2-009/cleanup-verification.json`. Backups, document recovery copies and safe evidence are retained privately as recovery artifacts. Recovery database disposal/off-machine retention requires a separate operator decision.

| Learning data | Immediately before cleanup | After cleanup |
| --- | ---: | ---: |
| Users | 3 | 0 |
| Materials / chunks | 2 / 2 | 0 / 0 |
| Plans / tasks | 2 / 16 | 0 / 0 |
| Exams / questions | 2 / 4 | 0 / 0 |
| Attempts / answers | 2 / 4 | 0 / 0 |
| Historical questions | 0 | 0 |
| Migration rows | 6 | 6 |

Final real-database integrity: **15 validated FKs, 0 orphans, 0 answer/exam owner mismatches, 0 source-chunk/material mismatches**. No unexpected learning data was lost. The database remains intact and migrated; its empty learning state now matches the original pre-verification state.

## Gate 8 — security defect and validation

Fresh npm audit found a newly reported high-severity sharp/librsvg vulnerability, [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). This was an actual security gate failure, not an unrelated upgrade opportunity. The only dependency change is the frontend lockfile patch **sharp 0.35.4 → 0.35.5** and its own matching `@img/sharp` binaries / bundled libvips **1.3.3 → 1.3.4**. Package manifests, Next.js, React, backend dependencies and authentication design remain unchanged. No forced audit fix or broad update was used.

Native runtime verification confirms sharp **0.35.5**, librsvg **2.63.2**, and successful SVG-to-PNG processing. Fresh backend and patched frontend installs used `npm ci --ignore-scripts --no-audit --prefer-offline`; the frontend checkout was synchronized to the patched lockfile. Final production build and full regression results are recorded in the final verification block below. Isolated regression databases are distinct from the real development/recovery databases.

## Remaining production gates

StudyPal has never been deployed, as explicitly confirmed by the user. Therefore actual public login/registration/restoration/logout/password change/expiry, CORS, Secure/HttpOnly/SameSite cookies, CSRF and cross-user checks are **not performed against production**. No production origins were invented, and localhost checks were not substituted. No hosting setup or deployment was added to this verification-only task.

After a deployment is separately authorized and configured, gates 5 and 6 require identified real HTTPS origins, environment-specific verification identities/cleanup authorization, and a safe deployed session-expiry mechanism. Do not reuse the removed local test credentials. **NOT READY remains the only valid overall verdict until those required production gates are actually verified.**

## Final verification results

```text
Test suites: 202
Tests: 1049
Passed: 1049
Failed: 0
Skipped: 0
Cancelled: 0

Real development exam matrix: 16 denied probes passed
Two-existent-exam mixed-parent GET/submit: passed in both directions
B actual Gemini generation and deterministic attempt grading: passed (100%)
Isolated recovery restore: passed; original counts and 109 constraints matched
Verification account/resource cleanup: passed; unrelated fingerprints unchanged
Actual deployed HTTPS/origins: NOT VERIFIED — no deployment exists

Backend syntax: 92 checks passed
Frontend: patched clean-install production build passed
Sharp native smoke: 0.35.5 / librsvg 2.63.2, SVG-to-PNG passed
Clean installs: backend/frontend passed; checkout frontend synchronized
npm audit backend: 0 vulnerabilities at every severity
npm audit frontend: 0 vulnerabilities at every severity after targeted patch
Secret scan: 175 tracked/new nonignored files; 0 recognized matches
Tracked private environment files: 0
Final database orphans: 0
Final semantic ownership mismatches: 0
git diff --check: passed

Final verdict: NOT READY
```

The final complete suite ran after the sharp lockfile patch and cleanup, with duration 121,733.09 ms. No test was excluded or weakened. Production-mode auth startup/cookie/origin/health integration checks are included in the isolated regression suite; they do not constitute deployed production verification. No actual public browser test could be run. All changes remain uncommitted for review.
