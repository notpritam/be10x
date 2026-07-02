import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, transition } from '../src/tasks/tasks.js';
import { claimNextReadyTask, recordProgress } from '../src/worker/worker.js';

function ready(db, uid, type, content) {
  const t = createTask(db, { type, scope: 'personal', title: 'T', ownerId: uid, content });
  for (const s of ['researching', 'plan_review', 'ready_to_work']) transition(db, t.id, s, uid);
  return t.id;
}

test('claimNextReadyTask claims an agent-executable task and flips it to in_progress', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const codeId = ready(db, uid, 'code-issue', { symptom: 'x' });
  const claimed = claimNextReadyTask(db, 'w1');
  assert.equal(claimed.id, codeId);
  assert.equal(claimed.status, 'in_progress');
});

test('claimNextReadyTask skips non-agent-executable types and returns null when none remain', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const generalId = ready(db, uid, 'general', { summary: 's' });
  assert.equal(claimNextReadyTask(db, 'w1'), null);
  assert.equal(getTask(db, generalId).status, 'ready_to_work');
});

test('a claimed task is not claimed again (atomic claim)', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  ready(db, uid, 'code-issue', { symptom: 'x' });
  assert.notEqual(claimNextReadyTask(db, 'w1'), null);
  assert.equal(claimNextReadyTask(db, 'w2'), null);
});

test('recordProgress writes the agent status block and logs a progress event', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  ready(db, uid, 'code-issue', { symptom: 'x' });
  const claimed = claimNextReadyTask(db, 'w1');
  const t = recordProgress(db, claimed.id, { step: 'writing the failing test', message: 'go', changes: { files: ['a.js'] } });
  assert.equal(t.agent.step, 'writing the failing test');
  assert.deepEqual(t.agent.changes, { files: ['a.js'] });
});

test('recordProgress preserves the todo list (and changes) across a note that omits them', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  ready(db, uid, 'code-issue', { symptom: 'x' });
  const claimed = claimNextReadyTask(db, 'w1');

  // The agent reports its implementation checklist.
  const todos = [
    { text: 'write the test', status: 'done' },
    { text: 'implement', status: 'in_progress' },
  ];
  recordProgress(db, claimed.id, { step: 'plan', message: 'broke down the work', todos, changes: { files: ['a.js'] } });

  // A later plain progress note (executor stream / runner) carries NO todos — they must NOT be wiped.
  const t = recordProgress(db, claimed.id, { state: 'working', step: 'agent', message: 'editing a.js' });
  assert.deepEqual(t.agent.todos, todos, 'the checklist survives a progress note without todos');
  assert.deepEqual(t.agent.changes, { files: ['a.js'] }, 'changes survive too');
  assert.equal(t.agent.step, 'agent');

  // An explicit new list DOES replace the old one.
  const t2 = recordProgress(db, claimed.id, { step: 'done', message: 'shipped', todos: [{ text: 'implement', status: 'done' }] });
  assert.equal(t2.agent.todos.length, 1);
  assert.equal(t2.agent.todos[0].status, 'done');
});
