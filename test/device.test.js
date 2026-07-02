import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { verifyToken } from '../src/auth/tokens.js';
import {
  createDeviceCode,
  getByUserCode,
  approveDeviceCode,
  denyDeviceCode,
  pollDeviceToken,
  normalizeUserCode,
  pruneDeviceCodes,
} from '../src/auth/device.js';

// The device-authorization core behind `be10x login`: create a code, the logged-in user approves it, the
// polling CLI collects a token exactly once. No HTTP here — just the state machine.

function seedUser(db, id = 'u1', email = 'a@b.dev') {
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    id, email, 'A', 'x', Date.now()
  );
  return id;
}

test('createDeviceCode issues a 64-hex device_code and a grouped user_code, row pending', () => {
  const db = openDb(':memory:');
  const { deviceCode, userCode, interval } = createDeviceCode(db, { label: 'my-laptop' });
  assert.match(deviceCode, /^[0-9a-f]{64}$/, 'device_code is the 64-hex back-channel secret');
  assert.match(userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'user_code is XXXX-XXXX, no ambiguous chars');
  assert.ok(interval >= 1, 'a poll interval is advised');
  const row = getByUserCode(db, userCode);
  assert.equal(row.status, 'pending');
  assert.equal(row.label, 'my-laptop');
});

test('normalizeUserCode tolerates case, spaces, and a missing dash', () => {
  assert.equal(normalizeUserCode('wdjb-mtqx'), 'WDJB-MTQX');
  assert.equal(normalizeUserCode('wdjbmtqx'), 'WDJB-MTQX');
  assert.equal(normalizeUserCode('  WDJB MTQX '), 'WDJB-MTQX');
});

test('getByUserCode finds a code regardless of how the human typed it', () => {
  const db = openDb(':memory:');
  const { userCode } = createDeviceCode(db, { label: 'x' });
  const bare = userCode.replace('-', '').toLowerCase();
  assert.ok(getByUserCode(db, bare), 'lowercase, dash-less lookup resolves');
});

test('approve mints a working token and the CLI collects it exactly once', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const { deviceCode, userCode } = createDeviceCode(db, { label: 'macbook' });

  assert.equal(pollDeviceToken(db, deviceCode).status, 'pending', 'pending until approved');

  const approved = approveDeviceCode(db, { userCode, userId: uid });
  assert.equal(approved.ok, true);
  assert.equal(approved.label, 'macbook');

  const first = pollDeviceToken(db, deviceCode);
  assert.equal(first.status, 'approved');
  assert.match(first.token, /^gfa_[0-9a-f]{48}$/, 'delivers the minted personal token');
  assert.equal(first.user.email, 'a@b.dev', 'greets the CLI with the account it linked');

  // The token actually authenticates as the approving user.
  const who = verifyToken(db, first.token);
  assert.equal(who.userId, uid);

  // Single-use back channel: a second poll no longer hands out the secret.
  assert.equal(pollDeviceToken(db, deviceCode).status, 'consumed');
});

test('approving twice is rejected (ALREADY_ANSWERED)', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const { userCode } = createDeviceCode(db, {});
  approveDeviceCode(db, { userCode, userId: uid });
  assert.throws(() => approveDeviceCode(db, { userCode, userId: uid }), /ALREADY_ANSWERED/);
});

test('an expired code cannot be approved and polls as expired', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const { deviceCode, userCode } = createDeviceCode(db, { label: 'x', ttlMs: -1 }); // already expired
  assert.equal(pollDeviceToken(db, deviceCode).status, 'expired');
  assert.throws(() => approveDeviceCode(db, { userCode, userId: uid }), /CODE_EXPIRED/);
});

test('deny makes the CLI poll return denied and blocks a later approve', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const { deviceCode, userCode } = createDeviceCode(db, {});
  denyDeviceCode(db, { userCode, userId: uid });
  assert.equal(pollDeviceToken(db, deviceCode).status, 'denied');
  assert.throws(() => approveDeviceCode(db, { userCode, userId: uid }), /ALREADY_ANSWERED/);
});

test('poll of an unknown device_code is not_found; approve of an unknown user_code is NOT_FOUND', () => {
  const db = openDb(':memory:');
  seedUser(db);
  assert.equal(pollDeviceToken(db, 'deadbeef').status, 'not_found');
  assert.throws(() => approveDeviceCode(db, { userCode: 'ZZZZ-ZZZZ', userId: 'u1' }), /NOT_FOUND/);
});

test('pruneDeviceCodes clears long-expired rows but keeps live ones', () => {
  const db = openDb(':memory:');
  const live = createDeviceCode(db, { label: 'keep' });
  createDeviceCode(db, { label: 'drop', ttlMs: -(2 * 24 * 60 * 60 * 1000) }); // expired 2 days ago
  pruneDeviceCodes(db);
  const rows = db.prepare('SELECT user_code FROM device_codes').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_code, live.userCode);
});
