// ABOUTME: HTTP tests for the task↔bug attach/detach/list routes and bugIds-on-create, against a real
// ABOUTME: in-memory server via createApp(db) — mirrors test/bugs-http.test.js. Enforces bug-visibility authz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function j(res) {
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signup(base, email) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'U', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const body = await res.json();
  return { cookie, userId: body.user.id };
}

async function mintToken(base, cookie) {
  const res = await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'ext' }),
  });
  return (await res.json()).token.token;
}

// File a bug as the extension would (Bearer). Returns the created bug.
async function ingestBug(base, token, title) {
  const res = await fetch(base + '/api/agent/bugs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ pageUrl: 'https://app/x', title, severity: 'high', meta: { errorCount: 2 } }),
  });
  return (await res.json()).bug;
}

const sGet = (base, cookie, path) => fetch(base + path, { headers: { cookie } }).then(j);
const sPost = (base, cookie, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) }).then(j);
const sDelete = (base, cookie, path) => fetch(base + path, { method: 'DELETE', headers: { cookie } }).then(j);

async function makeTask(base, cookie, title = 'T') {
  const r = await sPost(base, cookie, '/api/tasks', { type: 'general', scope: 'personal', title, content: { summary: 's' } });
  return r.body.task;
}

test('attach a bug to a task, list it, detach it', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base, 'a@b.co');
    const token = await mintToken(base, cookie);
    const task = await makeTask(base, cookie);
    const bug = await ingestBug(base, token, 'Broken');

    // Attach by uuid.
    const attach = await sPost(base, cookie, `/api/tasks/${task.id}/bugs`, { bugId: bug.id });
    assert.equal(attach.status, 200);
    assert.equal(attach.body.bug.taskId, task.id);

    // List shows it.
    const list = await sGet(base, cookie, `/api/tasks/${task.id}/bugs`);
    assert.equal(list.status, 200);
    assert.equal(list.body.bugs.length, 1);
    assert.equal(list.body.bugs[0].id, bug.id);

    // Detach.
    const del = await sDelete(base, cookie, `/api/tasks/${task.id}/bugs/${bug.id}`);
    assert.equal(del.status, 200);
    const list2 = await sGet(base, cookie, `/api/tasks/${task.id}/bugs`);
    assert.equal(list2.body.bugs.length, 0);
  });
});

test('attach accepts a human id (BUG-001)', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base, 'a@b.co');
    const token = await mintToken(base, cookie);
    const task = await makeTask(base, cookie);
    const bug = await ingestBug(base, token, 'Broken');
    assert.equal(bug.humanId, 'BUG-001');

    const attach = await sPost(base, cookie, `/api/tasks/${task.id}/bugs`, { bugId: 'BUG-001' });
    assert.equal(attach.status, 200);
    assert.equal(attach.body.bug.id, bug.id);
    assert.equal(attach.body.bug.taskId, task.id);
  });
});

test('POST /api/tasks with bugIds links each bug on create', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base, 'a@b.co');
    const token = await mintToken(base, cookie);
    const b1 = await ingestBug(base, token, 'one');
    const b2 = await ingestBug(base, token, 'two');

    const created = await sPost(base, cookie, '/api/tasks', {
      type: 'general', scope: 'personal', title: 'with bugs', content: { summary: 's' }, bugIds: [b1.id, b2.humanId],
    });
    assert.equal(created.status, 200);
    const list = await sGet(base, cookie, `/api/tasks/${created.body.task.id}/bugs`);
    assert.equal(list.body.bugs.length, 2);
  });
});

test('a user cannot attach another account\'s bug (FORBIDDEN)', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const bToken = await mintToken(base, b.cookie);
    const foreignBug = await ingestBug(base, bToken, 'B private'); // reported by B

    const task = await makeTask(base, a.cookie); // owned by A
    const attach = await sPost(base, a.cookie, `/api/tasks/${task.id}/bugs`, { bugId: foreignBug.id });
    assert.equal(attach.status, 403);
    assert.equal(attach.body.error, 'FORBIDDEN');
  });
});

test('attach/list/detach require access to the task itself', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const aToken = await mintToken(base, a.cookie);
    const task = await makeTask(base, a.cookie); // owned by A
    const bug = await ingestBug(base, aToken, 'x');

    // B can't see A's personal task → 403 on attach and on list.
    const attach = await sPost(base, b.cookie, `/api/tasks/${task.id}/bugs`, { bugId: bug.id });
    assert.equal(attach.status, 403);
    const list = await sGet(base, b.cookie, `/api/tasks/${task.id}/bugs`);
    assert.equal(list.status, 403);
  });
});
