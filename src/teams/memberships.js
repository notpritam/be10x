// ABOUTME: Team memberships and roles (owner/admin/member/viewer).
// ABOUTME: add / read / list / change-role / remove; roles are validated against ROLES.
import { randomUUID } from 'node:crypto';

export const ROLES = ['owner', 'admin', 'member', 'viewer'];

export function addMember(db, { teamId, userId, role = 'member' }) {
  if (!ROLES.includes(role)) throw new Error('INVALID_ROLE');
  if (db.prepare('SELECT id FROM memberships WHERE team_id = ? AND user_id = ?').get(teamId, userId)) {
    throw new Error('ALREADY_MEMBER');
  }
  const id = randomUUID();
  db.prepare('INSERT INTO memberships (id, team_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    teamId,
    userId,
    role,
    Date.now()
  );
  return { id, teamId, userId, role };
}

export function getMembership(db, teamId, userId) {
  return (
    db
      .prepare('SELECT id, team_id AS teamId, user_id AS userId, role FROM memberships WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId) ?? null
  );
}

export function listMembers(db, teamId) {
  return db
    .prepare('SELECT user_id AS userId, role FROM memberships WHERE team_id = ? ORDER BY created_at')
    .all(teamId);
}

export function setRole(db, teamId, userId, role) {
  if (!ROLES.includes(role)) throw new Error('INVALID_ROLE');
  const res = db.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?').run(role, teamId, userId);
  if (res.changes === 0) throw new Error('NOT_A_MEMBER');
}

export function removeMember(db, teamId, userId) {
  db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?').run(teamId, userId);
}
