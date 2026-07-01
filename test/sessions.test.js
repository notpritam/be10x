import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createSession, getSession, deleteSession } from '../src/auth/sessions.js';

function seedUser(db) {
  return createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
}

test('createSession then getSession returns the live session', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid);
  const got = getSession(db, s.id);
  assert.equal(got.userId, uid);
  assert.equal(got.id, s.id);
});

test('an expired session is not returned and is purged', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid, -1000); // already expired
  assert.equal(getSession(db, s.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('deleteSession removes it', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid);
  deleteSession(db, s.id);
  assert.equal(getSession(db, s.id), null);
});
