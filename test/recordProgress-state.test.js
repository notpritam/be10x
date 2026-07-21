// ABOUTME: recordProgress carries the hook-derived state machine (state/phase/stateStartedAt) onto the task
// ABOUTME: snapshot, preserving prior state + todos when an update doesn't restate them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createTask } from '../src/tasks/tasks.js';
import { createUser } from '../src/auth/users.js';
import { recordProgress } from '../src/worker/worker.js';

function seed() {
  const db = openDb(':memory:');
  const u = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw123456' });
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: u.id, content: { summary: 'x' } });
  return { db, taskId: t.id };
}
const snap = (db, id) => JSON.parse(db.prepare('SELECT agent_json FROM tasks WHERE id = ?').get(id).agent_json);

test('recordProgress persists state + phase + stateStartedAt', () => {
  const { db, taskId } = seed();
  recordProgress(db, taskId, { state: 'waiting', phase: 'plan', message: 'need input', todos: [{ text: 'a', status: 'pending' }] });
  const s = snap(db, taskId);
  assert.equal(s.state, 'waiting');
  assert.equal(s.phase, 'plan');
  assert.ok(s.stateStartedAt > 0);
  assert.equal(s.todos.length, 1);
});

test('a bare progress note preserves state, phase, stateStartedAt and todos', () => {
  const { db, taskId } = seed();
  recordProgress(db, taskId, { state: 'waiting', phase: 'plan', todos: [{ text: 'a', status: 'pending' }] });
  const started = snap(db, taskId).stateStartedAt;
  recordProgress(db, taskId, { message: 'still here' }); // no state/phase/todos
  const s = snap(db, taskId);
  assert.equal(s.state, 'waiting', 'state preserved on a bare note');
  assert.equal(s.phase, 'plan', 'phase preserved');
  assert.equal(s.stateStartedAt, started, 'stateStartedAt not reset when state unchanged');
  assert.equal(s.todos.length, 1, 'todos preserved');
  assert.equal(s.message, 'still here');
});

test('a state change moves stateStartedAt', () => {
  const { db, taskId } = seed();
  recordProgress(db, taskId, { state: 'waiting' });
  const first = snap(db, taskId).stateStartedAt;
  // ensure clock advances a hair
  const later = first + 5;
  recordProgress(db, taskId, { state: 'working', stateStartedAt: later });
  const s = snap(db, taskId);
  assert.equal(s.state, 'working');
  assert.equal(s.stateStartedAt, later);
});
