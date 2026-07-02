import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { getTask } from '../src/tasks/tasks.js';
import { addComment, unseenComments } from '../src/tasks/comments.js';
import { enqueueWake, listPendingWakes } from '../src/executor/wake.js';
import { createRun, getRun, markRunning, setRunPid } from '../src/executor/runs.js';
import { registerProject } from '../src/projects/projects.js';
import { runWakeOnce, runAnyWakeOnce, recoverOrphans, prepareWake, settleWake } from '../src/runner/runner.js';
import { claimNextWake } from '../src/executor/wake.js';

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
  // The scheduler no longer forces a resume flag — the executor owns resume-vs-fresh per mode
  // (plan is always fresh). See src/executor/executor.js FRESH_MODES.
  assert.equal(exec.calls[0].opts.resume, undefined);
  assert.equal(r.summary.done, true);
});

test('an execute wake claims ready_to_work→in_progress and, on success, hands off to verifying', async () => {
  const { db, mk } = seed();
  mk('t1', 'ready_to_work');
  enqueueWake(db, 't1', 'execute');
  const exec = fakeExec();

  await runWakeOnce(db, { projectId: 'p1', execute: exec });

  assert.equal(exec.calls[0].opts.mode, 'execute');
  // Execute is a FRESH session (clean hand-off from the plan, not the planning transcript); the
  // scheduler no longer forces resume — the executor owns that. See executor.js FRESH_MODES.
  assert.equal(exec.calls[0].opts.resume, undefined);
  assert.equal(getTask(db, 't1').status, 'verifying');
  // A successful build hands off to a fresh self-verify pass against the plan.
  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'verify');
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

test('runAnyWakeOnce claims across the board and runs in the task\'s own project', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  const project = registerProject(db, { key: 'local:x', name: 'x', rootPath: '/repo/x', defaultBranch: 'main' });
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('t1', 't1', 'code-issue', 'project', project.id, 'u1', 'T', 'backlog', now, now);
  enqueueWake(db, 't1', 'plan');

  const calls = [];
  const makeExecutor = (proj) => async (task, opts) => {
    calls.push({ proj, task, opts });
    return { done: true };
  };
  await runAnyWakeOnce(db, { makeExecutor });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].proj.id, project.id);
  assert.equal(calls[0].proj.rootPath, '/repo/x'); // ran in the task's own repo
  assert.equal(getTask(db, 't1').status, 'researching');
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

test('recoverOrphans: live sweep reaps a dead-pid run but spares a mid-spawn (pid-less) run', () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  mk('t2', 'in_progress');

  // A run that recorded a pid which is now gone → a live sweep reaps it (false "running" self-corrects).
  const dead = createRun(db, { taskId: 't1' });
  markRunning(db, dead.id);
  setRunPid(db, dead.id, 2 ** 30); // a pid that isn't a running process → ESRCH → treated as dead
  // A freshly-created run with no pid yet (createRun sets status before the spawn records a pid).
  const newborn = createRun(db, { taskId: 't2' });

  // Live sweep: reap the dead one, spare the newborn (or we'd kill our own just-spawned run).
  assert.equal(recoverOrphans(db, { requirePid: true }), 1);
  assert.equal(getRun(db, dead.id).status, 'failed');
  assert.equal(getRun(db, newborn.id).status, 'starting');

  // Boot recovery (no requirePid): the pid-less leftover from a dead process IS reaped.
  assert.equal(recoverOrphans(db), 1);
  assert.equal(getRun(db, newborn.id).status, 'failed');
});

// An executor that reports a run-level failure of a given kind (mirrors the real executor resolving with
// ok:false rather than throwing).
function failExec(failureKind) {
  const calls = [];
  const fn = async (task, opts) => {
    calls.push({ task, opts });
    return { ok: false, done: false, failureKind, error: `simulated ${failureKind} failure` };
  };
  fn.calls = calls;
  return fn;
}

test('durability: a transient (network) run failure auto-retries with a backoff wake, keeping comments unseen', async () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  addComment(db, 't1', { author: 'u1', body: 'steer me' });
  enqueueWake(db, 't1', 'execute');

  await runWakeOnce(db, { projectId: 'p1', execute: failExec('network') });

  // A retry wake is queued (same reason, marked retry, attempt 1), scheduled a backoff out.
  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'execute');
  assert.equal(pending[0].context.retry, true);
  assert.equal(pending[0].context.attempt, 1);
  // The comment stays UNSEEN so the retry re-delivers it (the failed run never acted on it).
  assert.equal(unseenComments(db, 't1').length, 1);
});

test('durability: a genuine error (kind other) does NOT auto-retry', async () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  enqueueWake(db, 't1', 'execute');

  await runWakeOnce(db, { projectId: 'p1', execute: failExec('other') });
  assert.equal(listPendingWakes(db, 't1').length, 0);
});

test('durability: exhausting retries stops re-queuing and surfaces a clear give-up', async () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  // A network wake already at the cap; failing it once more (attempt 7 > max 6) must NOT enqueue another.
  enqueueWake(db, 't1', 'execute', { retry: true, attempt: 6 });
  await runWakeOnce(db, { projectId: 'p1', execute: failExec('network') });
  assert.equal(listPendingWakes(db, 't1').length, 0);
  assert.equal(getTask(db, 't1').agent.state, 'blocked');
});

test('durability: recoverOrphans({ rewake:true }) re-enqueues a resume wake for an active task', () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  const run = createRun(db, { taskId: 't1' });
  markRunning(db, run.id);

  assert.equal(recoverOrphans(db, { rewake: true }), 1);

  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'pick_up_now');
  assert.equal(pending[0].context.orphanRecovery, true);
});

test('durability: recoverOrphans({ rewake:true }) does NOT resume a done/terminal task', () => {
  const { db, mk } = seed();
  mk('t1', 'done');
  const run = createRun(db, { taskId: 't1' });
  markRunning(db, run.id);
  assert.equal(recoverOrphans(db, { rewake: true }), 1);
  assert.equal(listPendingWakes(db, 't1').length, 0);
});

// prepareWake + settleWake are the split halves driveWake now composes, AND the shared contract the
// board's HTTP claim/report endpoints reuse (the agent runs on a member's machine in between). These
// exercise them directly the way the endpoints will — claim (prepare) here, run elsewhere, report (settle).

test('prepareWake claims the lifecycle and returns the mode + delta the way the board claim endpoint will', () => {
  const { db, mk } = seed();
  mk('t1', 'ready_to_work');
  addComment(db, 't1', { author: 'u1', body: 'steer' });
  enqueueWake(db, 't1', 'execute');
  const claimed = claimNextWake(db, { projectId: 'p1' });

  const { mode, staged, comments } = prepareWake(db, { wake: claimed, task: getTask(db, 't1') });

  assert.equal(mode, 'execute');
  assert.equal(staged.status, 'in_progress'); // pre-transition happened
  assert.equal(comments.length, 1);
  assert.equal(unseenComments(db, 't1').length, 1); // NOT marked seen yet (a failed run must re-deliver)
});

test('settleWake with id-stub comments (as the board report endpoint passes) marks exactly those seen and hands execute→verifying', () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  const c = addComment(db, 't1', { author: 'u1', body: 'delivered' });
  enqueueWake(db, 't1', 'execute');
  const wake = claimNextWake(db, { projectId: 'p1' }); // the board claims the wake before the run

  // The report endpoint reconstructs comments from the claimed ids as { id } stubs (no bodies over the wire).
  const res = settleWake(db, {
    wake,
    task: getTask(db, 't1'),
    mode: 'execute',
    comments: [{ id: c.id }],
    summary: { done: true, mode: 'execute' },
  });

  assert.equal(getTask(db, 't1').status, 'verifying');
  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'verify');
  assert.equal(unseenComments(db, 't1').length, 0); // the delivered comment was consumed
  assert.ok(res.summary.done);
});

test('settleWake auto-retries a network failure and keeps the delivered comments unseen for re-delivery', () => {
  const { db, mk } = seed();
  mk('t1', 'in_progress');
  const c = addComment(db, 't1', { author: 'u1', body: 'still needed on retry' });
  enqueueWake(db, 't1', 'execute');
  const wake = claimNextWake(db, { projectId: 'p1' }); // the board claims the wake before the run

  const res = settleWake(db, {
    wake,
    task: getTask(db, 't1'),
    mode: 'execute',
    comments: [{ id: c.id }],
    summary: { ok: false, failureKind: 'network', error: 'ECONNRESET', mode: 'execute' },
  });

  assert.equal(res.retrying.kind, 'network');
  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].context.retry, true);
  assert.equal(unseenComments(db, 't1').length, 1); // the retry must re-deliver it
});
