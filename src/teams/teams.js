// ABOUTME: Teams with a unique slug. createTeam also inserts the creator as an 'owner' membership,
// ABOUTME: so a team always has at least one owner from the moment it exists.
import { randomUUID } from 'node:crypto';

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const TEAM_COLS = 'id, name, slug, bias_md AS biasMd, created_by AS createdBy, created_at AS createdAt';

export function createTeam(db, { name, createdBy, biasMd = '' }) {
  const slug = slugify(name);
  if (!slug) throw new Error('INVALID_NAME');
  if (db.prepare('SELECT id FROM teams WHERE slug = ?').get(slug)) throw new Error('SLUG_TAKEN');
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO teams (id, name, slug, bias_md, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    slug,
    biasMd,
    createdBy,
    now
  );
  db.prepare('INSERT INTO memberships (id, team_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    id,
    createdBy,
    'owner',
    now
  );
  return { id, name, slug, biasMd, createdBy };
}

export function getTeam(db, id) {
  return db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE id = ?`).get(id) ?? null;
}

// Memberships and team-scoped tasks cascade via their ON DELETE CASCADE foreign keys.
export function deleteTeam(db, id) {
  const info = db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  return { ok: true, changes: info.changes };
}

export function getTeamBySlug(db, slug) {
  return db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE slug = ?`).get(slug) ?? null;
}
