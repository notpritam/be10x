import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { getTask } from '../src/tasks/tasks.js';
import { addComment, unseenComments } from '../src/tasks/comments.js';
import { enqueueWake } from '../src/executor/wake.js';
import { createRun, getRun, markRunning } from '../src/executor/runs.js';
import { runWakeOnce, recoverOrphans } from '../src/runner/runner.js';

function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  const mk = (id, status) =>
    db
      .prepare(
        'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(id, id, 'code-issue', 'project', 'p1', 'u1', 'T', status, now, now);
  return { db, mk };
}

// A fake executor that records how it was invoked and returns a configurable summary.
function fakeExec(summary = { done: true, sessionId: 's', runId: 'r' }) {
  const calls = [];
  const fn = async (task, opts) => {
    calls.push({ task, opts });
    return { ...summary };
  };
  fn.calls = calls;
  return fn;
}

test('a plan wake advances backlog→researching and runs the agent fresh in plan mode', async () => {
  const { db, mk } = seed();
  mk('t1', 'backlog');
  enqueueWake(db, 't1', 'plan');
  const exec = fakeExec();

  const r = await runWakeOnce(db, { projectId: 'p1', execute: exec });

  assert.equal(getTask(db, 't1').status, 'researching');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].opts.mode, 'plan');
  assert.equal(exec.calls[0].opts.resume, false);
  assert.equal(r.summary.done, true);
});

test('an execute wake claims ready_to_work→in_progress and, on success, hands off to verifying', async () => {
  const { db, mk } = seed();
  mk('t1', 'ready_to_work');
  enqueueWake(db, 't1', 'execute');
  const exec = fakeExec();

  await runWakeOnce(db, { projectId: 'p1', execute: exec });

  assert.equal(exec.calls[0].opts.mode, 'execute');
  assert.equal(exec.calls[0].opts.resume, true);
  assert.equal(getTask(db, 't1').status, 'verifying');
});

test('a revise wake delivers unseen comments and marks them seen (delta-only next time)', async () => {
  const { db, mk } = seed();
  mk('t1', 'plan_review');
  addComment(db, 't1', { author: 'u1', body: 'c1' });
  addComment(db, 't1', { author: 'u1', body: 'c2' });
  enqueueWake(db, 't1', 'revise', { verdict: 'changes_requested' });
  const exec = fakeExec();

  await runWakeOnce(db, { projectId: 'p1', execute: exec });

  assert.equal(exec.calls[0].opts.mode, 'revise');
  assert.equal(exec.calls[0].opts.comments.length, 2);
  assert.deepEqual(exec.calls[0].opts.wakeContext, { verdict: 'changes_requested' });
  assert.equal(unseenComments(db, 't1').length, 0);
});

test('pick_up_now is contextual — revise while in plan_review', async () => {
  const { db, mk } = seed();
  mk('t1', 'plan_review');
  enqueueWake(db, 't1', 'pick_up_now');
  const exec = fakeExec();
  await runWakeOnce(db, { projectId: 'p1', execute: exec });
  assert.equal(exec.calls[0].opts.mode, 'revise');
});

test('a failing run records blocked and never throws', async () => {
  const { db, mk } = seed();
  mk('t1', 'researching');
  enqueueWake(db, 't1', 'plan');
  const boom = async () => {
    throw new Error('kaboom');
  };
  const r = await runWakeOnce(db, { projectId: 'p1', execute: boom });
  assert.match(String(r.error), /kaboom/);
  assert.equal(getTask(db, 't1').agent.state, 'blocked');
});

test('recoverOrphans fails runs left running at restart; empty queue returns null', async () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  const run = createRun(db, { taskId: 't1' });
  markRunning(db, run.id);
  assert.equal(recoverOrphans(db), 1);
  assert.equal(getRun(db, run.id).status, 'failed');
  assert.equal(await runWakeOnce(db, { projectId: 'p1', execute: fakeExec() }), null);
});
