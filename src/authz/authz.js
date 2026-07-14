// ABOUTME: Role-based authorization over team memberships, plus task/project-level access built on top.
// ABOUTME: can() compares the actor's team-role rank against the action's required minimum rank.
import { getMembership } from '../teams/memberships.js';
import { getProject } from '../projects/projects.js';
import { getTask } from '../tasks/tasks.js';

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

// A project is reachable if the caller registered it personally, belongs to the team it's shared with, or
// it predates per-account project scoping (owner_id AND team_id both NULL — see db.js
// migrateProjectsTable) — those legacy rows stay visible to everyone rather than vanishing for accounts
// that already relied on them. `action` is 'task.read' (view) or 'task.update' (mutate); the REQUIRED
// rank table above already encodes viewer-can-read / member-can-write.
export function canAccessProject(db, userId, project, action = 'task.read') {
  if (!project) return false;
  if (project.ownerId === userId) return true;
  if (project.teamId) return can(db, userId, action, { teamId: project.teamId });
  return !project.ownerId && !project.teamId;
}

// The single gate every task route (HTTP and MCP) should call before reading or mutating a task: the
// owner always has full access; a tagged reviewer can always at least READ the task (reviewers are picked
// by search across the whole platform, not just teammates — see RequestReviewControl.tsx / gfa_submit_plan
// — so requiring team membership too would break reviewing outside your own team); otherwise a team task
// needs the caller to hold at least `action`'s rank on that team; otherwise a project-scoped task defers to
// canAccessProject for the project it's filed under. Note the reviewer carve-out is read-only — actually
// submitting a review is gated separately, directly on reviewerId, wherever that route is handled.
export function canAccessTask(db, userId, task, action = 'task.read') {
  if (!task) return false;
  if (task.ownerId === userId) return true;
  if (action === 'task.read' && task.reviewerId === userId) return true;
  if (task.teamId && can(db, userId, action, { teamId: task.teamId })) return true;
  if (task.projectId) return canAccessProject(db, userId, getProject(db, task.projectId), action);
  return false;
}

export function assertCanAccessTask(db, userId, task, action = 'task.read') {
  if (!canAccessTask(db, userId, task, action)) throw new Error('FORBIDDEN');
}

// Per-account visibility of a filed QA bug — the bug analogue of canAccessTask. The LOCAL stdio bug MCP
// (src/mcp/bug-server.js) and the human dashboard bug routes treat bugs as board-wide (a valid session/token
// reads any bug — bugs are a shared triage surface on a single-tenant board). This gate is for the paths
// that cross accounts — attaching a bug to a task, and the REMOTE agent's bug-rpc — where a token must NOT
// reach an unrelated account's bug: reachable if you reported it, are assigned it, it's linked to a task you
// can access, or it's scoped to a team/project you can access. `bug` is the hydrated shape from bugs.js.
export function canAccessBug(db, userId, bug) {
  if (!bug) return false;
  if (bug.reporterId === userId) return true;
  if (bug.assigneeId === userId) return true;
  if (bug.taskId) {
    const task = getTask(db, bug.taskId);
    if (task && canAccessTask(db, userId, task)) return true;
  }
  if (bug.teamId && can(db, userId, 'task.read', { teamId: bug.teamId })) return true;
  if (bug.projectId) return canAccessProject(db, userId, getProject(db, bug.projectId));
  return false;
}

export function assertCanAccessBug(db, userId, bug) {
  if (!canAccessBug(db, userId, bug)) throw new Error('FORBIDDEN');
}
