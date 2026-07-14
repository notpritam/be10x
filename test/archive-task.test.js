import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, archiveTask, transition } from '../src/tasks/tasks.js';
import { createRun, listRunWorktrees } from '../src/executor/runs.js';
import { listEvents } from '../src/tasks/events.js';

function seed() {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const task = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  return { db, uid, task };
}

test('archiveTask soft-archives the row, appends an archived event, and returns the run worktrees', () => {
  const { db, uid, task } = seed();
  createRun(db, {
    taskId: task.id,
    worktreePath: '/repo/.be10x/worktrees/be10x__GFA-1-idea',
    branch: 'be10x/GFA-1-idea',
    baseRef: 'main',
  });

  const { task: archived, worktrees } = archiveTask(db, task.id, uid);

  // Row is kept (still fetchable) but flipped to archived, with updated_at bumped.
  assert.equal(archived.status, 'archived');
  assert.equal(getTask(db, task.id).status, 'archived');
  assert.ok(archived.updatedAt >= task.updatedAt);

  // An 'archived' event is on the trail, recording the state it came from.
  const events = listEvents(db, task.id);
  const arch = events.filter((e) => e.kind === 'archived');
  assert.equal(arch.length, 1);
  assert.equal(arch[0].payload.from, 'backlog');

  // The real worktree path + branch (from the run row) travel back so a caller/connector can GC.
  assert.deepEqual(worktrees, [{ path: '/repo/.be10x/worktrees/be10x__GFA-1-idea', branch: 'be10x/GFA-1-idea' }]);
});

test('archiveTask works from any stage', () => {
  const { db, uid, task } = seed();
  transition(db, task.id, 'researching', uid);
  transition(db, task.id, 'plan_review', uid);
  const { task: archived } = archiveTask(db, task.id, uid);
  assert.equal(archived.status, 'archived');
  assert.equal(listEvents(db, task.id).filter((e) => e.kind === 'archived')[0].payload.from, 'plan_review');
});

test('archiveTask is idempotent: re-archiving is a no-op success with no duplicate event', () => {
  const { db, uid, task } = seed();
  createRun(db, { taskId: task.id, worktreePath: '/repo/.be10x/worktrees/w', branch: 'b' });

  const first = archiveTask(db, task.id, uid);
  const second = archiveTask(db, task.id, uid);

  assert.equal(second.task.status, 'archived');
  // Only ONE archived event across both calls.
  assert.equal(listEvents(db, task.id).filter((e) => e.kind === 'archived').length, 1);
  // The worktrees are still reported on the idempotent re-run so a retried GC still has its targets.
  assert.deepEqual(second.worktrees, first.worktrees);
});

test('archiveTask returns DISTINCT worktrees and ignores runs with no path', () => {
  const { db, uid, task } = seed();
  // Two runs sharing one worktree + one run on a different worktree + a path-less (plan-only) run.
  createRun(db, { taskId: task.id, worktreePath: '/repo/.be10x/worktrees/a', branch: 'be10x/a' });
  createRun(db, { taskId: task.id, worktreePath: '/repo/.be10x/worktrees/a', branch: 'be10x/a' });
  createRun(db, { taskId: task.id, worktreePath: '/repo/.be10x/worktrees/b', branch: 'be10x/b' });
  createRun(db, { taskId: task.id });

  const wts = listRunWorktrees(db, task.id);
  assert.deepEqual(wts, [
    { path: '/repo/.be10x/worktrees/a', branch: 'be10x/a' },
    { path: '/repo/.be10x/worktrees/b', branch: 'be10x/b' },
  ]);

  const { worktrees } = archiveTask(db, task.id, uid);
  assert.deepEqual(worktrees, wts);
});

test('archiveTask throws NO_TASK for an unknown id', () => {
  const { db, uid } = seed();
  assert.throws(() => archiveTask(db, 'nope', uid), /NO_TASK/);
});
