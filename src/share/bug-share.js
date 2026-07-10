// ABOUTME: Public, view-only share links for a captured QA bug — hand the full raw bug (screenshot / DOM /
// ABOUTME: network / rrweb session) to anyone via an unguessable token. Mirrors share.js; no permission tiers.
import { randomUUID, randomBytes } from 'node:crypto';
import { getBug } from '../bugs/bugs.js';

// Mint a share link for a bug. The token is 32 random bytes as hex (256 bits, unguessable) — the bearer of
// the token IS the credential, so anyone with the link sees the full bug. View-only: there is no permission.
export function createBugShareLink(db, { bugId, createdBy = null } = {}) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO bug_shares (id, bug_id, token, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, bugId, token, createdBy, Date.now());
  return getBugShareLinkById(db, id);
}

export function getBugShareLinkById(db, id) {
  return db.prepare('SELECT * FROM bug_shares WHERE id = ?').get(id) || null;
}

// Resolve a live link by its token. Revoked links read as gone (revoked_at IS NULL), so a
// leaked-then-revoked token stops working. Returns the raw row (bug_id, ...) or null.
export function getActiveBugShareByToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM bug_shares WHERE token = ? AND revoked_at IS NULL').get(token) || null;
}

// Every link ever minted for a bug, newest first — the owner's manage list (revoked ones included, so
// the UI can show that a link was killed).
export function listBugShareLinksForBug(db, bugId) {
  return db.prepare('SELECT * FROM bug_shares WHERE bug_id = ? ORDER BY created_at DESC, rowid DESC').all(bugId);
}

// Revoke a link by token. Idempotent: re-revoking a dead link keeps the original revoked_at and returns 0.
// Returns the number of links revoked (0 = unknown or already revoked).
export function revokeBugShareLink(db, token) {
  return db.prepare('UPDATE bug_shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').run(Date.now(), token).changes;
}

// The bug behind a valid token: the FULL raw bug object exactly as GET /api/bugs/:id serves it (no
// redaction — the product owner's explicit choice), so a link holder sees the whole capture. Returns null
// for an unknown/revoked token or a vanished bug.
export function bugShareView(db, token) {
  const link = getActiveBugShareByToken(db, token);
  if (!link) return null;
  return getBug(db, link.bug_id) || null;
}
