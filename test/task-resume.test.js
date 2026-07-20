// ABOUTME: POST /api/tasks/:id/resume enqueues a 'resume' wake (which resumes the prior claude session);
// ABOUTME: 409 when the task has no prior session to resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createTask } from '../src/tasks/tasks.js';
import { createRun, setRunSession } from '../src/executor/runs.js';
import { listPendingWakes } from '../src/executor/wake.js';
import { REASON_MODE } from '../src/runner/runner.js';

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

test("'resume' wake reason maps to a resuming executor mode", () => {
  assert.equal(REASON_MODE.resume, 'follow_up');
});

test('POST /api/tasks/:id/resume enqueues a resume wake when a prior session exists', async () => {
  await withServer(async (base, db) => {
    const { cookie, userId } = await signup(base);
    const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: userId, content: { summary: 'x' } });
    const run = createRun(db, { taskId: t.id, projectId: null });
    setRunSession(db, run.id, 'sess-123');

    const res = await fetch(base + '/api/tasks/' + t.id + '/resume', { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const wakes = listPendingWakes(db, t.id);
    assert.ok(wakes.some((w) => w.reason === 'resume'), 'a resume wake is pending');
  });
});

test('POST /api/tasks/:id/resume is 409 when there is no session to resume', async () => {
  await withServer(async (base, db) => {
    const { cookie, userId } = await signup(base);
    const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId: userId, content: { summary: 'x' } });
    const res = await fetch(base + '/api/tasks/' + t.id + '/resume', { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 409);
  });
});
