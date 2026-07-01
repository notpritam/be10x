import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, transition, getTask } from '../src/tasks/tasks.js';
import { registerProject } from '../src/projects/projects.js';
import { claimNextForProject, runOnce } from '../src/runner/runner.js';

function seed() {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const projA = registerProject(db, { key: 'local:a', name: 'A' });
  const projB = registerProject(db, { key: 'local:b', name: 'B' });
  return { db, uid, projA, projB };
}

// createTask supports projectId directly; backlog -> ready_to_work is a legal direct transition.
function readyTask(db, uid, projectId, content = { symptom: 'x' }) {
  const t = createTask(db, { type: 'code-issue', scope: 'project', title: 'T', ownerId: uid, content, projectId });
  transition(db, t.id, 'ready_to_work', uid);
  return t.id;
}

test('claimNextForProject claims the project ready task and flips it to in_progress', () => {
  const { db, uid, projA } = seed();
  const id = readyTask(db, uid, projA.id);
  const claimed = claimNextForProject(db, projA.id, 'runner');
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, 'in_progress');
  assert.equal(getTask(db, id).status, 'in_progress');
});

test('claimNextForProject does not claim a task from a different project', () => {
  const { db, uid, projA, projB } = seed();
  const bId = readyTask(db, uid, projB.id);
  assert.equal(claimNextForProject(db, projA.id, 'runner'), null);
  assert.equal(getTask(db, bId).status, 'ready_to_work'); // untouched
});

test('runOnce claims, runs the injected executor, and returns the task', async () => {
  const { db, uid, projA } = seed();
  const id = readyTask(db, uid, projA.id);
  let ranWith = null;
  const task = await runOnce(db, { projectId: projA.id, workerId: 'runner', execute: (t) => { ranWith = t.id; } });
  assert.equal(ranWith, id);
  assert.equal(task.id, id);
  assert.equal(getTask(db, id).status, 'in_progress');
});

test('runOnce returns null when nothing is ready in the project', async () => {
  const { db, projA } = seed();
  assert.equal(await runOnce(db, { projectId: projA.id }), null);
});
