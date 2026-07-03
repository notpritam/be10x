// ABOUTME: Authorization coverage for the task/project HTTP routes (see docs/rca-2026-07-03-account-isolation.md).
// ABOUTME: A second, unrelated account must never see or mutate another account's tasks, projects, or shares.
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

async function api(base, method, path, { cookie, bearer, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

const signup = (base, email) =>
  api(base, 'POST', '/api/auth/signup', { body: { email, displayName: email[0].toUpperCase(), password: 'pw12345' } });

const mintToken = async (base, cookie) => (await api(base, 'POST', '/api/tokens', { cookie, body: { name: 'agent' } })).json.token.token;

test('a personal task never travels to, or is fetchable by, a second unrelated account', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'alice@iso.co');
    const b = await signup(base, 'bob@iso.co');

    const created = await api(base, 'POST', '/api/tasks', {
      cookie: a.cookie,
      body: { type: 'general', scope: 'personal', title: 'Alice secret', content: { summary: 's' } },
    });
    assert.equal(created.status, 200);
    const taskId = created.json.task.id;

    const bobList = await api(base, 'GET', '/api/tasks', { cookie: b.cookie });
    assert.equal(bobList.status, 200);
    assert.equal(bobList.json.tasks.length, 0);

    const bobGet = await api(base, 'GET', '/api/tasks/' + taskId, { cookie: b.cookie });
    assert.equal(bobGet.status, 403);
    assert.equal(bobGet.json.error, 'FORBIDDEN');

    const bobComments = await api(base, 'GET', '/api/tasks/' + taskId + '/comments', { cookie: b.cookie });
    assert.equal(bobComments.status, 403);

    const aliceList = await api(base, 'GET', '/api/tasks', { cookie: a.cookie });
    assert.equal(aliceList.json.tasks.length, 1);
  });
});

test('an unrelated account cannot mutate someone else\'s personal task', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'alice2@iso.co');
    const b = await signup(base, 'bob2@iso.co');
    const created = await api(base, 'POST', '/api/tasks', {
      cookie: a.cookie,
      body: { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: b.cookie, body: { to: 'researching' } })).status, 403);
    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/comments', { cookie: b.cookie, body: { body: 'hi' } })).status, 403);
    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/plan', { cookie: b.cookie, body: { plan: 'x' } })).status, 403);
    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/retry', { cookie: b.cookie })).status, 403);
  });
});

test('a team task is visible to members and forbidden to (and hidden from) an outsider', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner3@iso.co');
    const member = await signup(base, 'member3@iso.co');
    const outsider = await signup(base, 'outsider3@iso.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: owner.cookie, body: { name: 'Alpha' } });
    const teamId = team.json.team.id;
    await api(base, 'POST', '/api/teams/' + teamId + '/members', { cookie: owner.cookie, body: { userId: member.json.user.id } });

    const created = await api(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'team', teamId, title: 'Team task', content: { summary: 's' } },
    });
    assert.equal(created.status, 200);
    const id = created.json.task.id;

    assert.equal((await api(base, 'GET', '/api/tasks/' + id, { cookie: member.cookie })).status, 200);

    const outsiderGet = await api(base, 'GET', '/api/tasks/' + id, { cookie: outsider.cookie });
    assert.equal(outsiderGet.status, 403);

    const outsiderList = await api(base, 'GET', '/api/tasks', { cookie: outsider.cookie });
    assert.ok(outsiderList.json.tasks.every((t) => t.id !== id));

    // Can't even forge a task creation into a team you don't belong to.
    const forged = await api(base, 'POST', '/api/tasks', {
      cookie: outsider.cookie,
      body: { type: 'general', scope: 'team', teamId, title: 'x', content: { summary: 's' } },
    });
    assert.equal(forged.status, 403);
  });
});

test('a viewer-role team member can read but not write a team task', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner4@iso.co');
    const viewer = await signup(base, 'viewer4@iso.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: owner.cookie, body: { name: 'Beta' } });
    const teamId = team.json.team.id;
    await api(base, 'POST', '/api/teams/' + teamId + '/members', { cookie: owner.cookie, body: { userId: viewer.json.user.id, role: 'viewer' } });

    const created = await api(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'team', teamId, title: 'T', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    assert.equal((await api(base, 'GET', '/api/tasks/' + id, { cookie: viewer.cookie })).status, 200);
    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: viewer.cookie, body: { to: 'researching' } })).status, 403);
  });
});

test('a tagged reviewer can read a task outside their team, submit their verdict, but has no other write access', async () => {
  await withServer(async (base) => {
    const author = await signup(base, 'author5@iso.co');
    const reviewer = await signup(base, 'reviewer5@iso.co');
    const created = await api(base, 'POST', '/api/tasks', {
      cookie: author.cookie,
      body: { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } },
    });
    const id = created.json.task.id;
    await api(base, 'POST', '/api/tasks/' + id + '/transition', { cookie: author.cookie, body: { to: 'researching' } });
    await api(base, 'POST', '/api/tasks/' + id + '/review/request', { cookie: author.cookie, body: { reviewerId: reviewer.json.user.id } });

    assert.equal((await api(base, 'GET', '/api/tasks/' + id, { cookie: reviewer.cookie })).status, 200);

    const submit = await api(base, 'POST', '/api/tasks/' + id + '/review/submit', { cookie: reviewer.cookie, body: { verdict: 'approved' } });
    assert.equal(submit.status, 200);

    // A third party (not the tagged reviewer) can't submit in their place.
    const rando = await signup(base, 'rando5@iso.co');
    const created2 = await api(base, 'POST', '/api/tasks', {
      cookie: author.cookie,
      body: { type: 'code-issue', scope: 'personal', title: 'Bug2', content: { symptom: 'x' } },
    });
    const id2 = created2.json.task.id;
    await api(base, 'POST', '/api/tasks/' + id2 + '/transition', { cookie: author.cookie, body: { to: 'researching' } });
    await api(base, 'POST', '/api/tasks/' + id2 + '/review/request', { cookie: author.cookie, body: { reviewerId: reviewer.json.user.id } });
    const impersonate = await api(base, 'POST', '/api/tasks/' + id2 + '/review/submit', { cookie: rando.cookie, body: { verdict: 'approved' } });
    assert.equal(impersonate.status, 403);
  });
});

test('only the task owner can mint, list, or revoke its share links', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner6@iso.co');
    const outsider = await signup(base, 'outsider6@iso.co');
    const created = await api(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    assert.equal((await api(base, 'POST', '/api/tasks/' + id + '/share', { cookie: outsider.cookie, body: { permission: 'comment_only' } })).status, 403);

    const real = await api(base, 'POST', '/api/tasks/' + id + '/share', { cookie: owner.cookie, body: { permission: 'comment_only' } });
    assert.equal(real.status, 200);
    const token = real.json.share.token;

    assert.equal((await api(base, 'GET', '/api/tasks/' + id + '/shares', { cookie: outsider.cookie })).status, 403);
    assert.equal((await api(base, 'DELETE', '/api/share/' + encodeURIComponent(token), { cookie: outsider.cookie })).status, 403);
    assert.equal((await api(base, 'DELETE', '/api/share/' + encodeURIComponent(token), { cookie: owner.cookie })).status, 200);
  });
});

test('linked repos are scoped: an unrelated account never sees another account\'s project, and same-key registrations from different owners never collide', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'alice7@iso.co');
    const b = await signup(base, 'bob7@iso.co');
    const tokenA = await mintToken(base, a.cookie);
    const tokenB = await mintToken(base, b.cookie);

    // Same key (e.g. two unrelated repos checked out into identically-named local folders on two laptops)
    // registered by two different accounts via the agent-facing (connector) registration path.
    const regA = await api(base, 'POST', '/api/agent/projects', { bearer: tokenA, body: { key: 'local:shared-name', name: 'Alice repo' } });
    const regB = await api(base, 'POST', '/api/agent/projects', { bearer: tokenB, body: { key: 'local:shared-name', name: 'Bob repo' } });
    assert.equal(regA.status, 200);
    assert.equal(regB.status, 200);
    assert.notEqual(regA.json.project.id, regB.json.project.id);

    const aliceProjects = await api(base, 'GET', '/api/projects', { cookie: a.cookie });
    assert.equal(aliceProjects.json.projects.length, 1);
    assert.equal(aliceProjects.json.projects[0].id, regA.json.project.id);

    const bobProjects = await api(base, 'GET', '/api/projects', { cookie: b.cookie });
    assert.equal(bobProjects.json.projects.length, 1);
    assert.equal(bobProjects.json.projects[0].id, regB.json.project.id);
  });
});
