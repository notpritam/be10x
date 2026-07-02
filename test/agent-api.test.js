import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

// The token-authenticated agent/runner API (/api/agent/*) — how an agent on a MEMBER's own machine reaches
// a hosted board. These tests drive it over a real loopback server, the way the HTTP MCP transport and the
// `be10x connect` runner will.

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

// Bearer-token request (the agent transport) — no session cookie.
async function agent(base, method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Session request (a human) — used only to bootstrap a user + mint a token.
async function session(base, method, path, { cookie, body } = {}) {
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

// Sign up a human and mint a personal access token — the credential the member's machine uses.
async function boot(base, email = 'a@b.co') {
  const s = await session(base, 'POST', '/api/auth/signup', {
    body: { email, displayName: 'A', password: 'pw12345' },
  });
  const me = await session(base, 'GET', '/api/me', { cookie: s.cookie });
  const t = await session(base, 'POST', '/api/tokens', { cookie: s.cookie, body: { name: 'my-laptop' } });
  return { cookie: s.cookie, userId: me.json.user.id, token: t.json.token.token };
}

test('rpc gateway dispatches a gfa_* tool as the token owner', async () => {
  await withServer(async (base) => {
    const { userId, token } = await boot(base);

    const created = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_create_task', args: { type: 'general', scope: 'personal', title: 'from my machine', content: { summary: 'hi' } } },
    });
    assert.equal(created.status, 200);
    const task = created.json.result;
    assert.ok(task.id, 'returns the created task');
    assert.equal(task.title, 'from my machine');
    assert.equal(task.status, 'backlog');
    assert.equal(task.ownerId, userId, 'the task is owned by the token holder, not "agent"');

    // And it can read it straight back through the same gateway.
    const got = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_get_task', args: { taskId: task.id } },
    });
    assert.equal(got.status, 200);
    assert.equal(got.json.result.id, task.id);
  });
});

test('rpc gateway rejects a missing or invalid token with 401', async () => {
  await withServer(async (base) => {
    await boot(base);
    const noTok = await agent(base, 'POST', '/api/agent/rpc', { body: { tool: 'gfa_list_tasks', args: {} } });
    assert.equal(noTok.status, 401);
    assert.equal(noTok.json.error, 'BAD_TOKEN');

    const badTok = await agent(base, 'POST', '/api/agent/rpc', {
      token: 'gfa_' + '0'.repeat(48),
      body: { tool: 'gfa_list_tasks', args: {} },
    });
    assert.equal(badTok.status, 401);
    assert.equal(badTok.json.error, 'BAD_TOKEN');
  });
});

test('rpc gateway 400s an unknown tool', async () => {
  await withServer(async (base) => {
    const { token } = await boot(base);
    const res = await agent(base, 'POST', '/api/agent/rpc', { token, body: { tool: 'gfa_nope', args: {} } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'UNKNOWN_TOOL');
  });
});

test('rpc gateway passes a domain error through with the right status (NO_TASK -> 404)', async () => {
  await withServer(async (base) => {
    const { token } = await boot(base);
    // gfa_submit_output on a task that doesn't exist -> core throws NO_TASK -> 404 (the appendEvent/setRefs
    // guard added for the distributed crash fix). Proves errors aren't swallowed as 200s.
    const res = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_submit_output', args: { taskId: 'does-not-exist', refs: { pr: 'x' } } },
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'NO_TASK');
  });
});
