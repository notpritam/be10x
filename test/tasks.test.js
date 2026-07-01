import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, listTasks } from '../src/tasks/tasks.js';

function owner(db) {
  return createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
}

test('createTask starts in backlog with a GFA human id and parsed content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  assert.equal(t.status, 'backlog');
  assert.match(t.humanId, /^GFA-\d{3}$/);
  assert.deepEqual(t.content, { summary: 's' });
  assert.equal(t.plan, null);
  assert.equal(getTask(db, t.id).title, 'Idea');
});

test('createTask rejects unknown type and missing required content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  assert.throws(() => createTask(db, { type: 'nope', scope: 'personal', title: 'x', ownerId: uid }), /UNKNOWN_TYPE/);
  assert.throws(
    () => createTask(db, { type: 'code-issue', scope: 'personal', title: 'x', ownerId: uid, content: {} }),
    /MISSING_FIELD:symptom/
  );
});

test('human ids increment', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const a = createTask(db, { type: 'general', scope: 'personal', title: 'A', ownerId: uid, content: { summary: 's' } });
  const b = createTask(db, { type: 'general', scope: 'personal', title: 'B', ownerId: uid, content: { summary: 's' } });
  assert.equal(a.humanId, 'GFA-001');
  assert.equal(b.humanId, 'GFA-002');
});

test('listTasks filters by status', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  createTask(db, { type: 'general', scope: 'personal', title: 'A', ownerId: uid, content: { summary: 's' } });
  assert.equal(listTasks(db, { status: 'backlog' }).length, 1);
  assert.equal(listTasks(db, { status: 'done' }).length, 0);
});
