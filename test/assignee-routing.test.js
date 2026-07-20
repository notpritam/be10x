// ABOUTME: Strict assignee-routing — a wake for an ASSIGNED task is only claimable by the assignee's
// ABOUTME: worker (unassigned tasks stay claimable by anyone serving the repo/host). Covers all three
// ABOUTME: claim paths: baked serve runner, per-project runner, and the remote-connector key claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { enqueueWake, claimNextWake, claimNextWakeAny, claimNextWakeForKeys } from '../src/executor/wake.js';
import { registerProject } from '../src/projects/projects.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';

function mkUser(db, id) {
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    id, id + '@b.dev', id, 'x', Date.now()
  );
  return id;
}
function mkTask(db, { id, projectId, assigneeId = null }) {
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,assignee_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, id, 'general', 'project', projectId, 'uA', assigneeId, 'T', 'in_progress', Date.now(), Date.now());
}

test('claimNextWakeAny (baked runner): assigned task only claimed by the assignee; unassigned by anyone', () => {
  const db = openDb(':memory:');
  const uA = mkUser(db, 'uA'), uB = mkUser(db, 'uB');
  const p = registerProject(db, { key: 'k/local', name: 'local', rootPath: '/repo/local' });
  mkTask(db, { id: 't-assigned', projectId: p.id, assigneeId: uB });
  enqueueWake(db, 't-assigned', 'execute');

  // A runner acting for uA must NOT claim uB's assigned task…
  assert.equal(claimNextWakeAny(db, 'runner', { claimantUserId: uA }), null);
  // …a runner with no identity must NOT claim it either (assigned work needs its owner).
  assert.equal(claimNextWakeAny(db, 'runner'), null);
  // …the assignee's runner claims it.
  const got = claimNextWakeAny(db, 'runner', { claimantUserId: uB });
  assert.equal(got?.taskId, 't-assigned');

  // An UNASSIGNED task is claimable by anyone serving the host.
  mkTask(db, { id: 't-open', projectId: p.id, assigneeId: null });
  enqueueWake(db, 't-open', 'execute');
  assert.equal(claimNextWakeAny(db, 'runner', { claimantUserId: uA })?.taskId, 't-open');
});

test('claimNextWake (per-project runner): same assignee gate', () => {
  const db = openDb(':memory:');
  const uA = mkUser(db, 'uA'), uB = mkUser(db, 'uB');
  const p = registerProject(db, { key: 'k/p', name: 'p', rootPath: '/repo/p' });
  mkTask(db, { id: 't1', projectId: p.id, assigneeId: uB });
  enqueueWake(db, 't1', 'execute');

  assert.equal(claimNextWake(db, { projectId: p.id, claimantUserId: uA }), null);
  assert.equal(claimNextWake(db, { projectId: p.id, claimantUserId: uB })?.taskId, 't1');
});

test('claimNextWakeForKeys (remote connector): claimant = authed user; assigned task routes to them only', () => {
  const db = openDb(':memory:');
  const uA = mkUser(db, 'uA'), uB = mkUser(db, 'uB');
  const team = createTeam(db, { name: 'Crew', createdBy: uA });
  addMember(db, { teamId: team.id, userId: uB, role: 'member' });
  // A shared team project both members can access (so access control isn't what's filtering).
  const p = registerProject(db, { key: 'k/shared', name: 'shared', rootPath: null, teamId: team.id });
  mkTask(db, { id: 't-b', projectId: p.id, assigneeId: uB });
  enqueueWake(db, 't-b', 'execute');

  // uA's connector serves the repo and can access the project, but the task is uB's → no claim.
  assert.equal(claimNextWakeForKeys(db, { projectKeys: ['k/shared'], userId: uA }), null);
  // uB's connector claims it.
  assert.equal(claimNextWakeForKeys(db, { projectKeys: ['k/shared'], userId: uB })?.taskId, 't-b');
});

test('reassignment reroutes future claims', () => {
  const db = openDb(':memory:');
  const uA = mkUser(db, 'uA'), uB = mkUser(db, 'uB');
  const p = registerProject(db, { key: 'k/r', name: 'r', rootPath: '/repo/r' });
  mkTask(db, { id: 't', projectId: p.id, assigneeId: uB });
  enqueueWake(db, 't', 'execute');
  assert.equal(claimNextWakeAny(db, 'runner', { claimantUserId: uA }), null);

  // Reassign to uA → uA's runner can now claim.
  db.prepare('UPDATE tasks SET assignee_id = ? WHERE id = ?').run(uA, 't');
  assert.equal(claimNextWakeAny(db, 'runner', { claimantUserId: uA })?.taskId, 't');
});
