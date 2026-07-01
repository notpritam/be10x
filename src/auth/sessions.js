// ABOUTME: Cookie-session lifecycle over the sessions table (create / get / delete).
// ABOUTME: getSession returns null for an expired session and purges it as a side effect.
import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function createSession(db, userId, ttlMs = DEFAULT_TTL_MS) {
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    expiresAt,
    now
  );
  return { id, userId, expiresAt };
}

export function getSession(db, id) {
  const row = db
    .prepare('SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE id = ?')
    .get(id);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    deleteSession(db, id);
    return null;
  }
  return row;
}

export function deleteSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
