import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { keyFromRemote, registerProject, getProjectByKey, getProject, listProjects, listProjectsForUser } from '../src/projects/projects.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';

test('keyFromRemote normalizes https and scp remotes to the same key', () => {
  const https = keyFromRemote('https://github.com/org/repo.git');
  const scp = keyFromRemote('git@github.com:org/repo.git');
  assert.equal(https, 'github.com/org/repo');
  assert.equal(scp, 'github.com/org/repo');
  assert.equal(https, scp);
});

test('keyFromRemote strips auth, port, scheme and lowercases', () => {
  assert.equal(keyFromRemote('https://user:pass@GitHub.com/Org/Repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('ssh://git@github.com/org/repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('ssh://git@github.com:2222/org/repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('https://github.com/org/repo/'), 'github.com/org/repo');
});

test('registerProject is idempotent by key', () => {
  const db = openDb(':memory:');
  const first = registerProject(db, { key: 'github.com/org/repo', name: 'Repo', rootPath: '/tmp/repo', defaultBranch: 'main' });
  const again = registerProject(db, { key: 'github.com/org/repo', name: 'Different name' });
  assert.equal(first.id, again.id);
  assert.equal(again.name, 'Repo'); // existing row returned unchanged
  assert.equal(listProjects(db).length, 1);
});

test('getProjectByKey and getProject round-trip a registered project', () => {
  const db = openDb(':memory:');
  const p = registerProject(db, { key: 'local:my-app', name: 'My App', rootPath: '/work/my-app', defaultBranch: 'develop' });
  const byKey = getProjectByKey(db, 'local:my-app');
  assert.equal(byKey.id, p.id);
  assert.equal(byKey.key, 'local:my-app');
  assert.equal(byKey.name, 'My App');
  assert.equal(byKey.rootPath, '/work/my-app');
  assert.equal(byKey.defaultBranch, 'develop');
  assert.equal(getProject(db, p.id).key, 'local:my-app');
  assert.equal(getProjectByKey(db, 'nope'), null);
});

// See docs/rca-2026-07-03-account-isolation.md, issue 2: two accounts registering the same key (a shared
// git remote, or just an identically-named local folder with no remote) must never collide onto one row.
test('registerProject scopes identity per owner/team — the same key from two different owners is two rows', () => {
  const db = openDb(':memory:');
  const alice = createUser(db, { email: 'alice@p.co', displayName: 'Alice', password: 'pw12345' }).id;
  const bob = createUser(db, { email: 'bob@p.co', displayName: 'Bob', password: 'pw12345' }).id;

  const aliceProject = registerProject(db, { key: 'local:app', name: 'Alice app', ownerId: alice });
  const bobProject = registerProject(db, { key: 'local:app', name: 'Bob app', ownerId: bob });
  assert.notEqual(aliceProject.id, bobProject.id);
  assert.equal(listProjects(db).length, 2);

  // Idempotent WITHIN one owner's own scope.
  const aliceAgain = registerProject(db, { key: 'local:app', name: 'renamed', ownerId: alice });
  assert.equal(aliceAgain.id, aliceProject.id);
  assert.equal(aliceAgain.name, 'Alice app');
  assert.equal(listProjects(db).length, 2);

  assert.equal(getProjectByKey(db, 'local:app', { ownerId: alice }).id, aliceProject.id);
  assert.equal(getProjectByKey(db, 'local:app', { ownerId: bob }).id, bobProject.id);
});

test('registerProject scopes identity per team the same way, independent of who on the team registers it', () => {
  const db = openDb(':memory:');
  const owner = createUser(db, { email: 'owner@p.co', displayName: 'Owner', password: 'pw12345' }).id;
  const member = createUser(db, { email: 'member@p.co', displayName: 'Member', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Alpha', createdBy: owner }).id;
  addMember(db, { teamId: team, userId: member, role: 'member' });

  const first = registerProject(db, { key: 'github.com/acme/app', name: 'app', ownerId: owner, teamId: team });
  const again = registerProject(db, { key: 'github.com/acme/app', name: 'app (re-linked by teammate)', ownerId: member, teamId: team });
  assert.equal(first.id, again.id, 'same team + same key: one shared row regardless of which member links it');
  assert.equal(listProjects(db).length, 1);
});

test('listProjectsForUser returns own personal projects, team projects, and legacy ownerless rows — nothing else', () => {
  const db = openDb(':memory:');
  const alice = createUser(db, { email: 'alice2@p.co', displayName: 'Alice', password: 'pw12345' }).id;
  const bob = createUser(db, { email: 'bob2@p.co', displayName: 'Bob', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Beta', createdBy: alice }).id;

  const alicePersonal = registerProject(db, { key: 'local:alice-only', name: 'alice-only', ownerId: alice });
  const teamProject = registerProject(db, { key: 'github.com/acme/shared', name: 'shared', ownerId: alice, teamId: team });
  const bobPersonal = registerProject(db, { key: 'local:bob-only', name: 'bob-only', ownerId: bob });
  const legacy = registerProject(db, { key: 'local:predates-scoping', name: 'legacy' }); // no ownerId/teamId at all

  const aliceVisible = listProjectsForUser(db, alice).map((p) => p.id).sort();
  assert.deepEqual(aliceVisible, [alicePersonal.id, legacy.id, teamProject.id].sort());

  const bobVisible = listProjectsForUser(db, bob).map((p) => p.id).sort();
  assert.deepEqual(bobVisible, [bobPersonal.id, legacy.id].sort(), "bob is not on Alice's team — must not see her personal or team project");
});
