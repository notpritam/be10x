import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { enqueueWake, claimNextWake, listPendingWakes, getWake } from '../src/executor/wake.js';

// Two tasks in two projects, so the project-scoped claim can be exercised.
function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  const task = (id, project) =>
    db
      .prepare(
        'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(id, id, 'code-issue', 'project', project, 'u1', 'T', 'plan_review', now, now);
  task('t1', 'p1');
  task('t2', 'p2');
  return db;
}

test('enqueueWake stores the reason + delta context; listPendingWakes returns it', () => {
  const db = seed();
  const w = enqueueWake(db, 't1', 'revise', { comment: 'tighten step 2' });
  assert.equal(w.reason, 'revise');
  assert.deepEqual(w.context, { comment: 'tighten step 2' });
  assert.equal(w.claimedAt, null);
  const pending = listPendingWakes(db, 't1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, w.id);
});

test('claimNextWake is project-scoped and FIFO', () => {
  const db = seed();
  enqueueWake(db, 't1', 'plan');
  enqueueWake(db, 't2', 'plan');
  enqueueWake(db, 't1', 'execute');

  // p2's runner only sees t2's wake
  const p2 = claimNextWake(db, { projectId: 'p2', workerId: 'r2' });
  assert.equal(p2.taskId, 't2');

  // p1's runner drains t1's wakes oldest-first
  const first = claimNextWake(db, { projectId: 'p1', workerId: 'r1' });
  assert.equal(first.reason, 'plan');
  const second = claimNextWake(db, { projectId: 'p1', workerId: 'r1' });
  assert.equal(second.reason, 'execute');
  assert.equal(claimNextWake(db, { projectId: 'p1' }), null); // drained
});

test('a project-less (personal) task wake is claimable by any runner', () => {
  const db = seed();
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('t3', 't3', 'general', 'personal', null, 'u1', 'T', 'researching', Date.now(), Date.now());
  enqueueWake(db, 't3', 'plan');
  const claimed = claimNextWake(db, { projectId: 'p-whatever', workerId: 'r' });
  assert.equal(claimed.taskId, 't3');
});

test('a claimed wake is not re-claimable (optimistic lock holds)', () => {
  const db = seed();
  const w = enqueueWake(db, 't1', 'plan');
  const a = claimNextWake(db, { projectId: 'p1', workerId: 'A' });
  assert.equal(a.id, w.id);
  assert.equal(getWake(db, w.id).claimedBy, 'A');
  assert.equal(claimNextWake(db, { projectId: 'p1', workerId: 'B' }), null);
});
