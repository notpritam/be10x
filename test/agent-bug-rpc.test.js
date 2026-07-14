// ABOUTME: The board's remote bug-context gateway — POST /api/agent/bug-rpc (Bearer) dispatches a be10x-bugs
// ABOUTME: tool server-side WITH per-account authz, so a member's `connect` agent gets bug context. Also pins
// ABOUTME: the bug-http-server.js wire contract (forwards each call to /api/agent/bug-rpc with the bearer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { callBoardBug } from '../src/mcp/bug-http-server.js';

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

async function signup(base, email) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'U', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie };
}

async function mintToken(base, cookie) {
  const res = await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'laptop' }),
  });
  return (await res.json()).token.token;
}

async function ingestBug(base, token, title) {
  const res = await fetch(base + '/api/agent/bugs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ pageUrl: 'https://app/x', title, severity: 'high', meta: { errorCount: 2, console: [{ ts: 1, level: 'error', text: 'boom' }] } }),
  });
  return (await res.json()).bug;
}

const bugRpc = (base, token, body) =>
  fetch(base + '/api/agent/bug-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

test('bug-rpc dispatches a be10x-bugs tool as the token owner', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base, 'a@b.co');
    const token = await mintToken(base, cookie);
    const bug = await ingestBug(base, token, 'Broken');

    const got = await bugRpc(base, token, { tool: 'bug_get', args: { bug: bug.humanId } });
    assert.equal(got.status, 200);
    assert.equal(got.json.result.humanId, bug.humanId);

    const cons = await bugRpc(base, token, { tool: 'bug_console', args: { bug: bug.id, level: 'error' } });
    assert.equal(cons.status, 200);
    assert.equal(cons.json.result.entries.length, 1);
  });
});

test('bug-rpc enforces authz — a token cannot read another account\'s bug', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const aToken = await mintToken(base, a.cookie);
    const bToken = await mintToken(base, b.cookie);
    const bBug = await ingestBug(base, bToken, 'B private');

    const denied = await bugRpc(base, aToken, { tool: 'bug_get', args: { bug: bBug.id } });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'FORBIDDEN');
  });
});

test('bug-rpc bug_list only returns the caller\'s visible bugs', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const aToken = await mintToken(base, a.cookie);
    const bToken = await mintToken(base, b.cookie);
    await ingestBug(base, aToken, 'A bug');
    await ingestBug(base, bToken, 'B bug');

    const list = await bugRpc(base, aToken, { tool: 'bug_list', args: {} });
    assert.equal(list.status, 200);
    assert.equal(list.json.result.count, 1);
    assert.equal(list.json.result.bugs[0].title, 'A bug');
  });
});

test('bug-rpc rejects a missing token (401) and an unknown tool (400)', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base, 'a@b.co');
    const token = await mintToken(base, cookie);

    const noTok = await bugRpc(base, null, { tool: 'bug_list', args: {} });
    assert.equal(noTok.status, 401);

    const bad = await bugRpc(base, token, { tool: 'bug_nope', args: {} });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'UNKNOWN_TOOL');
  });
});

// --- bug-http-server.js wire contract (the remote MCP client half) -----------------------------------
function fakeFetch(status, json) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test('callBoardBug POSTs { tool, args } to /api/agent/bug-rpc with the bearer token', async () => {
  const f = fakeFetch(200, { result: { humanId: 'BUG-001' } });
  const out = await callBoardBug('bug_get', { bug: 'BUG-001' }, { board: 'https://board.test/', token: 'gfa_abc', fetchImpl: f });
  assert.deepEqual(out, { humanId: 'BUG-001' });
  assert.equal(f.calls[0].url, 'https://board.test/api/agent/bug-rpc');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer gfa_abc');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { tool: 'bug_get', args: { bug: 'BUG-001' } });
});

test('callBoardBug throws the board domain error on a non-2xx', async () => {
  const f = fakeFetch(403, { error: 'FORBIDDEN' });
  await assert.rejects(() => callBoardBug('bug_get', { bug: 'x' }, { board: 'https://b.test', token: 't', fetchImpl: f }), /FORBIDDEN/);
});
