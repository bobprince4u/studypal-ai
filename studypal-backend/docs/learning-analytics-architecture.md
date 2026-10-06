# Learning Analytics Architecture — SP-V2-007

## Purpose

Report completed learning activity, study-plan progress, persisted exam results,
historical comparisons and observed weak areas. Analytics never decides what to
study next and never changes source records.

## Architecture

PostgreSQL → analytics repository → service/metrics → explicit DTO → REST API → frontend.
SQL lives only in `src/analytics/analytics.repository.js`. Controllers handle HTTP;
validation handles inputs; service resolves the existing user and orchestrates
fixed-count reads; metrics contains deterministic arithmetic; serializers name
public fields explicitly. No Gemini, embeddings, vector retrieval or grading is
in this path. No new dependencies, tables, migrations, cache or indexes.

## Data sources

`study_plans`: persisted active/completed/cancelled/archived status.
`study_plan_tasks`: pending/in_progress/completed/skipped state and nullable topic.
`exams`: creation count and requested `topics TEXT[]`.
`exam_attempts`: in_progress/completed, persisted score, total_questions,
correct_answers, percentage, passed, started_at and submitted_at.
`attempt_answers`: actual answered questions and persisted `is_correct`.
`exam_questions`: nullable scalar source_material_id, exam and owner.
`materials`: existing original_filename only. Legacy chat `questions` is not an
exam-result source and is not mixed into exam analytics.

## API

Every endpoint requires a trimmed nonempty string `username` within the existing
username length bound. NUL is rejected before PostgreSQL. Plan IDs must be safe
positive integers. Responses follow existing bare-object/bare-array conventions.

| GET path | Result |
| --- | --- |
| `/api/analytics` | studyPlans, tasks, exams, trend |
| `/api/analytics/exams` | recent completed attempts |
| `/api/analytics/topics` | exam-topic breakdown |
| `/api/analytics/weak-areas` | observed weak topics |
| `/api/analytics/materials` | source-material breakdown, including null attribution |
| `/api/analytics/study-plans/:id` | plan metadata, task totals, progress by task topic |

History defaults to 10 and clamps client limits to 50 by default. Malformed,
unsafe, repeated, zero and negative limits produce 400. Deployment history settings
are also bounded to 1–50 and the default is capped by the configured maximum.
Unknown users receive empty aggregate results; absent, foreign and unknown-user
plan lookups share `404 {"error":"Study plan not found."}`.

## Metrics

Plan totals count all persisted plans, with each supported status reported.
Task totals count every scheduled task including skipped tasks; completion is
completed / total × 100. No tasks means null completion, with counts zero.
Exam total includes cancelled exams. Attempts includes unfinished attempts;
completedAttempts, passed, failed and all percentage statistics use completed
attempts only. Passed/failed read the stored boolean, never a new pass threshold.
Average is the mean of persisted percentages; highest/lowest are their extrema;
most recent uses submitted_at descending with attempt ID descending as tie-break.
No completed attempts means null statistics. History exposes persisted scores,
counts and timestamps, plus exam display metadata; it exposes no answer key.

Topic/material questionsAttempted counts persisted answer rows from completed
attempts. Correct counts true is_correct; incorrect = attempted − correct;
accuracy = correct / attempted × 100. Unanswered questions have no answer row,
so they do not enter these denominators, although the exam grader counts them
against the whole paper. Retakes contribute separately.

Topics are **exam tags**, not question-level labels. Each answered question
counts once toward each distinct requested topic on its exam. A multi-topic exam
therefore contributes overlapping evidence. Totals across topics are not additive,
and low results cannot isolate which individual topic caused mistakes. No topics
means no topic rows. Weak-area results inherit this limitation and should be read
as performance on exams tagged with the topic, not proof of topic mastery.

## Rounding

One rule: `Math.round(value * 100) / 100`. JavaScript rounds ties toward positive
infinity, including negative differences. Derived percentages, averages and trend
differences use two decimal places. Persisted exam percentages are already whole
integers and remain authoritative. Empty measurements are null; counts are zero.

## Trend

Read at most twice the configured window (default 10 completed attempts), ordered
by submitted_at DESC, id DESC. Set window = min(configured cap, floor(count / 2)).
Default cap is 5; minimum is 2. Below that minimum all four trend fields are null.
Otherwise compare the latest window with the immediately preceding equal window:
round2(rounded recent average − rounded previous average). Positive = up,
negative = down, zero = flat. Four attempts suffice with default settings; one
attempt never produces a trend. This is a historical comparison, not prediction.

## Weak areas

Named settings: MIN_TOPIC_ATTEMPTS = 3, WEAK_TOPIC_ACCURACY_THRESHOLD = 60 by
default (config.analytics.minTopicAttempts/weakTopicAccuracyThreshold).
Evidence floor is at least 3 even if a deployment supplies a smaller value;
threshold is constrained to 0–100. A row qualifies when questionsAttempted >=
floor and its rounded accuracyPercentage is strictly below the threshold.
59.99 qualifies; exactly 60 and 60.01 do not. Zero/two attempts do not qualify.
Sort by accuracy ascending, question count descending, then topic name using
JavaScript code-unit comparison. Reason is `accuracy_below_threshold`.

## Ownership

Every aggregate and resource query binds user_id. Plan reads bind both plan ID
and owner. Answer joins constrain owner and exam identity; material metadata joins
constrain owner too. Composite source-schema foreign keys provide another boundary.
SQL uses parameters, including history limits. DTOs expose no owner IDs, storage
keys, selected answers, correct answers, password fields or raw database rows.
Central error handling hides database details and stack traces.
The inherited username-based identity is not authentication: a caller who supplies
another person's username can request that person's aggregate. These checks isolate
queries by the requested identity; authenticated caller enforcement is deferred
until the application has an authentication boundary.

## Material attribution

Use per-question source_material_id, not exams.material_ids (request provenance).
Deleting a material sets question attribution to null; source_type may remain
material. Null attribution groups deleted and originally unattributed answers
without recreating missing metadata. Live material rows expose their filename.

## BIGINT[]

The existing scalar INT8 parser does not parse INT8 arrays; exams.material_ids
arrives as strings and the exam repository normalizes it locally. Analytics never
reads that array. It uses scalar source_material_id with the existing parser,
so no global parser change is necessary.

## Query performance

Existing user-leading study-plan/exam/attempt indexes support ownership filtering.
Task/answer indexes support parent joins; primary keys support question/material
joins. Submitted-time history needs a sort after the existing user/started-time
index filters; limits bound output, not all processing. No measured requirement
justifies a new index in this phase. Grouped topic/material collections are not
truncated, so weak-area evidence is never silently lost. No cache is introduced.

## Limitations

Topic attribution overlaps; material deletion loses identity; accuracy excludes
unanswered questions; username identity lacks authentication. Overview uses several
independent reads rather than one snapshot, so concurrent submissions may briefly
produce counts from slightly different committed moments. Breakdowns may grow with
the number of distinct user topics/materials; future pagination must preserve
complete weak-area aggregation. No temporal date grouping is performed. Timestamps
are persisted PostgreSQL values serialized through the existing UTC parsers.

## Deferred

AI recommendations, adaptive study plans, predictive learning, notifications,
spaced repetition, calendar integration, background analytics and gamification.
