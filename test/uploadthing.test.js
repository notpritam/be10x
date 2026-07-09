// ABOUTME: Unit tests for the UploadThing signer — token parsing and signed ingest-URL construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseUploadThingToken, mintUploadUrls, generateFileKey } from '../src/bugs/uploadthing.js';

const TOKEN = Buffer.from(
  JSON.stringify({ apiKey: 'sk_test_abc', appId: 'app123', regions: ['sea1'] })
).toString('base64');

test('parseUploadThingToken decodes the base64 JSON', () => {
  const t = parseUploadThingToken(TOKEN);
  assert.equal(t.apiKey, 'sk_test_abc');
  assert.equal(t.appId, 'app123');
  assert.deepEqual(t.regions, ['sea1']);
  assert.throws(() => parseUploadThingToken(''), /MISSING_FIELD:UPLOADTHING_TOKEN/);
  assert.throws(() => parseUploadThingToken('not-base64-json'), /MISSING_FIELD:UPLOADTHING_TOKEN/);
});

test('mintUploadUrls builds a signed ingest URL per file', () => {
  const out = mintUploadUrls(
    [{ name: 'shot.png', size: 1234, type: 'image/png' }],
    { token: TOKEN, now: 1000, makeKey: () => 'KEY1', expiresInMs: 60000 }
  );
  assert.equal(out.length, 1);
  const u = out[0];
  assert.equal(u.key, 'KEY1');
  assert.equal(u.name, 'shot.png');
  assert.equal(u.fileUrl, 'https://app123.ufs.sh/f/KEY1');

  const url = new URL(u.uploadUrl);
  assert.equal(url.origin, 'https://sea1.ingest.uploadthing.com');
  assert.equal(url.pathname, '/KEY1');
  assert.equal(url.searchParams.get('x-ut-identifier'), 'app123');
  assert.equal(url.searchParams.get('x-ut-file-name'), 'shot.png');
  assert.equal(url.searchParams.get('x-ut-file-size'), '1234');
  assert.equal(url.searchParams.get('x-ut-file-type'), 'image/png');
  assert.equal(url.searchParams.get('expires'), String(1000 + 60000));

  // Signature is HMAC-SHA256 of the URL *without* the signature param, keyed by apiKey.
  const sig = url.searchParams.get('signature');
  url.searchParams.delete('signature');
  const expected = 'hmac-sha256=' + createHmac('sha256', 'sk_test_abc').update(url.toString()).digest('hex');
  assert.equal(sig, expected);
});

test('generateFileKey is deterministic, appId-scoped, and url-safe', () => {
  // The sqids-encoded appId prefix is what UploadThing validates (live-confirmed: a random key → 400
  // "Invalid fileKey"; this scheme → 200). Lock the shape so it can't silently regress.
  const k1 = generateFileKey('x4bfkkenpi', 'seed-1');
  const k2 = generateFileKey('x4bfkkenpi', 'seed-1');
  const k3 = generateFileKey('x4bfkkenpi', 'seed-2');
  assert.equal(k1, k2); // deterministic for the same inputs
  assert.notEqual(k1, k3); // a different seed yields a different key
  assert.ok(k1.length >= 12); // sqids appId prefix has minLength 12
  assert.match(k1, /^[A-Za-z0-9_-]+$/); // url-safe (sqids alphabet + base64url seed)
});

test('mintUploadUrls maps multiple files and defaults an unknown type', () => {
  const out = mintUploadUrls(
    [
      { name: 'dom.json', size: 10, type: 'application/json' },
      { name: 'net.bin', size: 20 },
    ],
    { token: TOKEN, makeKey: (f) => 'k-' + f.name }
  );
  assert.deepEqual(out.map((o) => o.key), ['k-dom.json', 'k-net.bin']);
  assert.equal(new URL(out[1].uploadUrl).searchParams.get('x-ut-file-type'), 'application/octet-stream');
});
