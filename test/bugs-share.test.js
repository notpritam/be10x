// ABOUTME: Tests for public, view-only bug share links — the pure bug-share core plus the HTTP flow
// ABOUTME: (mint / public view with no cookie / list / public signed artifact / revoke) via a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createUser } from '../src/auth/users.js';
import { createBug } from '../src/bugs/bugs.js';
import {
  createBugShareLink,
  getActiveBugShareByToken,
  listBugShareLinksForBug,
  revokeBugShareLink,
  bugShareView,
} from '../src/share/bug-share.js';

// --- core module ---------------------------------------------------------------------------------

function seedBug(db) {
  const reporter = createUser(db, { email: 'r@b.co', displayName: 'R', password: 'pw12345' }).id;
  const bug = createBug(db, { reporterId: reporter, pageUrl: 'https://app.example.com/x', title: 'Broken', severity: 'high' });
  return { reporter, bugId: bug.id };
}

test('createBugShareLink mints an unguessable token and getActiveBugShareByToken resolves it', () => {
  const db = openDb(':memory:');
  const { reporter, bugId } = seedBug(db);
  const link = createBugShareLink(db, { bugId, createdBy: reporter });
  assert.equal(link.bug_id, bugId);
  assert.equal(link.created_by, reporter);
  assert.equal(link.revoked_at, null);
  assert.match(link.token, /^[0-9a-f]{64}$/); // 32 random bytes as hex

  const found = getActiveBugShareByToken(db, link.token);
  assert.equal(found.id, link.id);
  assert.equal(getActiveBugShareByToken(db, 'nope'), null);
});

test('createBugShareLink defaults createdBy to null (the recipient may be anonymous)', () => {
  const db = openDb(':memory:');
  const { bugId } = seedBug(db);
  assert.equal(createBugShareLink(db, { bugId }).created_by, null);
});

test('revokeBugShareLink makes the token read as gone (getActiveBugShareByToken => null)', () => {
  const db = openDb(':memory:');
  const { bugId } = seedBug(db);
  const link = createBugShareLink(db, { bugId });
  assert.equal(revokeBugShareLink(db, link.token), 1);
  assert.equal(getActiveBugShareByToken(db, link.token), null);
  assert.equal(bugShareView(db, link.token), null); // a revoked token exposes nothing
  assert.equal(revokeBugShareLink(db, link.token), 0); // idempotent: re-revoking is a no-op
});

test('listBugShareLinksForBug returns every minted link, newest first', () => {
  const db = openDb(':memory:');
  const { bugId } = seedBug(db);
  const a = createBugShareLink(db, { bugId });
  const b = createBugShareLink(db, { bugId });
  const ids = listBugShareLinksForBug(db, bugId).map((l) => l.id);
  assert.deepEqual(ids, [b.id, a.id]);
});

test('bugShareView exposes the FULL raw bug behind a live token, null once revoked', () => {
  const db = openDb(':memory:');
  const { reporter, bugId } = seedBug(db);
  const link = createBugShareLink(db, { bugId, createdBy: reporter });
  const view = bugShareView(db, link.token);
  assert.equal(view.id, bugId);
  assert.equal(view.title, 'Broken');
  assert.equal(view.reporterId, reporter); // the whole hydrated bug, no redaction
  revokeBugShareLink(db, link.token);
  assert.equal(bugShareView(db, link.token), null);
});

// --- HTTP flow -----------------------------------------------------------------------------------

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-bugshare-'));
  const prev = { d: process.env.GFA_BLOB_DIR, s: process.env.GFA_BLOB_SECRET };
  process.env.GFA_BLOB_DIR = dir;
  process.env.GFA_BLOB_SECRET = 'test-secret';
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
    rmSync(dir, { recursive: true, force: true });
    if (prev.d === undefined) delete process.env.GFA_BLOB_DIR; else process.env.GFA_BLOB_DIR = prev.d;
    if (prev.s === undefined) delete process.env.GFA_BLOB_SECRET; else process.env.GFA_BLOB_SECRET = prev.s;
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

test('bug share HTTP flow: mint, public view with no cookie, list, revoke, then gone', async () => {
  await withServer(async (base) => {
    const { cookie, token } = await signupAndToken(base);
    const bug = await ingestBug(base, token, { screenshotKey: 'shotkey123' });

    // Mint a share link (session auth). The response is the camelCase share shape the web client reads.
    const minted = await json(
      await fetch(base + '/api/bugs/' + bug.id + '/share', { method: 'POST', headers: { cookie } })
    );
    assert.equal(minted.status, 200);
    const share = minted.body.share;
    assert.match(share.token, /^[0-9a-f]{64}$/);
    assert.equal(typeof share.id, 'string');
    assert.equal(typeof share.createdAt, 'number');
    assert.equal(share.revokedAt, null);
    assert.ok('createdBy' in share);

    // Public view — NO cookie — returns the full bug under { bug }.
    const view = await json(await fetch(base + '/api/bug-share/' + share.token));
    assert.equal(view.status, 200);
    assert.equal(view.body.bug.id, bug.id);
    assert.equal(view.body.bug.title, 'Broken');

    // Owner-side list shows the minted link (camelCase rows).
    const shares = await json(await fetch(base + '/api/bugs/' + bug.id + '/shares', { headers: { cookie } }));
    assert.equal(shares.status, 200);
    assert.equal(shares.body.shares.length, 1);
    assert.equal(shares.body.shares[0].token, share.token);

    // Public signed artifact — NO cookie — for a bug that has the screenshot key.
    const art = await json(await fetch(base + '/api/bug-share/' + share.token + '/artifact/screenshot'));
    assert.equal(art.status, 200);
    assert.equal(typeof art.body.url, 'string');
    const u = new URL(art.body.url);
    assert.equal(u.pathname, '/api/blob/shotkey123');   // served by the board, not UploadThing
    assert.ok(u.searchParams.get('sig'));
    assert.ok(u.searchParams.get('exp'));

    // A kind whose key is absent on this bug → 404 NO_ARTIFACT (distinct from a signed URL).
    const noDom = await json(await fetch(base + '/api/bug-share/' + share.token + '/artifact/dom'));
    assert.equal(noDom.status, 404);
    assert.equal(noDom.body.error, 'NO_ARTIFACT');

    // Revoke, then the public view + artifact both read as gone.
    const del = await json(await fetch(base + '/api/bug-share/' + share.token, { method: 'DELETE', headers: { cookie } }));
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);

    const gone = await fetch(base + '/api/bug-share/' + share.token);
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).error, 'NOT_FOUND');

    const goneArt = await fetch(base + '/api/bug-share/' + share.token + '/artifact/screenshot');
    assert.equal(goneArt.status, 404); // token no longer resolves → NOT_FOUND

    // Re-revoking an already-dead token is a 404 NO_SUCH_SHARE.
    const reDel = await json(await fetch(base + '/api/bug-share/' + share.token, { method: 'DELETE', headers: { cookie } }));
    assert.equal(reDel.status, 404);
    assert.equal(reDel.body.error, 'NO_SUCH_SHARE');
  });
});

test('bug share HTTP: unknown token 404s, and sharing an unknown bug 404s', async () => {
  await withServer(async (base) => {
    const { cookie } = await signupAndToken(base);

    const unknownView = await fetch(base + '/api/bug-share/deadbeef');
    assert.equal(unknownView.status, 404);
    assert.equal((await unknownView.json()).error, 'NOT_FOUND');

    const unknownBug = await json(
      await fetch(base + '/api/bugs/does-not-exist/share', { method: 'POST', headers: { cookie } })
    );
    assert.equal(unknownBug.status, 404);
    assert.equal(unknownBug.body.error, 'NOT_FOUND');
  });
});
