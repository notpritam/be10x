// ABOUTME: User creation and lookup. Emails are normalized (trim + lowercase) and unique.
// ABOUTME: getUserByEmail returns the password hash (for login); getUserById never does.
import { randomUUID } from 'node:crypto';
import { hashPassword } from './passwords.js';

const norm = (email) => String(email).trim().toLowerCase();

export function createUser(db, { email, displayName, password }) {
  const e = norm(email);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(e)) {
    throw new Error('EMAIL_TAKEN');
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, e, displayName, hashPassword(password), Date.now());
  return { id, email: e, displayName };
}

export function getUserByEmail(db, email) {
  return (
    db
      .prepare(
        'SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE email = ?'
      )
      .get(norm(email)) ?? null
  );
}

export function getUserById(db, id) {
  return (
    db
      .prepare('SELECT id, email, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?')
      .get(id) ?? null
  );
}

// Search users by email or display name (case-insensitive substring) for the "add a teammate" typeahead.
// Excludes `excludeIds` (typically yourself + everyone already on the team). Returns lightweight public
// cards only (never the password hash). `%`/`_` in the query are escaped so they're literal, not wildcards.
export function searchUsers(db, q, { excludeIds = [], limit = 8 } = {}) {
  const term = String(q ?? '').trim().toLowerCase();
  if (!term) return [];
  const like = '%' + term.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const rows = db
    .prepare(
      `SELECT id, email, display_name AS displayName FROM users
       WHERE LOWER(email) LIKE ? ESCAPE '\\' OR LOWER(display_name) LIKE ? ESCAPE '\\'
       ORDER BY display_name COLLATE NOCASE
       LIMIT ?`
    )
    .all(like, like, limit + excludeIds.length);
  const exclude = new Set(excludeIds);
  return rows.filter((r) => !exclude.has(r.id)).slice(0, limit);
}

// People you've recently worked with: distinct users who share at least one team with you, most-recently
// added first (by their membership timestamp), excluding you and any `excludeIds`. Powers the "recent
// people" quick-add chips so adding a frequent collaborator is one click, no typing.
export function recentCollaborators(db, userId, { excludeIds = [], limit = 8 } = {}) {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.display_name AS displayName, MAX(peer.created_at) AS lastAt
       FROM memberships mine
       JOIN memberships peer ON peer.team_id = mine.team_id AND peer.user_id <> mine.user_id
       JOIN users u ON u.id = peer.user_id
       WHERE mine.user_id = ?
       GROUP BY u.id
       ORDER BY lastAt DESC`
    )
    .all(userId);
  const exclude = new Set([userId, ...excludeIds]);
  return rows
    .filter((r) => !exclude.has(r.id))
    .slice(0, limit)
    .map(({ lastAt, ...u }) => u);
}
