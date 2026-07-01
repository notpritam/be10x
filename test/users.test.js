import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser, getUserByEmail, getUserById } from '../src/auth/users.js';
import { verifyPassword } from '../src/auth/passwords.js';

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
