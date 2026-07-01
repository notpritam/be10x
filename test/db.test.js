import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';

test('openDb applies the schema and enforces foreign keys', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['memberships', 'sessions', 'teams', 'tokens', 'users']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
