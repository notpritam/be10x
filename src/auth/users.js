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
