import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDeviceLogin } from '../src/connect/connect.js';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

// `be10x login`'s driver: mint a code, open the approve URL, poll until approved. fetch/open/sleep are
// injected so we exercise the whole polling state machine deterministically, no server or browser needed.

const okJson = (obj) => ({ ok: true, json: async () => obj });

test('opens the approve URL and returns the token once approved', async () => {
  let polls = 0;
  let opened = null;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/device/code')) {
      return okJson({
        deviceCode: 'dc',
        userCode: 'WXYZ-2345',
        interval: 1,
        expiresIn: 600,
        verificationUriComplete: 'https://board/connect?code=WXYZ-2345',
      });
    }
    if (url.endsWith('/api/device/token')) {
      polls++;
      return polls < 3
        ? okJson({ status: 'pending' })
        : okJson({ status: 'approved', token: 'gfa_' + '1'.repeat(48), user: { email: 'a@b.co', displayName: 'A' } });
    }
    throw new Error('unexpected ' + url);
  };

  const res = await runDeviceLogin({
    board: 'https://board/', // trailing slash should be trimmed
    label: 'lap',
    fetchImpl,
    open: (u) => (opened = u),
    sleep: async () => {},
  });

  assert.equal(res.token, 'gfa_' + '1'.repeat(48));
  assert.equal(res.board, 'https://board', 'trailing slash trimmed off the saved board');
  assert.equal(res.user.email, 'a@b.co');
  assert.equal(opened, 'https://board/connect?code=WXYZ-2345', 'browser opened at the approve URL');
  assert.ok(polls >= 3, 'kept polling until approved');
});

test('throws when the board denies the request', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/api/device/code')
      ? okJson({ deviceCode: 'dc', userCode: 'X', interval: 1, expiresIn: 600, verificationUriComplete: 'u' })
      : okJson({ status: 'denied' });
  await assert.rejects(runDeviceLogin({ board: 'b', fetchImpl, sleep: async () => {}, open: () => {} }), /denied/);
});

test('throws when the code expires before approval', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/api/device/code')
      ? okJson({ deviceCode: 'dc', userCode: 'X', interval: 1, expiresIn: 600, verificationUriComplete: 'u' })
      : okJson({ status: 'expired' });
  await assert.rejects(runDeviceLogin({ board: 'b', fetchImpl, sleep: async () => {}, open: () => {} }), /expired/);
});

test('requires a board url', async () => {
  await assert.rejects(runDeviceLogin({ board: '', fetchImpl: async () => okJson({}) }), /board URL/);
});

test('survives a transient poll error and keeps waiting', async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/device/code')) {
      return okJson({ deviceCode: 'dc', userCode: 'X', interval: 1, expiresIn: 600, verificationUriComplete: 'u' });
    }
    polls++;
    if (polls === 1) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return okJson({ status: 'approved', token: 'gfa_tok', user: null });
  };
  const res = await runDeviceLogin({ board: 'b', fetchImpl, sleep: async () => {}, open: () => {} });
  assert.equal(res.token, 'gfa_tok');
  assert.ok(polls >= 2, 'a failed poll did not abort the login');
});

// Capstone: the real CLI driver against a real board. runDeviceLogin polls the actual /api/device endpoints
// while a simulated browser (a session-cookie'd fetch) approves — the whole paste-free login, end to end.
test('e2e: runDeviceLogin against a real board completes when the browser approves', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    // A user signs up on the board (session cookie = the logged-in browser).
    const su = await fetch(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@team.co', displayName: 'Dev', password: 'pw12345' }),
    });
    const cookie = su.headers.get('set-cookie').split(';')[0];

    // The moment the CLI shows its code, the "browser" approves it (as the login() callback surfaces it).
    let approved = false;
    const res = await runDeviceLogin({
      board: base,
      label: 'pritam-macbook',
      open: () => {},
      sleep: () => new Promise((r) => setTimeout(r, 15)),
      log: (ev) => {
        if (ev.event === 'code' && !approved) {
          approved = true;
          void fetch(base + '/api/device/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie },
            body: JSON.stringify({ code: ev.userCode }),
          });
        }
      },
    });

    assert.match(res.token, /^gfa_[0-9a-f]{48}$/, 'the CLI collected a real token');
    assert.equal(res.user.email, 'dev@team.co');

    // And that token authenticates the agent transport as the approving user.
    const rpc = await fetch(base + '/api/agent/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + res.token },
      body: JSON.stringify({ tool: 'gfa_list_tasks', args: {} }),
    });
    assert.equal(rpc.status, 200, 'device-login token drives the agent API');
  } finally {
    await new Promise((r) => app.close(r));
  }
});
