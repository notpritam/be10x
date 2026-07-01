import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember, getMembership, listMembers, setRole, removeMember } from '../src/teams/memberships.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const bob = createUser(db, { email: 'bob@b.co', displayName: 'Bob', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Platform', createdBy: owner }).id;
  return { owner, bob, team };
}

test('addMember adds a member and getMembership reads it back', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob, role: 'member' });
  assert.equal(getMembership(db, team, bob).role, 'member');
});

test('listMembers includes the owner plus added members', () => {
  const db = openDb(':memory:');
  const { owner, bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  const roles = Object.fromEntries(listMembers(db, team).map((m) => [m.userId, m.role]));
  assert.equal(roles[owner], 'owner');
  assert.equal(roles[bob], 'member');
});

test('addMember rejects a duplicate and an invalid role', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  assert.throws(() => addMember(db, { teamId: team, userId: bob }), /ALREADY_MEMBER/);
  assert.throws(() => addMember(db, { teamId: team, userId: bob, role: 'boss' }), /INVALID_ROLE/);
});

test('setRole changes a role; removeMember deletes the membership', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  setRole(db, team, bob, 'admin');
  assert.equal(getMembership(db, team, bob).role, 'admin');
  removeMember(db, team, bob);
  assert.equal(getMembership(db, team, bob), null);
});

test('setRole on a non-member throws', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  assert.throws(() => setRole(db, team, bob, 'admin'), /NOT_A_MEMBER/);
});
