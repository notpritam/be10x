// ABOUTME: HTTP tests for the bug routes — Bearer ingest (extension side) + session dashboard routes —
// ABOUTME: against a real in-memory server via createApp(db), exactly like test/http.test.js.
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

async function json(res) {
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signup(base, email = 'qa@b.co') {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'QA', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const body = await res.json();
  return { cookie, userId: body.user.id };
}

async function mintToken(base, cookie) {
  const res = await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'extension' }),
  });
  return (await res.json()).token.token; // gfa_...
}

test('extension ingests a bug (Bearer); dashboard lists, reads, resolves it (session)', async () => {
  await withServer(async (base) => {
    const { cookie, userId } = await signup(base);
    const token = await mintToken(base, cookie);

    // Ingest as the extension would — Bearer token, keys + metadata only.
    const ingest = await json(
      await fetch(base + '/api/agent/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          pageUrl: 'https://app.example.com/x',
          title: 'Broken',
          description: 'oops',
          severity: 'high',
          screenshotKey: 'k1',
          domKey: 'k2',
          networkKey: 'k3',
          identity: { loggedIn: true, email: 'buyer@x.co' },
          meta: { selector: '#pay' },
        }),
      })
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.bug.humanId, 'BUG-001');
    assert.equal(ingest.body.bug.reporterId, userId);
    const bugId = ingest.body.bug.id;

    // A bad token is rejected.
    const bad = await fetch(base + '/api/agent/bugs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ pageUrl: 'x', title: 't' }),
    });
    assert.equal(bad.status, 401);

    // Dashboard: list (session cookie).
    const list = await json(await fetch(base + '/api/bugs', { headers: { cookie } }));
    assert.equal(list.body.bugs.length, 1);
    assert.equal(list.body.bugs[0].id, bugId);

    // Dashboard: detail with events.
    const detail = await json(await fetch(base + '/api/bugs/' + bugId, { headers: { cookie } }));
    assert.equal(detail.body.bug.title, 'Broken');
    assert.equal(detail.body.events[0].kind, 'created');

    // Dashboard: resolve.
    const resolved = await json(
      await fetch(base + '/api/bugs/' + bugId + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ status: 'resolved', resolution: 'fixed' }),
      })
    );
    assert.equal(resolved.body.bug.status, 'resolved');

    // Comment trail.
    await fetch(base + '/api/bugs/' + bugId + '/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ body: 'verified fixed' }),
    });
    const withComment = await json(await fetch(base + '/api/bugs/' + bugId, { headers: { cookie } }));
    assert.ok(withComment.body.events.some((e) => e.kind === 'comment' && e.payload.body === 'verified fixed'));

    // Stats for the reporter (route must resolve before /:id).
    const stats = await json(await fetch(base + '/api/bugs/stats', { headers: { cookie } }));
    assert.deepEqual(stats.body.stats, { reported: 1, resolved: 1, open: 0 });

    // Listing requires a session.
    const noAuth = await fetch(base + '/api/bugs');
    assert.equal(noAuth.status, 401);
  });
});
