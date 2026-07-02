// ABOUTME: Browser device-authorization for `be10x login` — the CLI creates a code, the user approves it in
// ABOUTME: the board UI (where they're logged in), and the CLI polls until a personal token is minted. No paste.
//
// The flow mirrors OAuth device authorization (RFC 8628): the CLI holds an unguessable `device_code` and
// shows the user a short `user_code`; the user opens the board, sees the SAME short code, and clicks Approve.
// Because approval happens inside a logged-in board session, the minted token is tied to that account. The
// token never touches the clipboard or the browser URL — the CLI collects it over the back channel.
import { randomUUID, randomBytes } from 'node:crypto';
import { createToken } from './tokens.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes to approve before the code expires
const POLL_INTERVAL_S = 3;

// User code: 8 chars from an unambiguous alphabet (no 0/O/1/I/L/U), grouped 4-4 → e.g. "WDJB-MTQX". Short
// enough to read off a screen; the real secret is the 64-hex device_code, so the user_code only needs to be
// non-guessable over the ~10-minute window, not cryptographically strong.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function newUserCode() {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

// Normalize what a human might type/paste back: uppercase, drop non-alphanumerics, re-insert the dash. So
// "wdjb mtqx", "wdjbmtqx", and "WDJB-MTQX" all resolve to the same stored code.
export function normalizeUserCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : s;
}

// Create a pending device-authorization request. `label` (the requesting machine's hostname) is shown on the
// approve screen so the user knows what they're authorizing. Returns the CLI-facing values.
export function createDeviceCode(db, { label = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  const id = randomUUID();
  const deviceCode = randomBytes(32).toString('hex'); // 64 hex — the back-channel secret the CLI holds
  // Retry on the (astronomically unlikely) user_code collision so we never hand out a duplicate.
  let code = newUserCode();
  for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM device_codes WHERE user_code = ?').get(code); i++) code = newUserCode();
  db.prepare(
    'INSERT INTO device_codes (id, device_code, user_code, label, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, deviceCode, code, label, 'pending', now, now + ttlMs);
  return { deviceCode, userCode: code, expiresAt: now + ttlMs, interval: POLL_INTERVAL_S };
}

// Look up a request by its human code (for the approve screen + the approve action). Null if unknown.
export function getByUserCode(db, code) {
  return db.prepare('SELECT * FROM device_codes WHERE user_code = ?').get(normalizeUserCode(code)) || null;
}

// The user (logged into the board) authorizes a machine: mint them a personal token named for the machine
// and attach it to the request so the polling CLI can collect it once. Returns { ok, label } or throws a
// domain error the HTTP layer maps to a status (NOT_FOUND, ALREADY_ANSWERED, CODE_EXPIRED).
export function approveDeviceCode(db, { userCode: code, userId }) {
  const row = getByUserCode(db, code);
  if (!row) throw new Error('NOT_FOUND');
  if (row.status !== 'pending') throw new Error('ALREADY_ANSWERED');
  if (row.expires_at < Date.now()) throw new Error('CODE_EXPIRED');
  const { token } = createToken(db, userId, 'device:' + (row.label || 'machine'));
  db.prepare('UPDATE device_codes SET status = ?, user_id = ?, token = ?, approved_at = ? WHERE id = ?').run(
    'approved', userId, token, Date.now(), row.id
  );
  return { ok: true, label: row.label || null };
}

// The user declines a machine's request (the "this wasn't me" path). Idempotent on an already-answered row.
export function denyDeviceCode(db, { userCode: code, userId }) {
  const row = getByUserCode(db, code);
  if (!row) throw new Error('NOT_FOUND');
  if (row.status === 'pending') {
    db.prepare('UPDATE device_codes SET status = ?, user_id = ?, approved_at = ? WHERE id = ?').run(
      'denied', userId, Date.now(), row.id
    );
  }
  return { ok: true };
}

// The CLI polls with its device_code. Returns a status the CLI branches on. On 'approved' the token is
// delivered EXACTLY ONCE and then cleared from the row (single-use back channel), so even a leaked db row
// can't re-hand the secret. 'expired' once the window passes; 'denied' if declined; 'pending' otherwise.
export function pollDeviceToken(db, deviceCode) {
  const row = db.prepare('SELECT * FROM device_codes WHERE device_code = ?').get(String(deviceCode || ''));
  if (!row) return { status: 'not_found' };
  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'approved') {
    if (!row.token) return { status: 'consumed' }; // already collected — the CLI shouldn't poll after success
    db.prepare('UPDATE device_codes SET token = NULL WHERE id = ?').run(row.id);
    const owner = db.prepare('SELECT email, display_name AS displayName FROM users WHERE id = ?').get(row.user_id) || {};
    return { status: 'approved', token: row.token, user: { email: owner.email || null, displayName: owner.displayName || null } };
  }
  if (row.expires_at < Date.now()) return { status: 'expired' };
  return { status: 'pending', interval: POLL_INTERVAL_S };
}

// Housekeeping: drop requests whose window closed over a day ago so the table can't grow unbounded. Never
// touches a still-pending, unexpired request. Safe to call opportunistically.
export function pruneDeviceCodes(db, { olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
  db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(Date.now() - olderThanMs);
}
