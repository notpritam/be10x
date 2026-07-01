import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createToken, verifyToken, revokeToken } from '../src/auth/tokens.js';

function seedUser(db) {
  return createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
}

test('createToken returns a plaintext secret that verifies to its user', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  assert.match(t.token, /^gfa_[0-9a-f]{48}$/);
  const v = verifyToken(db, t.token);
  assert.equal(v.userId, uid);
  assert.equal(v.tokenId, t.id);
});

test('the plaintext secret is not stored in the database', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  const stored = db.prepare('SELECT token_hash FROM tokens WHERE id = ?').get(t.id).token_hash;
  assert.notEqual(stored, t.token);
});

test('verifyToken returns null for an unknown secret', () => {
  const db = openDb(':memory:');
  assert.equal(verifyToken(db, 'gfa_deadbeef'), null);
});

test('a revoked token no longer verifies', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  revokeToken(db, t.id);
  assert.equal(verifyToken(db, t.token), null);
});
