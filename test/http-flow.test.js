// The board-driven half of the loop: human HTTP actions must enqueue the right agent wakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { listPendingWakes } from '../src/executor/wake.js';

// Like http.test.js's withServer, but also hands the db to the test so it can inspect the wake queue
// (which has no public API surface — it's internal orchestration state).
async function withServerDb(fn) {
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

async function signup(base) {
  const s = await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
  return s.cookie;
}
async function newTask(base, c) {
  const r = await api(base, 'POST', '/api/tasks', { cookie: c, body: { type: 'general', scope: 'personal', title: 'Idea', content: { summary: 's' } } });
  return r.json.task;
}

test('hand-to-agent moves backlog→researching and enqueues a plan wake', async () => {
  await withServerDb(async (base, db) => {
    const c = await signup(base);
    const t = await newTask(base, c);
    const r = await api(base, 'POST', '/api/tasks/' + t.id + '/hand-to-agent', { cookie: c });
    assert.equal(r.json.task.status, 'researching');
    const wakes = listPendingWakes(db, t.id);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].reason, 'plan');
  });
});

test('a comment on a plan_review task enqueues a revise wake and appears in the thread', async () => {
  await withServerDb(async (base, db) => {
    const c = await signup(base);
    const t = await newTask(base, c);
    await api(base, 'POST', '/api/tasks/' + t.id + '/transition', { cookie: c, body: { to: 'researching' } });
    await api(base, 'POST', '/api/tasks/' + t.id + '/review/request', { cookie: c, body: { reviewerId: t.ownerId } });
    const got = await api(base, 'GET', '/api/tasks/' + t.id, { cookie: c });
    assert.equal(got.json.task.status, 'plan_review');

    const cm = await api(base, 'POST', '/api/tasks/' + t.id + '/comments', { cookie: c, body: { body: 'tighten step 2', anchor: 'plan_line' } });
    assert.equal(cm.json.comment.body, 'tighten step 2');
    const list = await api(base, 'GET', '/api/tasks/' + t.id + '/comments', { cookie: c });
    assert.equal(list.json.comments.length, 1);
    assert.ok(listPendingWakes(db, t.id).some((w) => w.reason === 'revise'));
  });
});

test('approving a review enqueues an execute wake; pick-up-now enqueues its own', async () => {
  await withServerDb(async (base, db) => {
    const c = await signup(base);
    const t = await newTask(base, c);
    await api(base, 'POST', '/api/tasks/' + t.id + '/transition', { cookie: c, body: { to: 'researching' } });
    await api(base, 'POST', '/api/tasks/' + t.id + '/review/request', { cookie: c, body: { reviewerId: t.ownerId } });
    const appr = await api(base, 'POST', '/api/tasks/' + t.id + '/review/submit', { cookie: c, body: { verdict: 'approved' } });
    assert.equal(appr.status, 200);
    assert.equal((await api(base, 'GET', '/api/tasks/' + t.id, { cookie: c })).json.task.status, 'ready_to_work');
    assert.ok(listPendingWakes(db, t.id).some((w) => w.reason === 'execute'));

    await api(base, 'POST', '/api/tasks/' + t.id + '/pick-up-now', { cookie: c });
    assert.ok(listPendingWakes(db, t.id).some((w) => w.reason === 'pick_up_now'));
  });
});
