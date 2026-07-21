// ABOUTME: The notifications feed core — per-user rows, seq-based `since` reads, unseen count, mark-seen,
// ABOUTME: and the "never notify yourself / no user" no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { notify, listNotificationsSince, listNotificationsForUser, unseenCount, markAllSeen } from '../src/notify/notify.js';

function seed() {
  const db = openDb(':memory:');
  const a = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw123456' });
  const b = createUser(db, { email: 'b@b.co', displayName: 'B', password: 'pw123456' });
  const task = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: a.id, content: { summary: 'x' } });
  return { db, a: a.id, b: b.id, taskId: task.id };
}

test('notify inserts a row for the user and returns it', () => {
  const { db, a, taskId } = seed();
  const n = notify(db, a, 'assigned', { taskId, title: 'GFA-1 assigned to you', body: 'Fix it' });
  assert.ok(n && n.id);
  assert.equal(n.kind, 'assigned');
  assert.equal(n.userId, a);
  assert.ok(n.seq > 0);
});

test('notify is a no-op for a null user or a self-action', () => {
  const { db, a } = seed();
  assert.equal(notify(db, null, 'assigned', { title: 'x' }), null);
  assert.equal(notify(db, a, 'assigned', { title: 'x', actorId: a }), null, 'do not notify yourself');
  assert.equal(unseenCount(db, a), 0);
});

test('listNotificationsSince returns only newer rows, per user, oldest→newest', () => {
  const { db, a, b } = seed();
  const n1 = notify(db, a, 'assigned', { title: 'one' });
  notify(db, b, 'assigned', { title: 'for-b' });
  const n2 = notify(db, a, 'review_requested', { title: 'two' });

  const all = listNotificationsSince(db, a, 0);
  assert.deepEqual(all.map((n) => n.title), ['one', 'two'], 'only A\'s, in order');
  const after1 = listNotificationsSince(db, a, n1.seq);
  assert.deepEqual(after1.map((n) => n.title), ['two']);
  assert.equal(listNotificationsSince(db, a, n2.seq).length, 0);
});

test('unseenCount + markAllSeen', () => {
  const { db, a } = seed();
  notify(db, a, 'assigned', { title: 'one' });
  notify(db, a, 'input_needed', { title: 'two' });
  assert.equal(unseenCount(db, a), 2);
  markAllSeen(db, a, 123456);
  assert.equal(unseenCount(db, a), 0);
  assert.equal(listNotificationsForUser(db, a)[0].title, 'two', 'newest first');
});
