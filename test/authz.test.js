import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';
import { can, assertCan } from '../src/authz/authz.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const viewer = createUser(db, { email: 'v@b.co', displayName: 'V', password: 'pw12345' }).id;
  const outsider = createUser(db, { email: 'x@b.co', displayName: 'X', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Platform', createdBy: owner }).id;
  addMember(db, { teamId: team, userId: viewer, role: 'viewer' });
  return { owner, viewer, outsider, team };
}

test('owner can manage members and delete the team', () => {
  const db = openDb(':memory:');
  const { owner, team } = seed(db);
  assert.equal(can(db, owner, 'members.manage', { teamId: team }), true);
  assert.equal(can(db, owner, 'team.delete', { teamId: team }), true);
});

test('viewer can read but not create tasks or manage members', () => {
  const db = openDb(':memory:');
  const { viewer, team } = seed(db);
  assert.equal(can(db, viewer, 'task.read', { teamId: team }), true);
  assert.equal(can(db, viewer, 'task.create', { teamId: team }), false);
  assert.equal(can(db, viewer, 'members.manage', { teamId: team }), false);
});

test('a non-member is denied everything (cross-team isolation)', () => {
  const db = openDb(':memory:');
  const { outsider, team } = seed(db);
  assert.equal(can(db, outsider, 'task.read', { teamId: team }), false);
});

test('unknown action is denied and assertCan throws FORBIDDEN', () => {
  const db = openDb(':memory:');
  const { owner, viewer, team } = seed(db);
  assert.equal(can(db, owner, 'nonsense.action', { teamId: team }), false);
  assert.throws(() => assertCan(db, viewer, 'task.create', { teamId: team }), /FORBIDDEN/);
});
