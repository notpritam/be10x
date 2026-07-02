import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

// The device-authorization HTTP surface behind `be10x login`: /api/device/{code,token,approve,deny,pending}.
// Driven over a real loopback server, the way the CLI and the browser approve screen will hit it.

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

async function req(base, method, path, { cookie, token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

async function signup(base, email = 'a@b.co') {
  const s = await req(base, 'POST', '/api/auth/signup', { body: { email, displayName: 'A', password: 'pw12345' } });
  return s.cookie;
}

test('device code → approve → token is the full paste-free login round-trip', async () => {
  await withServer(async (base) => {
    // 1. The CLI (no session) mints a code.
    const start = await req(base, 'POST', '/api/device/code', { body: { label: 'pritam-macbook' } });
    assert.equal(start.status, 200);
    assert.match(start.json.deviceCode, /^[0-9a-f]{64}$/);
    assert.match(start.json.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(start.json.verificationUriComplete.endsWith('/connect?code=' + encodeURIComponent(start.json.userCode)));
    assert.ok(start.json.expiresIn > 0 && start.json.interval >= 1);

    // 2. Before approval the CLI poll is pending.
    const pendingPoll = await req(base, 'POST', '/api/device/token', { body: { deviceCode: start.json.deviceCode } });
    assert.equal(pendingPoll.json.status, 'pending');

    // 3. The user logs into the board and the approve screen shows what's asking.
    const cookie = await signup(base);
    const info = await req(base, 'GET', '/api/device/pending?code=' + encodeURIComponent(start.json.userCode), { cookie });
    assert.equal(info.json.label, 'pritam-macbook');
    assert.equal(info.json.status, 'pending');

    // 4. The user approves.
    const ok = await req(base, 'POST', '/api/device/approve', { cookie, body: { code: start.json.userCode } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);

    // 5. The CLI's next poll collects a real token...
    const got = await req(base, 'POST', '/api/device/token', { body: { deviceCode: start.json.deviceCode } });
    assert.equal(got.json.status, 'approved');
    assert.match(got.json.token, /^gfa_[0-9a-f]{48}$/);
    assert.equal(got.json.user.email, 'a@b.co');

    // ...and that token drives the agent API as the approving user.
    const rpc = await req(base, 'POST', '/api/agent/rpc', {
      token: got.json.token,
      body: { tool: 'gfa_list_tasks', args: {} },
    });
    assert.equal(rpc.status, 200, 'the device token authenticates the agent transport');

    // 6. The token is single-use over the back channel.
    const again = await req(base, 'POST', '/api/device/token', { body: { deviceCode: start.json.deviceCode } });
    assert.equal(again.json.status, 'consumed');
  });
});

test('approve requires a logged-in session (401 without a cookie)', async () => {
  await withServer(async (base) => {
    const start = await req(base, 'POST', '/api/device/code', { body: { label: 'x' } });
    const noAuth = await req(base, 'POST', '/api/device/approve', { body: { code: start.json.userCode } });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.error, 'NO_SESSION');
  });
});

test('deny makes the CLI poll return denied', async () => {
  await withServer(async (base) => {
    const start = await req(base, 'POST', '/api/device/code', { body: { label: 'x' } });
    const cookie = await signup(base);
    const denied = await req(base, 'POST', '/api/device/deny', { cookie, body: { code: start.json.userCode } });
    assert.equal(denied.status, 200);
    const poll = await req(base, 'POST', '/api/device/token', { body: { deviceCode: start.json.deviceCode } });
    assert.equal(poll.json.status, 'denied');
  });
});

test('pending lookup of an unknown code is 404', async () => {
  await withServer(async (base) => {
    const cookie = await signup(base);
    const miss = await req(base, 'GET', '/api/device/pending?code=ZZZZ-ZZZZ', { cookie });
    assert.equal(miss.status, 404);
  });
});
