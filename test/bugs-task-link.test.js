// ABOUTME: Tests the TASK-side of bug↔task linking in src/bugs/bugs.js — listBugsForTask (all bugs linked to
// ABOUTME: a task, newest first) and unlinkBugFromTask (clears task_id + appends a bug_events 'unlink' row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { createBug, linkBugToTask, listBugsForTask, unlinkBugFromTask, listBugEvents, getBug } from '../src/bugs/bugs.js';

function seed() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@be10x.co', displayName: 'QA', password: 'pw123456' });
  const task = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Fix checkout', ownerId: user.id, content: { symptom: 'boom' } });
  const mk = (title) => createBug(db, { reporterId: user.id, pageUrl: 'https://app/x', title, severity: 'high' });
  return { db, user, task, mk };
}

test('listBugsForTask returns every bug linked to the task, newest first', () => {
  const { db, user, task, mk } = seed();
  const b1 = mk('first');
  const b2 = mk('second');
  const other = mk('unlinked'); // never linked → must not appear

  linkBugToTask(db, b1.id, task.id, user.id);
  linkBugToTask(db, b2.id, task.id, user.id);

  const linked = listBugsForTask(db, task.id);
  assert.equal(linked.length, 2);
  // Newest-first: b2 was linked/created after b1.
  assert.deepEqual(linked.map((b) => b.id), [b2.id, b1.id]);
  assert.equal(linked[0].taskId, task.id);
  assert.ok(!linked.some((b) => b.id === other.id));
});

test('unlinkBugFromTask clears task_id, appends an unlink event, and drops it from the list', () => {
  const { db, user, task, mk } = seed();
  const b1 = mk('one');
  const b2 = mk('two');
  linkBugToTask(db, b1.id, task.id, user.id);
  linkBugToTask(db, b2.id, task.id, user.id);
  assert.equal(listBugsForTask(db, task.id).length, 2);

  const updated = unlinkBugFromTask(db, b1.id, user.id);
  assert.equal(updated.taskId, null);
  assert.equal(getBug(db, b1.id).taskId, null);

  const remaining = listBugsForTask(db, task.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, b2.id);

  // The unlink is recorded on the bug timeline.
  const kinds = listBugEvents(db, b1.id).map((e) => e.kind);
  assert.ok(kinds.includes('unlink'), 'a bug_events unlink row exists');
});

test('unlinkBugFromTask throws NOT_FOUND for an unknown bug', () => {
  const { db, user } = seed();
  assert.throws(() => unlinkBugFromTask(db, 'nope', user.id), /NOT_FOUND/);
});
