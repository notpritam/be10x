import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

test('hashPassword output verifies against the original password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('verifyPassword rejects a wrong password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('Tr0ub4dour', stored), false);
});

test('same password hashes differently each time (random salt)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('verifyPassword returns false on malformed stored value', () => {
  assert.equal(verifyPassword('x', 'not-a-real-hash'), false);
});
