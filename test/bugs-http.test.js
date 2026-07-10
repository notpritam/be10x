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
          sessionKey: 'k4',
          identity: { loggedIn: true, email: 'buyer@x.co' },
          meta: { selector: '#pay', markers: [{ t: 1, label: 'bug' }] },
        }),
      })
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.bug.humanId, 'BUG-001');
    assert.equal(ingest.body.bug.reporterId, userId);
    assert.equal(ingest.body.bug.sessionKey, 'k4'); // the rrweb recording key surfaces on the hydrated bug
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

test('a bug ingested with tags + teamId + projectId round-trips through GET /api/bugs/:id', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base);
    const token = await mintToken(base, cookie);

    // A real team (session route) and a real project (Bearer route the extension uses) to attach to.
    const team = (
      await json(
        await fetch(base + '/api/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ name: 'Checkout Squad' }),
        })
      )
    ).body.team;
    const project = (
      await json(
        await fetch(base + '/api/agent/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ key: 'github.com/acme/store', name: 'store' }),
        })
      )
    ).body.project;

    const ingest = await json(
      await fetch(base + '/api/agent/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          pageUrl: 'https://app.example.com/x',
          title: 'Tagged bug',
          teamId: team.id,
          projectId: project.id,
          tags: ['checkout', 'regression'],
        }),
      })
    );
    assert.equal(ingest.status, 200);
    assert.deepEqual(ingest.body.bug.tags, ['checkout', 'regression']);
    assert.equal(ingest.body.bug.teamId, team.id);
    assert.equal(ingest.body.bug.projectId, project.id);
    const bugId = ingest.body.bug.id;

    // Round-trips through the dashboard detail route: tags is an array, team/project stick.
    const detail = await json(await fetch(base + '/api/bugs/' + bugId, { headers: { cookie } }));
    assert.deepEqual(detail.body.bug.tags, ['checkout', 'regression']);
    assert.equal(detail.body.bug.teamId, team.id);
    assert.equal(detail.body.bug.projectId, project.id);
  });
});

test('GET /api/agent/teams and /api/agent/projects return the caller\'s teams/projects (Bearer), 401 without a token', async () => {
  await withServer(async (base) => {
    const { cookie } = await signup(base);
    const token = await mintToken(base, cookie);
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

    const team = (
      await json(
        await fetch(base + '/api/teams', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ name: 'Payments' }) })
      )
    ).body.team;
    const project = (
      await json(
        await fetch(base + '/api/agent/projects', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'github.com/acme/pay', name: 'pay' }) })
      )
    ).body.project;

    // Bearer: the token's user sees their team (same {id,name,slug} shape as the session route) ...
    const teams = await json(await fetch(base + '/api/agent/teams', { headers: auth }));
    assert.equal(teams.status, 200);
    assert.ok(teams.body.teams.some((t) => t.id === team.id && t.name === 'Payments' && typeof t.slug === 'string'));

    // ... and their project.
    const projects = await json(await fetch(base + '/api/agent/projects', { headers: auth }));
    assert.equal(projects.status, 200);
    assert.ok(projects.body.projects.some((p) => p.id === project.id && p.key === 'github.com/acme/pay'));

    // No Bearer token → 401 on both.
    assert.equal((await fetch(base + '/api/agent/teams')).status, 401);
    assert.equal((await fetch(base + '/api/agent/projects')).status, 401);
  });
});
