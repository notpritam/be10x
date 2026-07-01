// ABOUTME: Role-based authorization over team memberships.
// ABOUTME: can() compares the actor's team-role rank against the action's required minimum rank.
import { getMembership } from '../teams/memberships.js';

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const ACTIONS = {
  TEAM_READ: 'team.read',
  TEAM_DELETE: 'team.delete',
  TASK_READ: 'task.read',
  TASK_CREATE: 'task.create',
  TASK_UPDATE: 'task.update',
  MEMBERS_MANAGE: 'members.manage',
};

const REQUIRED = {
  'team.read': 'viewer',
  'task.read': 'viewer',
  'task.create': 'member',
  'task.update': 'member',
  'members.manage': 'admin',
  'team.delete': 'owner',
};

export function can(db, userId, action, { teamId } = {}) {
  const need = REQUIRED[action];
  if (need === undefined || !teamId) return false;
  const m = getMembership(db, teamId, userId);
  if (!m) return false;
  return RANK[m.role] >= RANK[need];
}

export function assertCan(db, userId, action, ctx) {
  if (!can(db, userId, action, ctx)) throw new Error('FORBIDDEN');
}
