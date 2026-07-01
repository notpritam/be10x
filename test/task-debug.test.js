// ABOUTME: Tests the consolidated debug snapshot (src/tasks/debug.js) — the blob behind the debug button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { enqueueWake } from '../src/executor/wake.js';
import { createRun } from '../src/executor/runs.js';
import { recordProgress } from '../src/worker/worker.js';
import { taskDebug } from '../src/tasks/debug.js';

function seed() {
  const db = openDb(':memory:');
  const owner = createUser(db, { email: 'o@be10x.co', displayName: 'O', password: 'pw123456' });
  const task = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: owner.id, content: { symptom: 'x' } });
  return { db, owner, task };
}

test('taskDebug returns a consolidated snapshot: task, agent, runs, wakes, events, server clock', () => {
  const { db, task } = seed();
  createRun(db, { taskId: task.id, branch: 'be10x/GFA-x' });
  recordProgress(db, task.id, { state: 'working', step: 'agent', message: 'reading routing code' }, 'runner');
  enqueueWake(db, task.id, 'revise', { note: 'address feedback' });

  const dbg = taskDebug(db, task.id);
  assert.equal(dbg.task.id, task.id);
  assert.equal(typeof dbg.now, 'number');

  // Live agent status is surfaced with its timestamp (the "last update Xs ago" signal).
  assert.equal(dbg.agent.state, 'working');
  assert.equal(dbg.agent.message, 'reading routing code');
  assert.equal(typeof dbg.agent.updatedAt, 'number');

  // The run row is present.
  assert.equal(dbg.runs.length, 1);
  assert.equal(dbg.runs[0].branch, 'be10x/GFA-x');

  // The wake queue explains movement: a pending (unclaimed) wake.
  assert.equal(dbg.wakes.length, 1);
  assert.equal(dbg.wakes[0].reason, 'revise');
  assert.equal(dbg.wakes[0].pending, true);
  assert.deepEqual(dbg.wakes[0].context, { note: 'address feedback' });

  // Events are newest-first for the debug view.
  assert.ok(dbg.events.length >= 1);
  assert.equal(dbg.events[0].kind, 'progress');
});

test('taskDebug returns null for an unknown task', () => {
  const { db } = seed();
  assert.equal(taskDebug(db, 'nope'), null);
});
