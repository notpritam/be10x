import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, setPlan } from '../src/tasks/tasks.js';
import { recordPlanVersion, listPlanVersions, getPlanVersion } from '../src/plans/versions.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: owner, content: { summary: 's' } });
  return { owner, taskId: t.id };
}

test('setPlan records a plan version', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seed(db);
  setPlan(db, taskId, { steps: ['a', 'b'] }, owner);
  const versions = listPlanVersions(db, taskId);
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].plan, { steps: ['a', 'b'] });
  assert.equal(versions[0].createdBy, owner);
  assert.ok(versions[0].createdAt > 0);
});

test('two setPlans produce two versions, newest first', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seed(db);
  setPlan(db, taskId, { v: 1 }, owner);
  setPlan(db, taskId, { v: 2 }, owner);
  const versions = listPlanVersions(db, taskId);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0].plan, { v: 2 }); // newest first
  assert.deepEqual(versions[1].plan, { v: 1 });
});

test('getPlanVersion returns a parsed version, or null when missing', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seed(db);
  const id = recordPlanVersion(db, { taskId, plan: { hello: 'world' }, createdBy: owner });
  assert.deepEqual(getPlanVersion(db, id).plan, { hello: 'world' });
  assert.equal(getPlanVersion(db, 'no-such-id'), null);
});

test('restoring an older version sets the plan back (the /restore route flow)', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seed(db);
  setPlan(db, taskId, { v: 1 }, owner);
  setPlan(db, taskId, { v: 2 }, owner);
  assert.deepEqual(getTask(db, taskId).plan, { v: 2 });
  // newest-first, so index 1 is the original { v: 1 }
  const older = listPlanVersions(db, taskId)[1];
  const version = getPlanVersion(db, older.id);
  const task = setPlan(db, taskId, version.plan, owner);
  assert.deepEqual(task.plan, { v: 1 });
  assert.deepEqual(getTask(db, taskId).plan, { v: 1 });
  // the restore itself snapshots a fresh version → three in total now
  assert.equal(listPlanVersions(db, taskId).length, 3);
});
