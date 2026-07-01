import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, transition } from '../src/tasks/tasks.js';
import { requestReview, submitReview, listReviews } from '../src/reviews/reviews.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const reviewer = createUser(db, { email: 'r@b.co', displayName: 'R', password: 'pw12345' }).id;
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: owner, content: { symptom: 'x' } });
  transition(db, t.id, 'researching', owner);
  return { owner, reviewer, taskId: t.id };
}

test('requestReview tags a reviewer and moves the task to plan_review', () => {
  const db = openDb(':memory:');
  const { owner, reviewer, taskId } = seed(db);
  const t = requestReview(db, taskId, reviewer, owner);
  assert.equal(t.status, 'plan_review');
  assert.equal(t.reviewerId, reviewer);
});

test('approve moves the task to ready_to_work and records the review', () => {
  const db = openDb(':memory:');
  const { owner, reviewer, taskId } = seed(db);
  requestReview(db, taskId, reviewer, owner);
  const r = submitReview(db, taskId, reviewer, 'approved', 'lgtm');
  assert.equal(r.verdict, 'approved');
  assert.equal(getTask(db, taskId).status, 'ready_to_work');
  assert.equal(listReviews(db, taskId)[0].comment, 'lgtm');
});

test('changes_requested sends the task back to researching', () => {
  const db = openDb(':memory:');
  const { owner, reviewer, taskId } = seed(db);
  requestReview(db, taskId, reviewer, owner);
  submitReview(db, taskId, reviewer, 'changes_requested', 'redo the plan');
  assert.equal(getTask(db, taskId).status, 'researching');
});

test('an invalid verdict is rejected', () => {
  const db = openDb(':memory:');
  const { owner, reviewer, taskId } = seed(db);
  requestReview(db, taskId, reviewer, owner);
  assert.throws(() => submitReview(db, taskId, reviewer, 'meh'), /INVALID_VERDICT/);
});
