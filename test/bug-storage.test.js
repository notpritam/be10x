// ABOUTME: Unit tests for the local-disk bug-artifact storage seam (replaces UploadThing): signed
// ABOUTME: upload/read URLs, single-part multipart extraction, and the filesystem-backed driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signBlobUrl, verifyBlobSig, extractFilePart, makeLocalStorage, getStorage,
} from '../src/bugs/storage.js';

const SECRET = 'test-secret';

test('signBlobUrl + verifyBlobSig round-trip, method-bound, and expiring', () => {
  const exp = 10_000;
  const sig = signBlobUrl(SECRET, 'GET', 'KEY1', exp);
  // valid before expiry
  assert.equal(verifyBlobSig(SECRET, 'GET', 'KEY1', exp, sig, { now: 5_000 }), true);
  // expired
  assert.equal(verifyBlobSig(SECRET, 'GET', 'KEY1', exp, sig, { now: 20_000 }), false);
  // a GET signature cannot authorize a PUT (method-bound)
  assert.equal(verifyBlobSig(SECRET, 'PUT', 'KEY1', exp, sig, { now: 5_000 }), false);
  // wrong key rejected
  assert.equal(verifyBlobSig(SECRET, 'GET', 'OTHER', exp, sig, { now: 5_000 }), false);
  // wrong secret rejected
  assert.equal(verifyBlobSig('nope', 'GET', 'KEY1', exp, sig, { now: 5_000 }), false);
  // tampered signature rejected (no throw on bad length)
  assert.equal(verifyBlobSig(SECRET, 'GET', 'KEY1', exp, 'deadbeef', { now: 5_000 }), false);
});

test('extractFilePart pulls bytes + content-type from a single-file multipart body', () => {
  const boundary = '----be10xBoundary123';
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]); // PNG-ish binary
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="shot.png"\r\n'),
    Buffer.from('Content-Type: image/png\r\n\r\n'),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const part = extractFilePart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(part.bytes, fileBytes);
  assert.equal(part.contentType, 'image/png');
  assert.equal(part.filename, 'shot.png');
});

test('extractFilePart throws on a non-multipart content-type', () => {
  assert.throws(() => extractFilePart(Buffer.from('x'), 'application/json'), /BAD_MULTIPART/);
});

test('local storage: presignUpload → PUT-verify → write → read → signReadUrl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-blob-'));
  try {
    const s = makeLocalStorage({ dir, secret: SECRET, baseUrl: 'https://board.test', now: () => 1000 });

    const [u] = s.presignUpload([{ name: 'shot.png', size: 7, type: 'image/png' }], {
      makeKey: () => 'KEY1',
    });
    assert.equal(u.key, 'KEY1');
    const up = new URL(u.uploadUrl);
    assert.equal(up.origin + up.pathname, 'https://board.test/api/blob/KEY1');
    // the upload URL's signature authorizes a PUT for exactly this key
    assert.equal(
      s.verify('PUT', 'KEY1', Number(up.searchParams.get('exp')), up.searchParams.get('sig')),
      true,
    );

    const bytes = Buffer.from('abc1234');
    s.write('KEY1', bytes, 'image/png');
    assert.deepEqual(s.read('KEY1'), bytes);
    assert.equal(s.contentType('KEY1'), 'image/png');
    assert.ok(existsSync(join(dir, 'KEY1')));

    const readUrl = new URL(s.signReadUrl('KEY1'));
    assert.equal(readUrl.origin + readUrl.pathname, 'https://board.test/api/blob/KEY1');
    assert.equal(
      s.verify('GET', 'KEY1', Number(readUrl.searchParams.get('exp')), readUrl.searchParams.get('sig')),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local storage rejects path-traversal keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-blob-'));
  try {
    const s = makeLocalStorage({ dir, secret: SECRET, baseUrl: 'https://board.test' });
    assert.throws(() => s.write('../evil', Buffer.from('x'), 'text/plain'), /BAD_KEY/);
    assert.throws(() => s.read('../../etc/passwd'), /BAD_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getStorage selects local by default and stubs s3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-blob-'));
  try {
    const local = getStorage({ BUG_STORAGE: 'local', GFA_BLOB_DIR: dir });
    assert.equal(typeof local.presignUpload, 'function');
    // default (unset) is local
    const dflt = getStorage({ GFA_BLOB_DIR: dir });
    assert.equal(typeof dflt.presignUpload, 'function');
    // s3 is a declared-but-unimplemented seam
    assert.throws(() => getStorage({ BUG_STORAGE: 's3', GFA_BLOB_DIR: dir }).read('k'), /NOT_IMPLEMENTED/);
    assert.throws(() => getStorage({ BUG_STORAGE: 'bogus', GFA_BLOB_DIR: dir }), /UNKNOWN_BUG_STORAGE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
