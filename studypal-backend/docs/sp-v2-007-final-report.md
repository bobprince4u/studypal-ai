# SP-V2-007 — Learning Analytics: Final Report

## 1. What was built

Read-only overall analytics, study-plan/task progress, persisted exam performance,
bounded completed-attempt history, recent historical comparison, exam-tag topic
performance, source-material performance and deterministic observed weak areas.
A minimal `/analytics` frontend page consumes backend DTOs and links from the home
page. No recommendations or predictive features were added.

## 2. Architecture

PostgreSQL → repository → service/metrics → explicit serializers → controller →
GET routes → frontend. All analytics SQL is in its repository. No AI, embedding,
vector retrieval, transaction writes or grading imports exist in analytics.
See [learning-analytics-architecture.md](learning-analytics-architecture.md).

## 3. Files changed

- `src/analytics/analytics.repository.js`: ten parameterized owner-scoped reads.
- `src/analytics/analytics.service.js`: resolve existing users and orchestrate reads.
- `src/analytics/analytics.metrics.js`: percentages, averages, trend and weakness.
- `src/analytics/analytics.serializers.js`: explicit public DTOs.
- `src/analytics/analytics.controller.js`: HTTP handlers.
- `src/analytics/analytics.routes.js`: six GET routes.
- `src/analytics/analytics-validation.middleware.js`: username, limit, plan ID.
- `src/config/env.js`: bounded analytics configuration.
- `src/routes/index.js`: mount analytics router.
- `tests/analytics/{metrics,repository,api,architecture}.test.js`: rules, real
  PostgreSQL, HTTP, ownership and architectural coverage.
- `scripts/analytics-smoke.mjs`: reproducible production-mode two-user check.
- `docs/learning-analytics-architecture.md`, this report and `README.md`.
- Frontend `app/analytics/page.jsx` and a navigation link in `app/page.jsx`.

The tree already contained analytics source/tests plus configuration/router edits
when this task started. Those changes were reviewed and extended, not discarded.

## 4. API

All require `?username=…`. Bare object/array responses preserve existing style.

| GET route | Shape |
| --- | --- |
| `/api/analytics` | studyPlans, tasks, exams, trend |
| `/api/analytics/exams` | completed attempt DTO array; default 10, maximum 50 |
| `/api/analytics/topics` | topic accuracy DTO array |
| `/api/analytics/weak-areas` | weak topic DTO array with reason |
| `/api/analytics/materials` | material accuracy DTO array, nullable identity |
| `/api/analytics/study-plans/:id` | owned plan, task progress and task topics |

Validation rejects invalid/repeated query inputs, unsafe plan IDs and NUL usernames.
Unknown aggregate users receive zero/empty results. Missing or foreign plans share
404. Error handling hides database errors and stack traces.

## 5. Analytics calculations

Counts reflect the actual schema states. Completed/total tasks gives completion.
Empty denominators return null. Exam results use persisted completed attempts,
percentage and passed, with unfinished attempts reported separately and never failed.
History sorts submitted_at DESC, id DESC. Topic/material accuracy counts persisted
answer correctness, excluding unanswered questions. Retakes count independently.
All derived decimals use `Math.round(value * 100) / 100`.
Trend compares equal recent/preceding windows: min(5, floor(completed count/2)),
minimum 2 per window by default. Insufficient data returns four null fields.

## 6. Weak-area detection

Default minimum evidence 3; rounded accuracy strictly below 60. Exactly 60 is not
weak. Sort accuracy ascending, evidence descending, topic code-unit order.
Tests explicitly cover zero/two/three attempts, 0%, 59.99%, 60%, 60.01%, 100%
and stable ordering. Reason: accuracy_below_threshold.

## 7. Ownership and security

Every analytics SQL statement binds an owner filter. Plan lookups bind owner and
ID. Joins constrain owners and answer-question exam identity. SQL parameters cover
user and limits; no dynamic SQL identifiers. Explicit DTOs exclude answer keys,
selected answers, storage keys, owner IDs and secrets. GET analytics never upserts
users or writes source data.
Inherited username identity is not authenticated caller identity. Supplying another
person's username requests that identity's analytics; authenticated access control
remains an existing application limitation, not a claim these checks solve.

## 8. Tests

Final full run: `npm test`, real local PostgreSQL and HTTP child servers.

| Measure | Exact count |
| --- | ---: |
| Suites | 195 |
| Tests | 986 |
| Passed | 986 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Todo | 0 |

Duration 67.543 seconds. Includes all SP-V2-001 through SP-V2-006 regressions and
new analytics tests. The earlier sandbox run could not access PostgreSQL and is
not counted as passed. Initial unrestricted run had 977 passed/4 failed out of
981 tests; fixes addressed NUL validation and three textual assertion false
positives (correctAnswers versus correctAnswer, display filename versus storage
key, and a comment mistaken for a study-plan import). The regression tests were
preserved; the offending comment was reworded.

Final logs: `/tmp/sp007-tests-final.log`, `/tmp/sp007-build.log`,
`/tmp/sp007-smoke.log`. These local logs are not committed artifacts.

## 9. Dependencies

No package manifests or lockfiles changed; no SQLite, Redis, queue or worker added.
`npm audit --json` completed against the registry for both projects and returned
nonzero vulnerability results:

| Project | Moderate | High | Critical | Total |
| --- | ---: | ---: | ---: | ---: |
| Backend | 1 | 0 | 1 | 2 |
| Frontend | 1 | 1 | 1 | 3 |

Backend: multer (moderate, GHSA-3pph-fpjx-jg34), proxy-addr (critical,
GHSA-jqcg-44mw-7w3h). Frontend: baseline-browser-mapping (moderate,
GHSA-w5vr-8v7q-w6rv), source-map-js (high, GHSA-68fv-2mgg-jv7q), next (critical,
GHSA-vcvr-r3jv-pc5j). Registry reports fixes available. These are existing installed
package findings; no automatic upgrades were made in this analytics-only change.
Audit JSON: `/tmp/sp007-studypal-backend-audit.json` and
`/tmp/sp007-studypal-frontend-audit.json`.

## 10. Database/query changes

No new tables, migrations or indexes. Existing user-leading and parent join indexes
were considered. Completed history sorts submitted time after user filtering;
future scale may justify an owner/submitted-time index after measurement. No cache.
Scalar question material IDs avoid the existing BIGINT[] parser behavior entirely.
Repeated tags are deduplicated within an exam before topic aggregation.

## 11. Deviations from specification

Added `/materials` to expose the requested material breakdown. Trend uses equal
windows of 2–5 rather than requiring ten attempts, explicitly documented.
No question-level topic labels exist, so topic results are exam-tag aggregates;
this limitation is exposed in docs and the frontend. No guessed attribution.
Empty completion is null, allowed by the specification. Lint is unavailable: neither
package defines a lint script. Browser interaction/visual QA was not performed;
frontend validation is the production build. Manual HTTP verification was scripted
and separately executed, rather than a browser-driven learner workflow.

## 12. Findings and technical debt

Multi-topic exam tags overlap and cannot identify individual question weaknesses.
Deleted material identity cannot be recovered; null attribution combines deleted
and originally ungrounded answers. Unanswered questions do not enter topic/material
accuracy. Existing username-based identity needs authentication. Overview reads are
not one transaction snapshot. Topic/material breakdown collections have no
pagination. Audit vulnerabilities require separate remediation before release.

## 13. Manual verification

Executed `node scripts/analytics-smoke.mjs` outside the network-restricted sandbox.
The script creates a fresh isolated test database from the migrated template and
starts `server.js` in NODE_ENV=production with no fake provider preload. It calls
only deterministic endpoints, making no paid AI requests.
User A: two plans, completed/pending tasks, two completed exams, Algebra 0% and
Geometry 100%, one observed weak area. User B: a distinct plan with a skipped task,
Biology results, no weak area. A third user has no learning data.
Verified both summaries, plan progress, exam performance/history, distinct topic
sets, weak areas, null material attribution, zero-data and cross-user plan 404s in
both directions. All passed. Server stopped and isolated database dropped.
Repository/schema suites additionally verify clean migration application, deleted
materials, ownership of all aggregates, ties, safe limits and unfinished attempts.

## 14. Verification gate

- Syntax: `node --check` passed for 14 changed backend JS/MJS source/test files.
- Full suite: 195 suites, 986/986 passed, zero failed/skipped/cancelled.
- Frontend: `npm run build` passed; `/analytics` included in generated routes.
- Clean PostgreSQL migrations: passed in existing migration tests and isolated setup.
- Backend production start/health: passed in the smoke script.
- API, ownership and architecture tests: passed.
- Lint: no script available; not claimed as performed.
- Audit: performed, **not clean**; existing critical findings block a clean release gate.
- Secret-pattern scan: 16 changed code files, zero matches for private-key headers,
  AWS access IDs, Google API keys and GitHub token patterns. This is a bounded
  pattern scan, not a comprehensive historical credential audit.
- `git diff --check`: passed.

Functional implementation and regression verification pass. The security release
gate remains blocked by the dependency audit findings above.

## 15. Git state

Branch at beginning and end: `feature/studypal-v2-baseline`.
HEAD at beginning and end: `fb9e3db`. No commit, push, merge, rebase, reset or history
rewrite was performed. Beginning status: modified config/env.js and routes/index.js;
untracked src/analytics/ and tests/analytics/.
Final status includes those plus modified backend README and frontend app/page.jsx;
untracked architecture/report docs, smoke script and frontend app/analytics/.

`git log --oneline -10` remained:

```text
fb9e3db feat:SP-V2-006 — AI Exam Simulator complete implementation
0e503f6 Merge pull request #18 from bobprince4u/main
7c31efe Merge pull request #17 from bobprince4u/feature/studypal-v2-baseline
6797314 docs: record the study-plan architecture, and update the schema and README for it
7d65352 test(study-plans): assert the SP-V2-005 architecture boundaries
0b5d3c7 feat(study-plans): endpoints to create, view, update and regenerate plans
01dc1b7 feat(study-plans): generate plans as structured JSON, grounded in the learner's materials
fc53d05 feat(study-plans): validate model output and normalize it into a dated schedule
d0a42d5 feat(study-plans): schema for plans and tasks, with ownership enforced by the database
139eff7 Merge pull request #16 from bobprince4u/feature/studypal-v2-baseline
```
