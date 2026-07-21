// ABOUTME: HTTP test for the bug artifact route — a signed local-blob read URL when the key is present,
// ABOUTME: 404 when it isn't — plus the full extension round-trip: presign → multipart PUT → signed GET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-artifact-'));
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

async function json(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }

async function signupAndToken(base) {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'qa@b.co', displayName: 'QA', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const tokRes = await fetch(base + '/api/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'extension' }),
  });
  const token = (await tokRes.json()).token.token;
  return { cookie, token };
}

async function ingestBug(base, token, extra) {
  const res = await fetch(base + '/api/agent/bugs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ pageUrl: 'https://app.example.com/x', title: 'Broken', severity: 'high', ...extra }),
  });
  return (await res.json()).bug;
}

test('bug artifact route: signed local-blob URL when the key exists, 404 when it does not', async () => {
  await withServer(async (base) => {
    const { cookie, token } = await signupAndToken(base);

    const withShot = await ingestBug(base, token, { screenshotKey: 'shotkey123' });
    const got = await json(
      await fetch(base + '/api/bugs/' + withShot.id + '/artifact/screenshot', { headers: { cookie } })
    );
    assert.equal(got.status, 200);
    const u = new URL(got.body.url);
    assert.equal(u.pathname, '/api/blob/shotkey123');       // served by the board itself, not UploadThing
    assert.ok(u.searchParams.get('exp'));
    assert.ok(u.searchParams.get('sig'));

    const noDom = await fetch(base + '/api/bugs/' + withShot.id + '/artifact/dom', { headers: { cookie } });
    assert.equal(noDom.status, 404);
    const noShot = await ingestBug(base, token, { domKey: 'domkey' });
    const missing = await fetch(base + '/api/bugs/' + noShot.id + '/artifact/screenshot', { headers: { cookie } });
    assert.equal(missing.status, 404);
    const unknown = await fetch(base + '/api/bugs/does-not-exist/artifact/screenshot', { headers: { cookie } });
    assert.equal(unknown.status, 404);
    const noAuth = await fetch(base + '/api/bugs/' + withShot.id + '/artifact/screenshot');
    assert.equal(noAuth.status, 401);
  });
});

test('extension round-trip: presign → multipart PUT stores bytes → signed GET returns them', async () => {
  await withServer(async (base) => {
    const { cookie, token } = await signupAndToken(base);

    // 1. presign an upload URL (as the extension does)
    const mint = await json(await fetch(base + '/api/agent/bugs/upload-urls', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ files: [{ name: 'shot.png', size: 5, type: 'image/png' }] }),
    }));
    assert.equal(mint.status, 200);
    const up = mint.body.uploads[0];
    assert.equal(new URL(up.uploadUrl).pathname, '/api/blob/' + up.key);

    // 2. PUT the bytes exactly as the capture extension does (multipart/form-data, field "file")
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('PNGxy')], { type: 'image/png' }), 'shot.png');
    const put = await fetch(up.uploadUrl, { method: 'PUT', body: fd });
    assert.equal(put.status, 200);

    // 3. file a bug carrying that key, then read it back through the artifact route's signed URL
    const bug = await ingestBug(base, token, { screenshotKey: up.key });
    const art = await json(await fetch(base + '/api/bugs/' + bug.id + '/artifact/screenshot', { headers: { cookie } }));
    const blob = await fetch(art.body.url);
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'PNGxy');

    // a tampered read signature is rejected
    const bad = await fetch(art.body.url.replace(/sig=[0-9a-f]+/, 'sig=deadbeef'));
    assert.equal(bad.status, 403);

    // an unsigned PUT to the blob endpoint is rejected (no valid upload grant)
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('x')]), 'x');
    const noSig = await fetch(base + '/api/blob/' + up.key, { method: 'PUT', body: fd2 });
    assert.equal(noSig.status, 403);
  });
});
