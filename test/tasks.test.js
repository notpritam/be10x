import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import {
  createTask,
  getTask,
  listTasks,
  setResearch,
  setPlan,
  updateContent,
  transition,
  retryTask,
} from '../src/tasks/tasks.js';
import { listEvents } from '../src/tasks/events.js';

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

test('setPlan and setResearch attach data and log events; replan overwrites', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  setResearch(db, t.id, { confidence: 'high' }, uid);
  setPlan(db, t.id, { steps: ['a'] }, uid);
  const replanned = setPlan(db, t.id, { steps: ['a', 'b'] }, uid);
  assert.deepEqual(replanned.plan, { steps: ['a', 'b'] });
  assert.deepEqual(replanned.research, { confidence: 'high' });
  const kinds = listEvents(db, t.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'research', 'plan', 'plan']);
});

test('updateContent merges into existing content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  const u = updateContent(db, t.id, { rootCause: 'race' }, uid);
  assert.deepEqual(u.content, { symptom: 'x', rootCause: 'race' });
});

test('transition enforces the state machine and logs from/to', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  const moved = transition(db, t.id, 'researching', uid);
  assert.equal(moved.status, 'researching');
  assert.throws(() => transition(db, t.id, 'done', uid), /ILLEGAL_TRANSITION/);
  const last = listEvents(db, t.id).at(-1);
  assert.deepEqual([last.kind, last.payload.from, last.payload.to], ['status', 'backlog', 'researching']);
});

test('retryTask increments the retry counter', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  assert.equal(retryTask(db, t.id, uid).retryCount, 1);
  assert.equal(retryTask(db, t.id, uid).retryCount, 2);
});
