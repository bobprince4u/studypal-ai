// Isolated PostgreSQL fixtures and production-mode HTTP smoke verification.
import assert from 'node:assert/strict';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createIsolatedDatabase } from '../tests/helpers/test-database.mjs';
import { testUser } from '../tests/helpers/server-harness.mjs';
const database = await createIsolatedDatabase({ label: 'analytics-smoke' });
const pool = new pg.Pool({ connectionString: database.url });
const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: database.url, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Consume output without printing environment or credentials.
child.stdout.resume(); child.stderr.resume();
const base = `http://127.0.0.1:${port}`;
async function request(path, name) {
  const response = await fetch(`${base}${path}?username=${encodeURIComponent(name)}`);
  return { status: response.status, body: await response.json() };
}
let sequence = 0;
function unique() {
  sequence += 1;
  return `${sequence}_${Date.now().toString(36)}`;
}

/**
 * Create a user row directly.
 *
 * Analytics deliberately does NOT upsert users — §1 makes it read-only, and
 * `users.upsert` on a GET would be a write. So a username only exists here if
 * this function put it there, which is also what makes the unknown-username
 * tests below meaningful.
 */
async function makeUser(prefix = "an") {
  const username = testUser(prefix);
  await pool.query("INSERT INTO users (username) VALUES ($1)", [username]);
  return username;
}

const userId = (username) =>
  pool
    .query("SELECT id FROM users WHERE username = $1", [username])
    .then(({ rows }) => rows[0].id);

async function makeMaterial(username, filename = "notes.pdf") {
  const { rows } = await pool.query(
    `INSERT INTO materials
            (user_id, original_filename, storage_key, mime_type, file_size, status)
     VALUES ((SELECT id FROM users WHERE username = $1),
             $2, $3, 'application/pdf', 2048, 'ready')
     RETURNING id`,
    [username, filename, `analytics-api-${unique()}.pdf`],
  );
  return rows[0].id;
}

async function makePlan(
  username,
  { status = "active", title = "Plan", subject = "Maths" } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO study_plans
            (user_id, title, subject, goal, start_date, end_date, exam_date,
             daily_minutes, difficulty_level, status, topics, study_days)
     VALUES ((SELECT id FROM users WHERE username = $1),
             $2, $3, 'Pass the exam', '2026-01-01', '2026-01-31', '2026-02-05',
             60, 'intermediate', $4, ARRAY['Algebra']::text[],
             ARRAY['monday', 'wednesday']::text[])
     RETURNING id`,
    [username, title, subject, status],
  );
  return rows[0].id;
}

async function makeTasks(planId, username, entries) {
  const owner = await userId(username);
  for (const [index, entry] of entries.entries()) {
    await pool.query(
      `INSERT INTO study_plan_tasks
              (study_plan_id, user_id, scheduled_date, position, title, topic,
               task_type, duration_minutes, status)
       VALUES ($1, $2, '2026-01-05'::date + $3::int, $3, $4, $5, 'study', 45, $6)`,
      [
        planId,
        owner,
        index,
        entry.title ?? `Task ${index + 1}`,
        entry.topic ?? null,
        entry.status ?? "pending",
      ],
    );
  }
}

let submittedAtTick = 0;
function nextSubmittedAt() {
  submittedAtTick += 1;
  return new Date(Date.UTC(2026, 0, 1, 9, submittedAtTick, 0)).toISOString();
}

/**
 * An exam, its questions, one attempt and its answers — the same helper
 * tests/analytics/repository.test.js uses, keyed on username.
 *
 * The stored `percentage` is computed over every question on the paper, the way
 * src/exams/grader.js computes it, so no fixture here asserts a grading rule
 * this phase does not own.
 */
async function sitExam(
  username,
  {
    topics = ["Algebra"],
    results = [true],
    unanswered = 0,
    sources = [],
    status = "completed",
    title = "Mock exam",
    subject = "Maths",
  } = {},
) {
  const owner = await userId(username);
  const total = results.length + unanswered;
  const correct = results.filter(Boolean).length;
  const percentage = Math.round((correct / total) * 100);
  const sourceType = sources.some((id) => id) ? "material" : "topics";

  const { rows: examRows } = await pool.query(
    `INSERT INTO exams
            (user_id, title, subject, difficulty, question_count, source_type, topics)
     VALUES ($1, $2, $3, 'medium', $4, $5, $6::text[])
     RETURNING id`,
    [owner, title, subject, total, sourceType, topics],
  );
  const examId = examRows[0].id;

  const questionIds = [];
  for (let order = 1; order <= total; order += 1) {
    const { rows } = await pool.query(
      `INSERT INTO exam_questions
              (exam_id, user_id, question_order, question_type, question_text,
               options, correct_answer, explanation, source_material_id)
       VALUES ($1, $2, $3, 'multiple_choice', $4,
               '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
               'a', 'Because.', $5)
       RETURNING id`,
      [examId, owner, order, `Question ${order}?`, sources[order - 1] ?? null],
    );
    questionIds.push(rows[0].id);
  }

  const { rows: attemptRows } =
    status === "completed"
      ? await pool.query(
          `INSERT INTO exam_attempts
                  (exam_id, user_id, status, started_at, submitted_at, score,
                   total_questions, correct_answers, percentage, passed)
           VALUES ($1, $2, 'completed', $3::timestamptz - interval '15 minutes',
                   $3::timestamptz, $4, $5, $4, $6, $7)
           RETURNING id`,
          [
            examId,
            owner,
            nextSubmittedAt(),
            correct,
            total,
            percentage,
            percentage >= 60,
          ],
        )
      : await pool.query(
          `INSERT INTO exam_attempts (exam_id, user_id, status)
           VALUES ($1, $2, 'in_progress') RETURNING id`,
          [examId, owner],
        );

  for (const [index, isCorrect] of results.entries()) {
    await pool.query(
      `INSERT INTO attempt_answers
              (attempt_id, user_id, exam_question_id, selected_answer, is_correct)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attemptRows[0].id,
        owner,
        questionIds[index],
        isCorrect ? "a" : "b",
        isCorrect,
      ],
    );
  }

  return { examId, attemptId: attemptRows[0].id, percentage };
}


try {
  let ready = false;
  for (let tick = 0; tick < 100; tick++) {
    try { const health = await fetch(`${base}/health`); if (health.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'production server reaches healthy state');
  const a = await makeUser('smoke_a');
  const b = await makeUser('smoke_b');
  const empty = await makeUser('smoke_empty');
  const planA = await makePlan(a);
  await makePlan(a, { status: 'completed' });
  await makeTasks(planA, a, [{ status: 'completed' }, { status: 'pending' }]);
  const planB = await makePlan(b);
  await makeTasks(planB, b, [{ status: 'skipped' }]);
  await sitExam(a, { topics: ['Algebra'], results: [false, false, false] });
  await sitExam(a, { topics: ['Geometry'], results: [true, true, true] });
  await sitExam(b, { topics: ['Biology'], results: [true, false] });
  const summaryA = await request('/api/analytics', a);
  const summaryB = await request('/api/analytics', b);
  assert.equal(summaryA.body.studyPlans.total, 2);
  assert.equal(summaryA.body.tasks.completionPercentage, 50);
  assert.equal(summaryA.body.exams.averagePercentage, 50);
  assert.equal(summaryB.body.studyPlans.total, 1);
  assert.equal(summaryB.body.tasks.completed, 0);
  assert.equal((await request('/api/analytics', empty)).body.exams.attempts, 0);
  assert.deepEqual((await request('/api/analytics/topics', a)).body.map(r => r.topic), ['Algebra', 'Geometry']);
  assert.deepEqual((await request('/api/analytics/topics', b)).body.map(r => r.topic), ['Biology']);
  assert.deepEqual((await request('/api/analytics/weak-areas', a)).body.map(r => r.topic), ['Algebra']);
  assert.deepEqual((await request('/api/analytics/weak-areas', b)).body, []);
  assert.equal((await request('/api/analytics/exams', a)).body.length, 2);
  assert.equal((await request('/api/analytics/exams', b)).body.length, 1);
  assert.equal((await request(`/api/analytics/study-plans/${planA}`, a)).body.tasks.completionPercentage, 50);
  assert.equal((await request(`/api/analytics/study-plans/${planB}`, a)).status, 404);
  assert.equal((await request(`/api/analytics/study-plans/${planA}`, b)).status, 404);
  assert.equal((await request('/api/analytics/materials', a)).body[0].materialId, null);
  console.log('Production start, clean migrated PostgreSQL, two-user isolation, zero-data and all six analytics endpoints: PASS');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
  await pool.end();
  await database.drop();
}
