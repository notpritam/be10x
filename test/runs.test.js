import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import {
  createRun,
  getRun,
  getLatestRunForTask,
  listRunsForTask,
  setRunSession,
  setRunPid,
  markRunning,
  finishRun,
} from '../src/executor/runs.js';

// Build an in-memory db with one user + one task so the runs FK (task_id -> tasks) is satisfiable.
function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('u1', 'a@b.dev', 'A', 'x', now);
  db.prepare(
    'INSERT INTO tasks (id, human_id, type, scope, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('t1', 'GFA-1', 'code-issue', 'personal', 'u1', 'Fix it', 'in_progress', now, now);
  return db;
}

test('createRun opens a run in starting state with the worktree recorded', () => {
  const db = seed();
  const run = createRun(db, {
    taskId: 't1',
    projectId: 'p1',
    worktreePath: '/repo/.be10x/worktrees/be10x__GFA-1-fix-it',
    branch: 'be10x/GFA-1-fix-it',
    baseRef: 'main',
  });
  assert.equal(run.status, 'starting');
  assert.equal(run.taskId, 't1');
  assert.equal(run.projectId, 'p1');
  assert.equal(run.branch, 'be10x/GFA-1-fix-it');
  assert.equal(run.sessionId, null);
  assert.equal(run.pid, null);
  assert.equal(run.result, null);
  assert.ok(run.id && run.createdAt);
  assert.deepEqual(getRun(db, run.id), run);
});

test('getLatestRunForTask returns the newest run; listRunsForTask is oldest-first', () => {
  const db = seed();
  const first = createRun(db, { taskId: 't1', branch: 'b1' });
  const second = createRun(db, { taskId: 't1', branch: 'b2' });
  assert.equal(getLatestRunForTask(db, 't1').id, second.id);
  const all = listRunsForTask(db, 't1');
  assert.deepEqual(
    all.map((r) => r.id),
    [first.id, second.id]
  );
  assert.equal(getLatestRunForTask(db, 'nope'), null);
});

test('setRunSession and setRunPid persist', () => {
  const db = seed();
  const run = createRun(db, { taskId: 't1' });
  assert.equal(setRunSession(db, run.id, 'sess-abc').sessionId, 'sess-abc');
  assert.equal(setRunPid(db, run.id, 4321).pid, 4321);
  const fresh = getRun(db, run.id);
  assert.equal(fresh.sessionId, 'sess-abc');
  assert.equal(fresh.pid, 4321);
});

test('markRunning stamps started_at once and does not overwrite it', () => {
  const db = seed();
  const run = createRun(db, { taskId: 't1' });
  const running = markRunning(db, run.id);
  assert.equal(running.status, 'running');
  assert.ok(running.startedAt);
  const again = markRunning(db, run.id);
  assert.equal(again.startedAt, running.startedAt); // unchanged on re-entry
});

test('finishRun closes the run and round-trips the result; bad status throws', () => {
  const db = seed();
  const run = createRun(db, { taskId: 't1' });
  const done = finishRun(db, run.id, { status: 'done', result: { ok: true, sessionId: 's1' } });
  assert.equal(done.status, 'done');
  assert.ok(done.endedAt);
  assert.deepEqual(done.result, { ok: true, sessionId: 's1' });

  const failed = finishRun(db, run.id, { status: 'failed', error: new Error('boom') });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /boom/);

  assert.throws(() => finishRun(db, run.id, { status: 'weird' }), /done\|failed/);
});
