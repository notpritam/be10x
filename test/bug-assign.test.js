// ABOUTME: Tests the bug assignee core (src/bugs/bugs.js setBugAssignee) — assign, re-assign with a from/to
// ABOUTME: event, unassign, and NOT_FOUND. The HTTP route is a thin wrapper over this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug, setBugAssignee, listBugEvents } from '../src/bugs/bugs.js';

function seed() {
  const db = openDb(':memory:');
  const reporter = createUser(db, { email: 'qa@b.co', displayName: 'QA', password: 'pw123456' });
  const dev = createUser(db, { email: 'dev@b.co', displayName: 'Dev', password: 'pw123456' });
  const bug = createBug(db, { reporterId: reporter.id, pageUrl: 'https://x', title: 'x' });
  return { db, reporter, dev, bug };
}

test('setBugAssignee assigns, records a from/to event, then unassigns', () => {
  const { db, reporter, dev, bug } = seed();
  assert.equal(bug.assigneeId, null);

  let b = setBugAssignee(db, bug.id, dev.id, reporter.id);
  assert.equal(b.assigneeId, dev.id);
  const assigned = listBugEvents(db, bug.id).find((e) => e.kind === 'assign');
  assert.equal(assigned.payload.from, null);
  assert.equal(assigned.payload.to, dev.id);
  assert.equal(assigned.actor, reporter.id);

  // Unassign.
  b = setBugAssignee(db, bug.id, null, reporter.id);
  assert.equal(b.assigneeId, null);
  const events = listBugEvents(db, bug.id).filter((e) => e.kind === 'assign');
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.from, dev.id);
  assert.equal(events[1].payload.to, null);
});

test('setBugAssignee throws NOT_FOUND for a missing bug', () => {
  const { db, reporter } = seed();
  assert.throws(() => setBugAssignee(db, 'nope', reporter.id, reporter.id), /NOT_FOUND/);
});
