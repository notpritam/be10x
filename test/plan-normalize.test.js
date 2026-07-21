// ABOUTME: setPlan unwraps a plan the agent sent as a JSON STRING ('{"html":...}') so it's stored once as
// ABOUTME: the object — not double-encoded (which made the board render raw braces + \n\n instead of the plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, setPlan, getTask } from '../src/tasks/tasks.js';

function seed() {
  const db = openDb(':memory:');
  const u = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw123456' });
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: u.id, content: { summary: 'x' } });
  return { db, taskId: t.id, userId: u.id };
}

test('setPlan stores an object plan as-is', () => {
  const { db, taskId, userId } = seed();
  setPlan(db, taskId, { html: '<div>hi</div>' }, userId);
  const plan = getTask(db, taskId).plan;
  assert.equal(typeof plan, 'object');
  assert.equal(plan.html, '<div>hi</div>');
});

test('setPlan unwraps a JSON-STRING plan into the object (no double-encoding)', () => {
  const { db, taskId, userId } = seed();
  setPlan(db, taskId, '{"html":"<div>hi</div>"}', userId); // agent sent it stringified
  const plan = getTask(db, taskId).plan;
  assert.equal(typeof plan, 'object', 'stored as the object, not a JSON string');
  assert.equal(plan.html, '<div>hi</div>');
});

test('setPlan keeps a genuine HTML/markdown string a string', () => {
  const { db, taskId, userId } = seed();
  setPlan(db, taskId, '<div>hi</div>', userId);
  assert.equal(getTask(db, taskId).plan, '<div>hi</div>');
  setPlan(db, taskId, '# Heading\n\nBody', userId);
  assert.equal(getTask(db, taskId).plan, '# Heading\n\nBody');
});
