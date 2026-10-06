import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';

const root = new URL('../../src/analytics/', import.meta.url);
const files = (await readdir(root)).filter(name => name.endsWith('.js'));
const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const sources = Object.fromEntries(await Promise.all(files.map(async name => [name, strip(await readFile(new URL(name, root), 'utf8'))])));
const repository = sources['analytics.repository.js'];

describe('SP-V2-007 architecture', () => {
  it('keeps SQL and database access exclusively in the repository', () => {
    assert.ok(files.length >= 6);
    assert.match(repository, /import.*query.*database/);
    assert.match(repository, /SELECT/);
    for (const [name, source] of Object.entries(sources)) {
      if (name === 'analytics.repository.js') continue;
      assert.doesNotMatch(source, /\bSELECT\b|\bJOIN\b|config\/database|from\s+["']pg["']/);
    }
  });
  it('has no source writes, AI, retrieval, grading or background infrastructure', () => {
    for (const source of Object.values(sources)) {
      assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|UPSERT|ALTER|CREATE)\b|withTransaction|gemini|@google|embedding|vector|gradeAttempt|grader\.js|redis|bullmq|sqlite/i);
    }
    assert.match(repository, /aa\.is_correct/);
    assert.match(repository, /AVG\(percentage\)/);
    assert.doesNotMatch(repository, /correct_answer\b|selected_answer\b/);
  });
  it('scopes every SQL statement to its bound owner', () => {
    const queries = [...repository.matchAll(/`([\s\S]*?)`/g)].map(match => match[1]);
    assert.equal(queries.length, 10);
    for (const query of queries) {
      assert.match(query, /WHERE[\s\S]*user_id = \$[12]/);
      assert.doesNotMatch(query, /\$\{/);
    }
  });
  it('exposes explicit DTOs and GET-only routes', () => {
    const dto = sources['analytics.serializers.js'];
    assert.match(dto, /toOverviewShape/);
    assert.match(dto, /toHistoryShape/);
    assert.doesNotMatch(dto, /\.\.\.row\b/);
    assert.equal((sources['analytics.routes.js'].match(/analyticsRoutes\.get\(/g) || []).length, 6);
    assert.doesNotMatch(sources['analytics.routes.js'], /analyticsRoutes\.(post|put|patch|delete)/);
  });
  it('introduces no SQLite, Redis, queue or worker dependency', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.doesNotMatch(JSON.stringify(pkg.dependencies), /sqlite|redis|bull|queue|worker/i);
  });
});
