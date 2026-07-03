import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { enqueueWake, claimNextWake, claimNextWakeAny, claimNextWakeForKeys, listPendingWakes, getWake } from '../src/executor/wake.js';
import { registerProject } from '../src/projects/projects.js';
import { createUser } from '../src/auth/users.js';

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

test('claimNextWakeAny (baked serve runner) claims only tasks whose project has a LOCAL checkout', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  const local = registerProject(db, { key: 'github.com/acme/local', name: 'local', rootPath: '/repo/local', defaultBranch: 'main' });
  const remote = registerProject(db, { key: 'github.com/acme/remote', name: 'remote', rootPath: null, defaultBranch: 'main' });
  const mk = (id, projectId) =>
    db
      .prepare(
        'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(id, id, 'general', 'project', projectId, 'u1', 'T', 'in_progress', now, now);
  mk('t-remote', remote.id);
  mk('t-local', local.id);

  // Enqueue the path-less (distributed) wake FIRST — plain FIFO would grab it if the guard weren't there.
  enqueueWake(db, 't-remote', 'execute');
  enqueueWake(db, 't-local', 'execute');

  const claimed = claimNextWakeAny(db);
  assert.equal(claimed.taskId, 't-local', 'skips the path-less project a connector owns, claims the local repo');
  // The remote wake is untouched — left for a `be10x connect` runner on the member's machine.
  assert.equal(listPendingWakes(db, 't-remote').length, 1);
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

// Two accounts each declare a repo under the SAME key (e.g. two unrelated checkouts sharing a folder name)
// — this must resolve to two SEPARATE projects (see projects.js), so passing userId must stop one
// account's connector from ever being handed the other's wake, even though the key string matches.
test('claimNextWakeForKeys with userId only claims wakes for THAT user\'s own (or team) project, not a same-keyed stranger\'s', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const alice = createUser(db, { email: 'alice@keys.co', displayName: 'Alice', password: 'pw12345' }).id;
  const bob = createUser(db, { email: 'bob@keys.co', displayName: 'Bob', password: 'pw12345' }).id;
  const aliceProject = registerProject(db, { key: 'local:shared-name', name: 'Alice repo', ownerId: alice });
  const bobProject = registerProject(db, { key: 'local:shared-name', name: 'Bob repo', ownerId: bob });
  assert.notEqual(aliceProject.id, bobProject.id, 'same key, different owners: must not collide onto one row');

  const mk = (id, projectId, ownerId) =>
    db
      .prepare(
        'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(id, id, 'general', 'project', projectId, ownerId, 'T', 'in_progress', now, now);
  mk('t-alice', aliceProject.id, alice);
  mk('t-bob', bobProject.id, bob);
  enqueueWake(db, 't-alice', 'execute');
  enqueueWake(db, 't-bob', 'execute');

  // Bob's connector declares the bare key — without userId scoping this could grab Alice's wake first
  // (same key, enqueued first) and permanently fail to run it (wrong local checkout).
  const claimed = claimNextWakeForKeys(db, { projectKeys: ['local:shared-name'], workerId: 'bob-connect', userId: bob });
  assert.equal(claimed.taskId, 't-bob');

  // Alice's wake is untouched, still claimable by Alice's own connector.
  assert.equal(listPendingWakes(db, 't-alice').length, 1);
  const aliceClaim = claimNextWakeForKeys(db, { projectKeys: ['local:shared-name'], workerId: 'alice-connect', userId: alice });
  assert.equal(aliceClaim.taskId, 't-alice');
});

test('claimNextWakeForKeys without userId falls back to plain key matching (trusted/local callers)', () => {
  const db = seed();
  const p = registerProject(db, { key: 'github.com/acme/app', name: 'app', rootPath: null });
  db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(p.id, 't1');
  enqueueWake(db, 't1', 'plan');
  const claimed = claimNextWakeForKeys(db, { projectKeys: ['github.com/acme/app'], workerId: 'r' });
  assert.equal(claimed.taskId, 't1');
});
