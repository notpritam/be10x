// ABOUTME: HTTP test for the bug artifact route — a signed UploadThing read URL when the key is present,
// ABOUTME: 404 when it isn't. Same real-server withServer style as test/bugs-http.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

// A fake, well-formed UPLOADTHING_TOKEN (base64 JSON) so signAccessUrl can build a signature without a
// real bucket. Set on process.env for the server the handler reads from, restored after.
const FAKE_TOKEN = Buffer.from(
  JSON.stringify({ apiKey: 'sk_test_artifact', appId: 'appzzz', regions: ['sea1'] })
).toString('base64');

async function withServer(fn) {
  const prev = process.env.UPLOADTHING_TOKEN;
  process.env.UPLOADTHING_TOKEN = FAKE_TOKEN;
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
    if (prev === undefined) delete process.env.UPLOADTHING_TOKEN;
    else process.env.UPLOADTHING_TOKEN = prev;
  }
}

async function json(res) {
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signupAndToken(base) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'qa@b.co', displayName: 'QA', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const tokRes = await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'extension' }),
  });
  const token = (await tokRes.json()).token.token; // gfa_...
  return { cookie, token };
}

async function ingestBug(base, token, extra) {
  const res = await fetch(base + '/api/agent/bugs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ pageUrl: 'https://app.example.com/x', title: 'Broken', severity: 'high', ...extra }),
  });
  return (await res.json()).bug;
}

test('bug artifact route: signed URL when the key exists, 404 when it does not', async () => {
  await withServer(async (base) => {
    const { cookie, token } = await signupAndToken(base);

    // A bug WITH a screenshot key → the route hands back a short-lived signed read URL.
    const withShot = await ingestBug(base, token, { screenshotKey: 'shotkey123' });
    const got = await json(
      await fetch(base + '/api/bugs/' + withShot.id + '/artifact/screenshot', { headers: { cookie } })
    );
    assert.equal(got.status, 200);
    assert.equal(typeof got.body.url, 'string');
    const u = new URL(got.body.url);
    assert.equal(u.host, 'appzzz.ufs.sh');
    assert.equal(u.pathname, '/f/shotkey123');
    assert.ok(u.searchParams.get('expires'));
    assert.ok(u.searchParams.get('signature'));

    // The same bug has no DOM key → 404 for that kind (distinguishes "no data" from a signed URL).
    const noDom = await fetch(base + '/api/bugs/' + withShot.id + '/artifact/dom', { headers: { cookie } });
    assert.equal(noDom.status, 404);

    // A bug WITHOUT the screenshot key → 404.
    const noShot = await ingestBug(base, token, { domKey: 'domkey' });
    const missing = await fetch(base + '/api/bugs/' + noShot.id + '/artifact/screenshot', { headers: { cookie } });
    assert.equal(missing.status, 404);

    // Unknown bug id → 404.
    const unknown = await fetch(base + '/api/bugs/does-not-exist/artifact/screenshot', { headers: { cookie } });
    assert.equal(unknown.status, 404);

    // Session required — no cookie is a 401, never a signed URL leak.
    const noAuth = await fetch(base + '/api/bugs/' + withShot.id + '/artifact/screenshot');
    assert.equal(noAuth.status, 401);
  });
});

test('bug artifact route: kind=session signs the rrweb recording key, 404 when absent', async () => {
  await withServer(async (base) => {
    const { cookie, token } = await signupAndToken(base);

    // A bug carrying an rrweb session recording → artifact/session hands back a signed read URL for it.
    const withSession = await ingestBug(base, token, {
      sessionKey: 'sesskey789',
      meta: { markers: [{ t: 1783619469393, label: 'This is the bug' }] },
    });
    const got = await json(
      await fetch(base + '/api/bugs/' + withSession.id + '/artifact/session', { headers: { cookie } })
    );
    assert.equal(got.status, 200);
    assert.equal(typeof got.body.url, 'string');
    const u = new URL(got.body.url);
    assert.equal(u.host, 'appzzz.ufs.sh');
    assert.equal(u.pathname, '/f/sesskey789');
    assert.ok(u.searchParams.get('signature'));

    // An older bug with no recording → 404 for kind=session (distinct from a signed URL / an error).
    const noSession = await ingestBug(base, token, { screenshotKey: 'shotonly' });
    const missing = await fetch(base + '/api/bugs/' + noSession.id + '/artifact/session', { headers: { cookie } });
    assert.equal(missing.status, 404);
  });
});
