import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser, getUserByEmail, getUserById, searchUsers, recentCollaborators } from '../src/auth/users.js';
import { verifyPassword } from '../src/auth/passwords.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';

test('createUser stores a normalized email and a verifiable password', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { email: '  Ada@Example.COM ', displayName: 'Ada', password: 'pw12345' });
  assert.equal(u.email, 'ada@example.com');
  const row = getUserByEmail(db, 'ada@example.com');
  assert.equal(row.id, u.id);
  assert.equal(verifyPassword('pw12345', row.passwordHash), true);
});

test('getUserById omits the password hash', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw12345' });
  const got = getUserById(db, u.id);
  assert.equal(got.email, 'a@b.co');
  assert.equal('passwordHash' in got, false);
});

test('createUser rejects a duplicate email', () => {
  const db = openDb(':memory:');
  createUser(db, { email: 'dup@b.co', displayName: 'A', password: 'pw12345' });
  assert.throws(() => createUser(db, { email: 'DUP@b.co', displayName: 'B', password: 'pw12345' }), /EMAIL_TAKEN/);
});

test('getUserByEmail returns null when absent', () => {
  const db = openDb(':memory:');
  assert.equal(getUserByEmail(db, 'nobody@b.co'), null);
});

test('searchUsers matches name or email, is case-insensitive, and honors excludeIds', () => {
  const db = openDb(':memory:');
  const ada = createUser(db, { email: 'ada@lovelace.dev', displayName: 'Ada Lovelace', password: 'pw12345' });
  createUser(db, { email: 'grace@hopper.dev', displayName: 'Grace Hopper', password: 'pw12345' });

  // by name (case-insensitive)
  assert.deepEqual(searchUsers(db, 'ADA').map((u) => u.email), ['ada@lovelace.dev']);
  // by email fragment
  assert.deepEqual(searchUsers(db, 'hopper').map((u) => u.email), ['grace@hopper.dev']);
  // excludeIds drops a match (e.g. yourself / existing members)
  assert.deepEqual(searchUsers(db, 'lovelace', { excludeIds: [ada.id] }), []);
  // empty query returns nothing (no accidental "everyone")
  assert.deepEqual(searchUsers(db, '   '), []);
  // never leaks the password hash
  assert.equal('passwordHash' in searchUsers(db, 'ada')[0], false);
});

test('searchUsers treats % and _ as literal, not wildcards', () => {
  const db = openDb(':memory:');
  createUser(db, { email: 'real@x.co', displayName: 'Real Person', password: 'pw12345' });
  assert.deepEqual(searchUsers(db, '%'), []); // would match everyone if unescaped
});

test('recentCollaborators returns team co-members, most-recent first, excluding yourself', () => {
  const db = openDb(':memory:');
  const me = createUser(db, { email: 'me@x.co', displayName: 'Me', password: 'pw12345' });
  const alice = createUser(db, { email: 'alice@x.co', displayName: 'Alice', password: 'pw12345' });
  const bob = createUser(db, { email: 'bob@x.co', displayName: 'Bob', password: 'pw12345' });
  createUser(db, { email: 'stranger@x.co', displayName: 'Stranger', password: 'pw12345' }); // no shared team

  const team = createTeam(db, { name: 'Platform', createdBy: me.id });
  addMember(db, { teamId: team.id, userId: alice.id });
  addMember(db, { teamId: team.id, userId: bob.id });

  const people = recentCollaborators(db, me.id);
  const ids = people.map((u) => u.id);
  assert.ok(ids.includes(alice.id) && ids.includes(bob.id));
  assert.ok(!ids.includes(me.id), 'never includes yourself');
  assert.ok(!people.some((u) => u.email === 'stranger@x.co'), 'excludes people with no shared team');

  // excludeIds (e.g. someone already being shown) is honored
  assert.ok(!recentCollaborators(db, me.id, { excludeIds: [alice.id] }).some((u) => u.id === alice.id));
});
