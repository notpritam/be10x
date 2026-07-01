import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';

test('openDb applies the schema and enforces foreign keys', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['comments', 'input_requests', 'memberships', 'projects', 'reviews', 'runs', 'sessions', 'task_events', 'tasks', 'teams', 'tokens', 'users', 'wake_queue']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
