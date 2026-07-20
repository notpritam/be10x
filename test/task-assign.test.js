// ABOUTME: Task assignment — setTaskAssignee (core) + POST /api/tasks/:id/assign (HTTP). Assigning a task
// ABOUTME: is what drives strict assignee-routing (see assignee-routing.test.js): only the assignee's
// ABOUTME: machine claims it. Mirrors the bug-assign shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createTask, getTask, setTaskAssignee } from '../src/tasks/tasks.js';
import { createUser } from '../src/auth/users.js';
import { listEvents } from '../src/tasks/events.js';

test('setTaskAssignee sets/clears the assignee and records an event', () => {
  const db = openDb(':memory:');
  const owner = createUser(db, { email: 'owner@b.co', displayName: 'Owner', password: 'pw123456' });
  const mate = createUser(db, { email: 'mate@b.co', displayName: 'Mate', password: 'pw123456' });
  const task = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: owner.id, content: { summary: 'do X' } });

  const assigned = setTaskAssignee(db, task.id, mate.id, owner.id);
  assert.equal(assigned.assigneeId, mate.id);
  assert.equal(getTask(db, task.id).assigneeId, mate.id);
  const ev = listEvents(db, task.id).find((e) => e.kind === 'assign');
  assert.ok(ev, 'an assign event is appended');
  assert.equal(ev.payload.to, mate.id);

  const cleared = setTaskAssignee(db, task.id, null, owner.id);
  assert.equal(cleared.assigneeId, null);

  assert.throws(() => setTaskAssignee(db, 'nope', mate.id, owner.id), /NO_TASK/);
});

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try { await fn(base, db); } finally { await new Promise((r) => app.close(r)); }
}

async function signup(base, email) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: email, password: 'pw123456' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json().catch(() => ({}));
  return { cookie, userId: me?.user?.id };
}

test('POST /api/tasks/:id/assign assigns to a teammate; unknown assignee 4xx', async () => {
  await withServer(async (base, db) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const task = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: a.userId, content: { summary: 'do X' } });

    const res = await fetch(base + '/api/tasks/' + task.id + '/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ assigneeId: b.userId }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).task.assigneeId, b.userId);

    const bad = await fetch(base + '/api/tasks/' + task.id + '/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ assigneeId: 'ghost' }),
    });
    assert.equal(bad.status >= 400, true);

    // clearing (assigneeId null) unassigns
    const clr = await fetch(base + '/api/tasks/' + task.id + '/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ assigneeId: null }),
    });
    assert.equal((await clr.json()).task.assigneeId, null);

    // session required
    const noauth = await fetch(base + '/api/tasks/' + task.id + '/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assigneeId: b.userId }),
    });
    assert.equal(noauth.status, 401);
  });
});
