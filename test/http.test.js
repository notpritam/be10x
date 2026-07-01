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

test('signup sets a session and /api/me returns the user', async () => {
  await withServer(async (base) => {
    const s = await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
    assert.equal(s.status, 200);
    assert.equal(s.json.user.email, 'a@b.co');
    const me = await api(base, 'GET', '/api/me', { cookie: s.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, 'a@b.co');
  });
});

test('login with a wrong password is rejected; /api/me without a session is 401', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
    const bad = await api(base, 'POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'BAD_CREDENTIALS');
    const me = await api(base, 'GET', '/api/me', {});
    assert.equal(me.status, 401);
  });
});

test('create a task, read it back, and transition it', async () => {
  await withServer(async (base) => {
    const s = await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
    const c = s.cookie;
    const created = await api(base, 'POST', '/api/tasks', { cookie: c, body: { type: 'general', scope: 'personal', title: 'Idea', content: { summary: 's' } } });
    assert.equal(created.status, 200);
    assert.equal(created.json.task.status, 'backlog');
    const id = created.json.task.id;
    const got = await api(base, 'GET', '/api/tasks/' + id, { cookie: c });
    assert.equal(got.json.task.title, 'Idea');
    const moved = await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: c, body: { to: 'researching' } });
    assert.equal(moved.json.task.status, 'researching');
    const bad = await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: c, body: { to: 'done' } });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, 'ILLEGAL_TRANSITION');
  });
});

test('full review flow: research, request review, approve to ready_to_work', async () => {
  await withServer(async (base) => {
    const a = await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
    const b = await api(base, 'POST', '/api/auth/signup', { body: { email: 'b@b.co', displayName: 'B', password: 'pw12345' } });
    const t = await api(base, 'POST', '/api/tasks', { cookie: a.cookie, body: { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } } });
    const id = t.json.task.id;
    await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: a.cookie, body: { to: 'researching' } });
    const req = await api(base, 'POST', '/api/tasks/' + id + '/review/request', { cookie: a.cookie, body: { reviewerId: b.json.user.id } });
    assert.equal(req.json.task.status, 'plan_review');
    const sub = await api(base, 'POST', '/api/tasks/' + id + '/review/submit', { cookie: b.cookie, body: { verdict: 'approved', comment: 'lgtm' } });
    assert.equal(sub.status, 200);
    const got = await api(base, 'GET', '/api/tasks/' + id, { cookie: a.cookie });
    assert.equal(got.json.task.status, 'ready_to_work');
  });
});

test('serves the static board at /', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Git for Agents/);
  });
});
