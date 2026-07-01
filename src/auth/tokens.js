// ABOUTME: Personal access tokens for agents/MCP. The plaintext secret is returned once;
// ABOUTME: only its SHA-256 hash is stored. verifyToken maps a secret back to its user.
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createToken(db, userId, name) {
  const id = randomUUID();
  const token = 'gfa_' + randomBytes(24).toString('hex'); // 48 hex chars
  db.prepare('INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    sha256(token),
    Date.now()
  );
  return { id, name, token };
}

export function verifyToken(db, secret) {
  const row = db.prepare('SELECT id, user_id AS userId FROM tokens WHERE token_hash = ?').get(sha256(secret));
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { userId: row.userId, tokenId: row.id };
}

export function revokeToken(db, id) {
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
}

// Lists a user's tokens for display — never selects the hash/secret.
export function listTokens(db, userId) {
  return db
    .prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM tokens WHERE user_id = ? ORDER BY created_at')
    .all(userId);
}

// Returns the token's owning user_id (or null if no such token) for authorization on delete.
export function getTokenOwner(db, id) {
  const row = db.prepare('SELECT user_id AS userId FROM tokens WHERE id = ?').get(id);
  return row ? row.userId : null;
}
