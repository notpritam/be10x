// ABOUTME: Shareable, permissioned plan-review links — hand a task's plan + discussion to an outside
// ABOUTME: reviewer via an unguessable token. permission gates comment/review-only vs also running the agent.
import { randomUUID, randomBytes } from 'node:crypto';
import { getTask } from '../tasks/tasks.js';
import { listComments } from '../tasks/comments.js';

export const SHARE_PERMISSIONS = ['comment_only', 'run_agent'];

// Mint a share link for a task. The token is 32 random bytes as hex (256 bits, unguessable) — the bearer
// of the token IS the credential, so anyone with the link gets exactly what `permission` grants.
export function createShareLink(db, { taskId, permission = 'comment_only', createdBy = null } = {}) {
  const perm = permission || 'comment_only';
  if (!SHARE_PERMISSIONS.includes(perm)) throw new Error('INVALID_PERMISSION');
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO share_links (id, task_id, token, permission, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, token, perm, createdBy, Date.now());
  return getShareLinkById(db, id);
}

export function getShareLinkById(db, id) {
  return db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) || null;
}

// Resolve a live link by its token. Revoked links read as gone (revoked_at IS NULL), so a
// leaked-then-revoked token stops working. Returns the raw row (task_id, permission, ...) or null.
export function getActiveShareLinkByToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM share_links WHERE token = ? AND revoked_at IS NULL').get(token) || null;
}

// Every link ever minted for a task, newest first — the owner's manage list (revoked ones included, so
// the UI can show that a link was killed).
export function listShareLinksForTask(db, taskId) {
  return db.prepare('SELECT * FROM share_links WHERE task_id = ? ORDER BY created_at DESC, rowid DESC').all(taskId);
}

// Revoke a link by token. Idempotent: re-revoking a dead link keeps the original revoked_at and returns 0.
// Returns the number of links revoked (0 = unknown or already revoked).
export function revokeShareLink(db, token) {
  return db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').run(Date.now(), token).changes;
}

// The shareable subset behind a valid token: the task header, its plan, and the discussion — nothing else
// about the board leaks out. Returns null for an unknown/revoked token or a vanished task.
export function shareView(db, token) {
  const link = getActiveShareLinkByToken(db, token);
  if (!link) return null;
  const task = getTask(db, link.task_id);
  if (!task) return null;
  return {
    task: { id: task.id, humanId: task.humanId, title: task.title, status: task.status, type: task.type },
    plan: task.plan,
    comments: listComments(db, link.task_id),
  };
}
