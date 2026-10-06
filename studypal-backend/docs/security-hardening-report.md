# Security Hardening Report

## 1. Baseline

Date: 2026-10-06 (Africa/Lagos client date). Scope: dependency security only.

**PASS — baseline captured before repository edits.**

- Branch: `feature/studypal-v2-baseline`.
- Actual initial HEAD: `f39da82a440e7fb797ed7c08dc0d23e7f7a22815`.
- Initial `git status --short`: empty (clean).
- The supplied prompt named `fb9e3db`; the repository had advanced. Actual HEAD
  was preserved throughout this task.
- Node: `v22.21.1`; npm: `11.8.0`.
- Two independent npm projects: `studypal-backend` and `studypal-frontend`.
  No root `package.json` or root npm lockfile exists.
- Both lockfiles use lockfileVersion 3.
- Backend direct manifest dependencies before edits: `@google/genai ^1.46.0`,
  `cors ^2.8.6`, `dotenv ^17.3.1`, `express ^5.2.1`, `multer ^2.1.1`,
  `pdf-parse ^2.4.5`, `pg ^8.23.0`.
- Frontend manifest dependencies before edits: `next ^16.2.1`, `react ^19.2.4`,
  `react-dom ^19.2.4`.
- Installed relevant versions: Express 5.2.1, proxy-addr 2.0.7, Multer 2.3.0,
  Next 16.3.4, React/React DOM 19.2.4, baseline-browser-mapping 2.10.10,
  PostCSS 8.5.23, source-map-js 1.2.1.

`npm audit` and `npm audit --json` were run for both projects. Baseline test run
against real PostgreSQL: **195 suites, 986 tests, 986 passed, 0 failed,
0 skipped, 0 cancelled, 0 todo**, duration 79.697 seconds.

Baseline manifest and lockfile copies are retained locally under
`/tmp/studypal-hardening-baseline/`; raw audit output remains under `/tmp` rather
than in the repository. No environment files or credentials are included here.

Baseline lockfile SHA-256:

```text
backend  d224621dd11bea0f5249d3ed849404d66d2afadde133ff67dcd48dd4b0c36ec2
frontend 8f3e8463c2c01971e9c6591a945e50466c7e3af7349db4648ab2f0b0f9af661f
```

## 2. Vulnerabilities Found

The current registry audit confirmed all five previously reported findings.
Ranges below are the advisory ranges supplied by the fresh audit, not guessed
from manifest ranges. Each has a compatible fix; none requires a major upgrade.

| Package | Installed | Severity | Advisory affected range | Minimum fixed release | Classification |
| --- | --- | --- | --- | --- | --- |
| proxy-addr | 2.0.7 | Critical | >=1.1.0 <2.0.8 | 2.0.8 | B: compatible transitive upgrade |
| multer | 2.3.0 | Moderate | >=2.2.0 <2.4.0 | 2.4.0 | A: compatible direct upgrade |
| next | 16.3.4 | Critical | >=16.2.0 <16.3.6 | 16.3.6 | A: compatible direct upgrade |
| baseline-browser-mapping | 2.10.10 | Moderate | >=2.0.0 <2.11.0 | 2.11.0 | B: compatible transitive upgrade |
| source-map-js | 1.2.1 | High | >=1.0.0 <1.2.2 | 1.2.2 | B: compatible transitive upgrade |

Advisory IDs and sources:

- proxy-addr: [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
  CVE-2026-90711; IP spoofing with incorrectly trusted IPv4-mapped IPv6 subnets.
- Multer: [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34),
  CVE-2026-88932; aborted disk uploads can leave orphaned files.
- Next: [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j);
  Node next/og ImageResponse with attacker-controlled SVG values can allow RCE.
- baseline-browser-mapping:
  [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv),
  CVE-2026-45819; invalid inputs can terminate the process.
- source-map-js: [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
  CVE-2026-93749; malicious indexed source-map offsets can block the event loop.

The registry reported `fixAvailable: true` for all five. No findings were dismissed
or filtered out on applicability grounds.

## 3. Root Causes / Dependency Paths

Paths were verified with installed package manifests, lockfiles and `npm ls`:

```text
backend → express@5.2.1 → proxy-addr@2.0.7
backend → multer@2.3.0
frontend → next@16.3.4
frontend → next@16.3.4 → baseline-browser-mapping@2.10.10
frontend → next@16.3.4 → postcss@8.5.23 → source-map-js@1.2.1
```

Runtime applicability was checked separately from dependency presence:

- **proxy-addr** is a runtime Express dependency. The current application does
  not enable `trust proxy` or use req.ip/req.ips for security decisions. The
  advisory's misconfigured trust-subnet prerequisite was not found in app code.
  This is a source-based assessment of the current application, not a reason to
  retain the vulnerable package or a guarantee about external deployment code.
- **Multer** runs on the existing upload endpoints. Both application upload
  middlewares use memoryStorage, whereas this advisory targets diskStorage.
  That specific disk-write path is not used, but the compatible update removes
  the installed finding and preserves the tested memory upload paths.
- **Next** runs the frontend production server and build. No app code imports
  next/og, defines ImageResponse or passes user-controlled SVG into it. The
  documented prerequisite is absent in the current app; the patched framework
  was still installed rather than relying on permanent non-use of that feature.
- **baseline-browser-mapping** is an installed Next dependency for browser
  compatibility tooling. Application source has no direct calls or request
  parameters passed to it. No user-reachable exploit path was identified.
- **source-map-js** is introduced by Next's PostCSS dependency. It participates
  in CSS/source-map tooling; application code has no endpoint accepting source
  maps. No user-reachable exploit path was identified in the current app. Build
  tooling exposure is still relevant, so it was patched.

The last two are limited source-based applicability assessments, not proofs that
all framework internals or deployment configurations are immune.

## 4. Changes Made

**PASS — minimal dependency changes; application source and tests untouched.**

Files changed:

1. `studypal-backend/package.json`: pin Multer 2.4.0 and scope a proxy-addr 2.0.8
   override beneath Express.
2. `studypal-backend/package-lock.json`: regenerated by npm.
3. `studypal-frontend/package.json`: pin Next 16.3.6; scope
   baseline-browser-mapping 2.11.0 beneath Next and source-map-js 1.2.2 beneath
   PostCSS.
4. `studypal-frontend/package-lock.json`: regenerated by npm.
5. `studypal-backend/docs/security-hardening-report.md`: this report.

`npm pkg set` updated manifests and `npm install --no-audit` regenerated lockfiles.
No lockfile was manually edited. Neither `npm audit fix --force` nor a mass
update was used. Scoped overrides select compatible releases already allowed by
parent dependency ranges, while making the security constraints explicit.

No commits, pushes, merges, rebases, resets, branch deletion, history changes or
deployment occurred. Final branch and HEAD equal the actual baseline values.
All five changed files remain uncommitted.

## 5. Packages Changed

| Package | Before | After |
| --- | --- | --- |
| multer | 2.3.0 | 2.4.0 |
| proxy-addr | 2.0.7 | 2.0.8 |
| next | 16.3.4 | 16.3.6 |
| baseline-browser-mapping | 2.10.10 | 2.11.0 |
| source-map-js | 1.2.1 | 1.2.2 |
| @next/env | 16.3.4 | 16.3.6 |
| Eight optional @next/swc platform packages | 16.3.4 | 16.3.6 |

Next requires its environment and compiler packages to match its release; these
are required companion updates, not unrelated upgrades. All eight platform
entries remain recorded in the lockfile; only applicable native packages are
installed on this Linux host.

Multer 2.4.0 no longer depends on concat-stream. npm consequently removed six
unused packages: concat-stream 2.0.0, buffer-from 1.1.2, readable-stream 3.6.2,
string_decoder 1.3.0, typedarray 0.0.6 and util-deprecate 1.0.2.

A complete before/after lockfile version comparison found no other package version
changes. Express remains 5.2.1, React/React DOM 19.2.4, PostCSS 8.5.23,
@google/genai 1.46.0 and pg 8.23.0. PostgreSQL, testing and UI libraries were not
upgraded. No new application dependencies were added.

## 6. Why These Versions Were Chosen

Each selection is the first patched release identified by the current audit and
verified against npm metadata and advisory/release information.

- **proxy-addr 2.0.8** satisfies Express's existing `^2.0.7` range, so Express
  needs no upgrade. See the [maintainer release](https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8).
- **Multer 2.4.0** stays within major 2 and fixes the observed moderate advisory.
  See the [maintainer release](https://github.com/expressjs/multer/releases/tag/v2.4.0).
- **Next 16.3.6** is a patch update from installed 16.3.4 and fixes the critical
  advisory. It is not an automatic selection of the newest release. See the
  [Next release](https://github.com/vercel/next.js/releases/tag/v16.3.6).
- **baseline-browser-mapping 2.11.0** satisfies Next's `^2.9.19` range. Although
  the registry latest was 2.11.27, the minimum patched release was chosen to
  avoid unrelated browser-data updates.
- **source-map-js 1.2.2** satisfies PostCSS's `^1.2.1` range. Neither PostCSS nor
  its other dependencies needed an update.

Exact direct pins and scoped overrides prevent a fresh install from selecting a
previously vulnerable release and constrain dependency work to the versions
verified here. Future security patches should be reviewed and these pins updated
as needed; a clean audit today does not remove the need for ongoing audits.

## 7. Compatibility Verification

**PASS — current application behavior preserved under the checks performed.**

Next 16.3.6 retains Node >=20.9.0; Node 22.21.1 satisfies it. Its React and
React DOM peer ranges still accept ^19.0.0, including the existing 19.2.4.
Dependencies and peer metadata were compared with the installed 16.3.4 manifest.
No React, configuration, middleware/proxy or App Router migration was required.
The app has no custom Next middleware/proxy or next.config file; default framework
behavior remains in use. Production routes `/`, `/exam`, `/analytics` and the
existing not-found behavior passed build/runtime checks.

**PASS — lockfile integrity.** Fresh empty directories under
`/tmp/studypal-hardening-clean/{backend,frontend}` received only the updated
manifests/lockfiles, then `npm ci --no-audit` completed successfully. Both locks
were byte-for-byte unchanged afterward. Patched installed versions were checked
in both working and clean installations. `npm ls --all --json` succeeds for both
working trees with no invalid dependency resolution.

Final lockfile SHA-256:

```text
backend  d3f71bad9a50f4874cb1fee0e3ed05d7b3d7836c27b5cfd8a17420f212cd26cc
frontend 033e79f12177d10bf32e8c1f1656b1bba2e44b82bb759ea96751b03332fb624e
```

Clean installs were used for reproduction/version verification; the full regression
suite and build ran against the working installations containing those same
locked versions. The temporary projects do not constitute a second CI environment.

## 8. Before vs After Audit

**PASS — both human-readable and JSON audits completed against the registry.**

| Project / stage | Info | Low | Moderate | High | Critical | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Backend before | 0 | 0 | 1 | 0 | 1 | 2 |
| Backend after | 0 | 0 | 0 | 0 | 0 | 0 |
| Frontend before | 0 | 0 | 1 | 1 | 1 | 3 |
| Frontend after | 0 | 0 | 0 | 0 | 0 | 0 |

Both final `npm audit` commands report `found 0 vulnerabilities`; both JSON results
have empty vulnerabilities objects and all-zero vulnerability counts. Final audit
exit codes were zero. This covers npm's reported installed dependency advisories,
not every possible application or infrastructure vulnerability.

## 9. Test Results

**PASS — no regression from the complete existing suite.**

| Measure | Baseline | Patched |
| --- | ---: | ---: |
| Suites | 195 | 195 |
| Tests | 986 | 986 |
| Passed | 986 | 986 |
| Failed | 0 | 0 |
| Skipped | 0 | 0 |
| Cancelled | 0 | 0 |
| Todo | 0 | 0 |
| Duration (seconds) | 79.697 | 81.330 |

The suite covers PostgreSQL/migrations, materials, RAG, study plans, exams,
deterministic grading, analytics, API contracts, architecture and ownership. No
existing tests were edited or excluded.

Additional verification:

| Check | Verdict / evidence |
| --- | --- |
| Backend syntax | PASS: node --check on all 83 backend source/entrypoint/script JS/MJS files |
| Frontend production build | PASS: Next 16.3.6, all existing routes prerendered |
| Backend production startup | PASS: isolated migrated PostgreSQL, NODE_ENV=production, healthy /health |
| Production API smoke | PASS: materials listing, empty-corpus RAG, study-plan list, exam retrieval/validation, all six analytics endpoints and two-user ownership |
| Existing analytics smoke | PASS: node scripts/analytics-smoke.mjs, including zero-data user and foreign-plan 404s |
| Frontend runtime | PASS: fresh headless Chrome against the Next production server |
| Frontend JavaScript errors | PASS: zero pageerror events during exercised flows |
| Secret-pattern scan | PASS: five changed files, zero matches; additional credential-pattern scan also clean |
| git diff --check | PASS |
| Separate frontend test/lint/typecheck scripts | NOT CONFIGURED: no such scripts, no tsconfig.json; not reported as passing independent suites |

The browser flow verified homepage hydration and existing username-session behavior,
homepage chat, exam material listing, exam generation/start/answer/submission/result,
analytics overview/collections/plan progress and the 404 page. It compared the
analytics exam percentage with the persisted submission result. Material multipart
upload/extraction/indexing/RAG chat and study-plan creation/retrieval were separately
exercised over the real HTTP API during that browser run. The frontend has no
standalone material-management or study-plan editor pages; none were added.

Browser verification used the installed local Chrome and an existing temporary
Playwright tool installation, with no repository dependency change. In-app browser
controls were unavailable. The production frontend's built-in localhost:4000 API
origin was routed to the isolated test backend, without replacing API responses.
That backend used the existing test harness's deterministic Gemini/embedding
provider; no paid/live AI calls were made. The separate production-mode backend
smoke used no fake provider preload and called only deterministic/no-corpus paths.
Neither exercise verifies live provider availability or a deployed environment.

Reproduction commands (run from each indicated project, with the normal isolated
PostgreSQL test configuration available):

```sh
# studypal-backend
npm ci
npm ls --all
npm audit
npm audit --json
npm test
node scripts/analytics-smoke.mjs

# studypal-frontend
npm ci
npm ls --all
npm audit
npm audit --json
npm run build
npm start

# repository root
 git diff --check
```

Supplemental production/browser smoke scripts and logs are local artifacts under
`/tmp`; they are not permanent application code. Evidence paths:

```text
/tmp/hardening-tests-before.log
/tmp/hardening-tests-after.log
/tmp/hardening-build-after.log
/tmp/hardening-backend-before.{json,txt}
/tmp/hardening-frontend-before.{json,txt}
/tmp/hardening-studypal-backend-after.{json,txt}
/tmp/hardening-studypal-frontend-after.{json,txt}
/tmp/hardening-{backend,frontend}-clean-install.log
/tmp/hardening-analytics-production-smoke.log
/tmp/hardening-production-smoke.mjs
/tmp/hardening-production-smoke.log
/tmp/hardening-ui-smoke.mjs
/tmp/hardening-ui-smoke.log
/tmp/hardening-analytics-ui.png
```

These are temporary local evidence, not guaranteed long-term storage. The report
records exact results independently of their retention.

## 10. Remaining Vulnerabilities

**PASS — no remaining npm audit findings in either project at verification time.**
No advisory was suppressed or accepted as a residual moderate finding. There is
therefore no remaining vulnerable-package dependency path to enumerate for this
audit. The dependency gate no longer has a major-upgrade blocker.

## 11. Remaining Security Risks

This task deliberately preserved the existing username-based identity model.
User-scoped SQL provides isolation between requested identities; it does not
prove that the caller owns the supplied username. Someone knowing another
student's name can still request that claimed identity's data. This remains the
existing application's authentication/authorization issue, documented in
[security-baseline.md](security-baseline.md), and is not fixed by an npm audit.

Existing application-level exposure/abuse controls and deployment configuration
also need a separate review. No application security redesign or claim of
comprehensive penetration testing is made here. The secret scan reuses the prior
SP-V2-007 patterns (private-key headers, AWS IDs, Google API keys, GitHub tokens)
and adds credential/connection-string checks on changed files. It found no newly
introduced secrets; it is not a comprehensive historical secret audit.

Analytics calculations, DTOs, topic attribution, resource ownership conventions,
RAG and grading are unchanged. No authentication, AI recommendations, new metrics,
background jobs, schema changes or product features were introduced.

## 12. Release-Gate Verdict

**PASS — dependency-hardening release gate.**

Zero critical, high, moderate, low and informational npm findings; complete
regression suite green; production build/startup and exercised API/UI flows pass;
lockfiles reproduce; no source behavior edits, unrelated upgrades or new secrets.

This scoped PASS does not certify the username-based application for handling
private student data. The separate identity/security architecture risk remains.
No deployment was performed.

Final Git state: branch `feature/studypal-v2-baseline`, HEAD
`f39da82a440e7fb797ed7c08dc0d23e7f7a22815`. Four modified package/lock files and
one untracked report. Beginning and ending last ten commits are unchanged:

```text
f39da82 Merge pull request #26 from bobprince4u/main
2f96d37 Merge pull request #25 from bobprince4u/feature/studypal-v2-baseline
f19017f Merge pull request #24 from bobprince4u/main
ccff6e1 Merge pull request #23 from bobprince4u/feature/studypal-v2-baseline
47428dc Implemented SP-V2-007 — Learning Analytics complete
d3b1087 Merge pull request #22 from bobprince4u/feature/studypal-v2-baseline
0948417 Merge pull request #21 from bobprince4u/main
99d9f85 Merge pull request #20 from bobprince4u/feature/studypal-v2-baseline
fb9e3db feat:SP-V2-006 — AI Exam Simulator complete implementation
04eaf88 Merge pull request #19 from bobprince4u/feature/studypal-v2-baseline
```

## 13. Recommended Next Phase

A separate authenticated-identity and authorization phase: bind resource ownership
to verified sessions, test cross-user access against caller identity rather than
only a supplied username, and review abuse controls for uploads and AI requests.
Keep recurring dependency audits and reproducible npm ci installs in CI; review
future security patches before moving the exact pins/overrides. No part of that
next phase was implemented during this dependency task.
