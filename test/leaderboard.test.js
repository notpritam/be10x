// ABOUTME: The leaderboard aggregation (global + team scope) and its HTTP route — scope=all is
// ABOUTME: public, scope=team:<id> requires a session and membership in that team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';
import { createTask } from '../src/tasks/tasks.js';
import { createRun, finishRun } from '../src/executor/runs.js';
import { leaderboard, startOfCurrentMonthMs } from '../src/leaderboard/leaderboard.js';

function seed(db) {
  const alice = createUser(db, { email: 'alice@lb.co', displayName: 'Alice', password: 'pw12345' });
  const bob = createUser(db, { email: 'bob@lb.co', displayName: 'Bob', password: 'pw12345' });
  const carol = createUser(db, { email: 'carol@lb.co', displayName: 'Carol', password: 'pw12345' });

  const team = createTeam(db, { name: 'Alpha', createdBy: alice.id });
  addMember(db, { teamId: team.id, userId: bob.id, role: 'member' });
  // Carol is NOT on the team.

  // Alice: 2 done tasks. Bob: 1 done. Carol: 1 done (but not on the team).
  for (const [owner, count] of [[alice.id, 2], [bob.id, 1], [carol.id, 1]]) {
    for (let i = 0; i < count; i++) {
      const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: owner, content: { summary: 's' } });
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id);
      const run = createRun(db, { taskId: t.id });
      finishRun(db, run.id, { status: 'done', usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.001 } });
    }
  }
  return { alice, bob, carol, team };
}

test('leaderboard() ranks by tasks done (desc), everyone included when no teamId', () => {
  const db = openDb(':memory:');
  const { alice, bob, carol } = seed(db);
  const rows = leaderboard(db);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, alice.id, 'alice has the most done tasks, ranks first');
  assert.equal(rows[0].tasksDone, 2);
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    [alice.id, bob.id, carol.id].sort(),
  );
});

test('leaderboard({ teamId }) only includes that team\'s members', () => {
  const db = openDb(':memory:');
  const { alice, bob, carol, team } = seed(db);
  const rows = leaderboard(db, { teamId: team.id });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(alice.id));
  assert.ok(ids.includes(bob.id));
  assert.ok(!ids.includes(carol.id), 'carol is not on the team and must not appear in a team-scoped ranking');
  assert.equal(rows.length, 2);
});

test('startOfCurrentMonthMs returns the 1st of the given month at midnight, local time', () => {
  const ms = startOfCurrentMonthMs(new Date(2026, 6, 15, 13, 45)); // Jul 15 2026, 1:45pm
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6); // July (0-indexed)
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0);
});

test('leaderboard({ sinceMs }) only counts tasks done, and runs, within the window — but still lists an inactive-this-period user with zeros', () => {
  const db = openDb(':memory:');
  const { alice, bob, carol } = seed(db);
  const cutoff = Date.now() + 1000; // in the future relative to everything seed() just created
  const rows = leaderboard(db, { sinceMs: cutoff });
  assert.equal(rows.length, 3, 'everyone still appears, even with zero activity in the window');
  for (const r of rows) {
    assert.equal(r.tasksDone, 0);
    assert.equal(r.inputTokens, 0);
  }
  void alice;
  void bob;
  void carol;
});

test('leaderboard({ sinceMs }) counts activity that IS within the window', () => {
  const db = openDb(':memory:');
  const { alice } = seed(db);
  const cutoff = Date.now() - 1000; // in the past — everything seed() just created is "after" this
  const rows = leaderboard(db, { sinceMs: cutoff });
  const aliceRow = rows.find((r) => r.id === alice.id);
  assert.equal(aliceRow.tasksDone, 2);
  assert.ok(aliceRow.inputTokens > 0);
});

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base, db);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function api(base, method, path, { cookie, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

test('GET /api/leaderboard?scope=all needs no session', async () => {
  await withServer(async (base, db) => {
    seed(db);
    const res = await fetch(base + '/api/leaderboard');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.scope, 'all');
    assert.equal(json.period, 'all');
    assert.equal(json.rows.length, 3);
  });
});

test('GET /api/leaderboard?period=month scopes to the current month; an unrecognized period falls back to all-time', async () => {
  await withServer(async (base, db) => {
    const { alice } = seed(db);
    const month = await (await fetch(base + '/api/leaderboard?period=month')).json();
    assert.equal(month.period, 'month');
    assert.equal(month.rows.find((r) => r.id === alice.id).tasksDone, 2, 'seed() activity is "now", inside the current month');

    const bogus = await (await fetch(base + '/api/leaderboard?period=whenever')).json();
    assert.equal(bogus.period, 'all');
  });
});

test('GET /api/leaderboard?scope=team:<id> requires a session and membership; an outsider is forbidden', async () => {
  await withServer(async (base, db) => {
    const { team } = seed(db);
    const anon = await fetch(base + '/api/leaderboard?scope=team:' + team.id);
    assert.equal(anon.status, 401);

    const outsider = await api(base, 'POST', '/api/auth/signup', {
      body: { email: 'outsider@lb.co', displayName: 'O', password: 'pw12345' },
    });
    const forbidden = await api(base, 'GET', '/api/leaderboard?scope=team:' + team.id, { cookie: outsider.cookie });
    assert.equal(forbidden.status, 403);

    const aliceLogin = await api(base, 'POST', '/api/auth/login', { body: { email: 'alice@lb.co', password: 'pw12345' } });
    const allowed = await api(base, 'GET', '/api/leaderboard?scope=team:' + team.id, { cookie: aliceLogin.cookie });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.rows.length, 2);
  });
});
