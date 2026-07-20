// ABOUTME: HTTP tests for the live-status surfaces — GET /api/ps (fleet) and GET /api/tasks/:id/status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createTask } from '../src/tasks/tasks.js';
import { recordProgress } from '../src/worker/worker.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try { await fn(base, db); } finally { await new Promise((r) => app.close(r)); }
}
async function signup(base) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co', displayName: 'A', password: 'pw123456' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  return { cookie, userId: me.user.id };
}

test('GET /api/ps lists in-flight sessions; GET /api/tasks/:id/status returns snapshot + stalled', async () => {
  await withServer(async (base, db) => {
    const { cookie, userId } = await signup(base);
    const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: userId, content: { summary: 'x' } });
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', t.id);
    recordProgress(db, t.id, { state: 'working', phase: 'implement', message: 'editing' });

    const ps = await (await fetch(base + '/api/ps', { headers: { cookie } })).json();
    const row = ps.sessions.find((s) => s.taskId === t.id);
    assert.ok(row, 'task appears in fleet');
    assert.equal(row.state, 'working');
    assert.equal(row.phase, 'implement');
    assert.equal(row.stalled, false);

    const st = await (await fetch(base + '/api/tasks/' + t.id + '/status', { headers: { cookie } })).json();
    assert.equal(st.state, 'working');
    assert.equal(typeof st.stalled, 'boolean');
    assert.equal(typeof st.ageMs, 'number');

    // auth required
    assert.equal((await fetch(base + '/api/ps')).status, 401);
    assert.equal((await fetch(base + '/api/tasks/' + t.id + '/status')).status, 401);
  });
});
