// ABOUTME: The four lifecycle chokepoints emit a notification to the person who must act — and never to the
// ABOUTME: actor themselves: assign → assignee, review request → reviewer, input → assignee/owner, changes → owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, setTaskAssignee } from '../src/tasks/tasks.js';
import { requestInput } from '../src/tasks/input_requests.js';
import { requestReview, submitReview } from '../src/reviews/reviews.js';
import { listNotificationsSince } from '../src/notify/notify.js';

function seed() {
  const db = openDb(':memory:');
  const a = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw123456' });
  const b = createUser(db, { email: 'b@b.co', displayName: 'B', password: 'pw123456' });
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: a.id, content: { summary: 'x' } });
  const setStatus = (s) => db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(s, t.id);
  const feed = (uid) => listNotificationsSince(db, uid, 0);
  return { db, a: a.id, b: b.id, taskId: t.id, setStatus, feed };
}

test('assigning a task notifies the assignee (not the actor)', () => {
  const { db, a, b, taskId, feed } = seed();
  setTaskAssignee(db, taskId, b, a); // A assigns to B
  const bn = feed(b);
  assert.equal(bn.length, 1);
  assert.equal(bn[0].kind, 'assigned');
  assert.equal(bn[0].taskId, taskId);
  // self-assign notifies nobody
  setTaskAssignee(db, taskId, a, a);
  assert.equal(feed(a).length, 0);
});

test('requesting review notifies the reviewer', () => {
  const { db, a, b, taskId, setStatus, feed } = seed();
  setStatus('researching');
  requestReview(db, taskId, b, a); // A tags B as reviewer
  const bn = feed(b);
  assert.equal(bn.length, 1);
  assert.equal(bn[0].kind, 'review_requested');
});

test('requesting input notifies the assignee (or owner)', () => {
  const { db, a, taskId, setStatus, feed } = seed();
  setStatus('in_progress');
  requestInput(db, taskId, 'Which DB — postgres or sqlite?', {}, 'agent'); // agent asks; owner A must answer
  const an = feed(a);
  assert.equal(an.length, 1);
  assert.equal(an[0].kind, 'input_needed');
  assert.match(an[0].body, /postgres/);
});

test('requesting changes notifies the task owner', () => {
  const { db, a, b, taskId, setStatus, feed } = seed();
  setStatus('plan_review');
  submitReview(db, taskId, b, 'changes_requested', 'tighten step 2'); // B reviews A's task
  const an = feed(a);
  assert.equal(an.length, 1);
  assert.equal(an[0].kind, 'changes_requested');
  assert.match(an[0].body, /tighten/);
});
