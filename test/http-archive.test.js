import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createRun } from '../src/executor/runs.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base, db);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function api(base, method, path, { cookie, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

const signup = (base, email) =>
  api(base, 'POST', '/api/auth/signup', { body: { email, displayName: email[0].toUpperCase(), password: 'pw12345' } });

test('POST /api/tasks/:id/archive soft-archives and returns the run worktrees', async () => {
  await withServer(async (base, db) => {
    const owner = await signup(base, 'owner@arch.co');
    const created = await api(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'personal', title: 'Shelve me', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    // A run row with a real worktree recorded, so the response carries something to GC.
    createRun(db, {
      taskId: id,
      worktreePath: '/repo/.be10x/worktrees/be10x__GFA-1-shelve-me',
      branch: 'be10x/GFA-1-shelve-me',
    });

    const archived = await api(base, 'POST', '/api/tasks/' + id + '/archive', { cookie: owner.cookie });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.task.status, 'archived');
    assert.deepEqual(archived.json.worktrees, [
      { path: '/repo/.be10x/worktrees/be10x__GFA-1-shelve-me', branch: 'be10x/GFA-1-shelve-me' },
    ]);

    // The row survives (still fetchable) — soft archive, not a delete.
    const fetched = await api(base, 'GET', '/api/tasks/' + id, { cookie: owner.cookie });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.task.status, 'archived');

    // Idempotent over HTTP: a second archive still 200s.
    const again = await api(base, 'POST', '/api/tasks/' + id + '/archive', { cookie: owner.cookie });
    assert.equal(again.status, 200);
    assert.equal(again.json.task.status, 'archived');
  });
});

test('archive requires auth and access: no session → 401, unrelated account → 403', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner2@arch.co');
    const outsider = await signup(base, 'outsider2@arch.co');
    const created = await api(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/archive')).status, 401);
    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/archive', { cookie: outsider.cookie })).status, 403);

    // A missing task → 404 (NO_TASK).
    assert.equal((await api(base, 'POST', '/api/tasks/does-not-exist/archive', { cookie: owner.cookie })).status, 404);
  });
});
