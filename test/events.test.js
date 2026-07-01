import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { appendEvent, listEvents } from '../src/tasks/events.js';

function seedTask(db) {
  const uid = createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, human_id, type, scope, owner_id, title, status, content_json, retry_count, created_at, updated_at)
     VALUES ('t1', 'GFA-001', 'general', 'personal', ?, 'T', 'backlog', '{}', 0, ?, ?)`
  ).run(uid, now, now);
  return 't1';
}

test('appendEvent then listEvents returns events oldest-first with parsed payload', () => {
  const db = openDb(':memory:');
  const tid = seedTask(db);
  appendEvent(db, tid, 'user', 'created', { a: 1 });
  appendEvent(db, tid, 'agent', 'status', { from: 'backlog', to: 'researching' });
  const evs = listEvents(db, tid);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'created');
  assert.deepEqual(evs[0].payload, { a: 1 });
  assert.equal(evs[1].payload.to, 'researching');
});
