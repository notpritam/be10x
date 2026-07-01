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

const signup = (base, email) =>
  api(base, 'POST', '/api/auth/signup', { body: { email, displayName: email[0].toUpperCase(), password: 'pw12345' } });

test('team owner lists members and sees themselves as owner', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'owner@b.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: a.cookie, body: { name: 'Alpha' } });
    assert.equal(team.status, 200);
    const teamId = team.json.team.id;

    const list = await api(base, 'GET', '/api/teams/' + teamId + '/members', { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.members.length, 1);
    const me = list.json.members[0];
    assert.equal(me.userId, a.json.user.id);
    assert.equal(me.email, 'owner@b.co');
    assert.equal(me.displayName, 'O');
    assert.equal(me.role, 'owner');
  });
});

test('owner adds an existing user by email and they appear in members', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'owner@b.co');
    const b = await signup(base, 'second@b.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: a.cookie, body: { name: 'Alpha' } });
    const teamId = team.json.team.id;

    const added = await api(base, 'POST', '/api/teams/' + teamId + '/members', { cookie: a.cookie, body: { email: 'second@b.co' } });
    assert.equal(added.status, 200);
    assert.equal(added.json.member.userId, b.json.user.id);
    assert.equal(added.json.member.role, 'member');

    const list = await api(base, 'GET', '/api/teams/' + teamId + '/members', { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.members.length, 2);
    const found = list.json.members.find((m) => m.email === 'second@b.co');
    assert.ok(found, 'second user should appear in the member list');
    assert.equal(found.userId, b.json.user.id);
    assert.equal(found.role, 'member');
  });
});

test('a signed-up non-member gets 403 listing members of a team they are not in', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'owner@b.co');
    const outsider = await signup(base, 'outsider@b.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: a.cookie, body: { name: 'Alpha' } });
    const teamId = team.json.team.id;

    const list = await api(base, 'GET', '/api/teams/' + teamId + '/members', { cookie: outsider.cookie });
    assert.equal(list.status, 403);
    assert.equal(list.json.error, 'FORBIDDEN');
  });
});

test('adding an unknown email returns 404 USER_NOT_FOUND', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'owner@b.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: a.cookie, body: { name: 'Alpha' } });
    const teamId = team.json.team.id;

    const added = await api(base, 'POST', '/api/teams/' + teamId + '/members', { cookie: a.cookie, body: { email: 'ghost@nowhere.co' } });
    assert.equal(added.status, 404);
    assert.equal(added.json.error, 'USER_NOT_FOUND');
  });
});

test('a task in plan_review appears in its reviewer\'s /api/reviews/pending', async () => {
  await withServer(async (base) => {
    const author = await signup(base, 'author@b.co');
    const reviewer = await signup(base, 'reviewer@b.co');

    const t = await api(base, 'POST', '/api/tasks', { cookie: author.cookie, body: { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } } });
    const id = t.json.task.id;
    await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: author.cookie, body: { to: 'researching' } });
    const req = await api(base, 'POST', '/api/tasks/' + id + '/review/request', { cookie: author.cookie, body: { reviewerId: reviewer.json.user.id } });
    assert.equal(req.json.task.status, 'plan_review');

    const pending = await api(base, 'GET', '/api/reviews/pending', { cookie: reviewer.cookie });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.tasks.length, 1);
    assert.equal(pending.json.tasks[0].id, id);
    assert.equal(pending.json.tasks[0].status, 'plan_review');
    assert.equal(pending.json.tasks[0].reviewerId, reviewer.json.user.id);

    // The author is not the reviewer, so their pending queue is empty.
    const authorPending = await api(base, 'GET', '/api/reviews/pending', { cookie: author.cookie });
    assert.equal(authorPending.status, 200);
    assert.equal(authorPending.json.tasks.length, 0);
  });
});
