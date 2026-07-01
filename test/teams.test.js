import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { slugify, createTeam, getTeam, getTeamBySlug } from '../src/teams/teams.js';

function seedUser(db) {
  return createUser(db, { email: 'o@b.co', displayName: 'Owner', password: 'pw12345' }).id;
}

test('slugify normalizes a name', () => {
  assert.equal(slugify('  My Cool Team!! '), 'my-cool-team');
});

test('createTeam makes the creator an owner', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createTeam(db, { name: 'Platform', createdBy: uid });
  assert.equal(t.slug, 'platform');
  assert.equal(getTeamBySlug(db, 'platform').id, t.id);
  const m = db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(t.id, uid);
  assert.equal(m.role, 'owner');
});

test('createTeam rejects a duplicate slug', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  createTeam(db, { name: 'Platform', createdBy: uid });
  assert.throws(() => createTeam(db, { name: 'platform', createdBy: uid }), /SLUG_TAKEN/);
});

test('createTeam rejects a name with no usable slug', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  assert.throws(() => createTeam(db, { name: '!!!', createdBy: uid }), /INVALID_NAME/);
});

test('getTeam reads a team back by id', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createTeam(db, { name: 'Platform', createdBy: uid });
  assert.equal(getTeam(db, t.id).slug, 'platform');
});
