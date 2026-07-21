// ABOUTME: Notification endpoints — the connector's Bearer feed (GET /api/agent/notifications?since) and
// ABOUTME: the web bell (GET /api/notifications + POST /api/notifications/seen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createTask } from '../src/tasks/tasks.js';

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
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  const tokRes = await fetch(base + '/api/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'machine' }),
  });
  const token = (await tokRes.json()).token.token;
  return { cookie, userId: me.user.id, token };
}

test('connector Bearer feed + web bell + mark-seen', async () => {
  await withServer(async (base, db) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    // A creates a task and assigns it to B → B gets an 'assigned' notification.
    const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: a.userId, content: { summary: 'x' } });
    await fetch(base + '/api/tasks/' + t.id + '/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ assigneeId: b.userId }),
    });

    // Connector path: Bearer, since=0 → B's notification
    const agent = await (await fetch(base + '/api/agent/notifications?since=0', { headers: { Authorization: 'Bearer ' + b.token } })).json();
    assert.equal(agent.notifications.length, 1);
    assert.equal(agent.notifications[0].kind, 'assigned');
    const seq = agent.notifications[0].seq;
    // since=<seq> → nothing newer
    const after = await (await fetch(base + '/api/agent/notifications?since=' + seq, { headers: { Authorization: 'Bearer ' + b.token } })).json();
    assert.equal(after.notifications.length, 0);
    // no token → 401
    assert.equal((await fetch(base + '/api/agent/notifications')).status, 401);

    // Web bell: session → list + unseen count
    const bell = await (await fetch(base + '/api/notifications', { headers: { cookie: b.cookie } })).json();
    assert.equal(bell.unseen, 1);
    assert.equal(bell.notifications[0].kind, 'assigned');
    // mark seen → unseen 0
    await fetch(base + '/api/notifications/seen', { method: 'POST', headers: { cookie: b.cookie } });
    const bell2 = await (await fetch(base + '/api/notifications', { headers: { cookie: b.cookie } })).json();
    assert.equal(bell2.unseen, 0);
    // A (the actor) got nothing — no self-notification
    const bellA = await (await fetch(base + '/api/notifications', { headers: { cookie: a.cookie } })).json();
    assert.equal(bellA.unseen, 0);
  });
});
