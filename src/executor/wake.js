// ABOUTME: The wake queue — turns board events into agent runs. Enqueue on a human action; the scheduler
// ABOUTME: claims the oldest pending wake (optimistic lock) and drives the agent. Ephemeral, not always-live.
import { randomUUID } from 'node:crypto';
import { canAccessProject } from '../authz/authz.js';

// Known wake reasons → the executor mode each maps to lives in the scheduler; these are the vocabulary.
export const WAKE_REASONS = ['plan', 'revise', 'input_answer', 'execute', 'pick_up_now', 'follow_up', 'verify', 'resume'];

function hydrate(row) {
  return row
    ? {
        id: row.id,
        taskId: row.task_id,
        reason: row.reason,
        context: row.context_json == null ? null : JSON.parse(row.context_json),
        enqueuedAt: row.enqueued_at,
        claimedAt: row.claimed_at,
        claimedBy: row.claimed_by,
      }
    : null;
}

export function getWake(db, id) {
  return hydrate(db.prepare('SELECT * FROM wake_queue WHERE id = ?').get(id));
}

// Enqueue a wake for a task. `context` is the delta that triggered it (the comment, the answer, the
// verdict) — stored so the scheduler can build a cheap, delta-only wake prompt. `delayMs` schedules the
// wake for the future (enqueued_at = now + delayMs); the claim won't pick it up until then. This is what
// backs retry backoff — a failed run re-enqueues itself a few seconds out instead of hot-looping.
export function enqueueWake(db, taskId, reason, context = null, { delayMs = 0 } = {}) {
  const id = randomUUID();
  const readyAt = Date.now() + Math.max(0, delayMs);
  db.prepare(
    'INSERT INTO wake_queue (id, task_id, reason, context_json, enqueued_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, taskId, reason, context == null ? null : JSON.stringify(context), readyAt);
  return getWake(db, id);
}

// Pending (unclaimed) wakes for a task, oldest first.
export function listPendingWakes(db, taskId) {
  return db
    .prepare('SELECT * FROM wake_queue WHERE task_id = ? AND claimed_at IS NULL ORDER BY enqueued_at, rowid')
    .all(taskId)
    .map(hydrate);
}

// Atomically claim the oldest pending wake for this runner: a wake whose task is in `projectId`, OR a
// project-less (personal) task — so a task created on the board with no project is still worked by
// whatever runner is up. The conditional UPDATE (WHERE claimed_at IS NULL) makes the claim safe against
// concurrent schedulers — a loser gets the next row or null. Returns the claimed wake, or null if empty.
export function claimNextWake(db, { projectId, workerId = 'runner', claimantUserId = null } = {}) {
  const rows = db
    .prepare(
      `SELECT w.id FROM wake_queue w JOIN tasks t ON t.id = w.task_id
       WHERE w.claimed_at IS NULL AND w.enqueued_at <= ? AND (t.project_id = ? OR t.project_id IS NULL)
       AND (t.assignee_id IS NULL OR t.assignee_id = ?)
       ORDER BY w.enqueued_at, w.rowid`
    )
    .all(Date.now(), projectId, claimantUserId);
  for (const { id } of rows) {
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, id);
    if (res.changes === 1) return getWake(db, id);
  }
  return null;
}

// Remote claim: the oldest pending wake for a task whose project's KEY is one this runner serves. This is
// what a `be10x connect` runner on a MEMBER's machine calls over HTTP — it declares the repos (project
// keys) it has checked out locally, and only gets wakes for those. Same optimistic-lock claim as the
// others. Personal/project-less tasks are intentionally excluded (a remote runner has no repo for them).
//
// A bare key match isn't enough: project identity is scoped (see projects.js), but two different accounts
// can still legitimately declare the SAME key (e.g. a fallback `local:<folder-name>` key when neither repo
// has a git remote) for two UNRELATED, separately-owned projects. Passing userId filters the SQL match down
// to projects that userId's token can actually access — otherwise one account's connector could be handed
// (and permanently fail to run) another account's wake. Returns the claimed wake, or null (empty keys → null).
export function claimNextWakeForKeys(db, { projectKeys = [], workerId = 'runner', userId = null } = {}) {
  if (!Array.isArray(projectKeys) || projectKeys.length === 0) return null;
  const placeholders = projectKeys.map(() => '?').join(',');
  // Assignee-routing: an ASSIGNED task is only handed to its assignee's connector (userId is the
  // connector's authed user); unassigned tasks stay open to any connector serving the repo. Note that the
  // board auto-assigns a task to whoever STARTS it (see server assignOnStart), so started work is routed.
  const rows = db
    .prepare(
      `SELECT w.id, p.owner_id AS projectOwnerId, p.team_id AS projectTeamId FROM wake_queue w
         JOIN tasks t ON t.id = w.task_id
         JOIN projects p ON p.id = t.project_id
        WHERE w.claimed_at IS NULL AND w.enqueued_at <= ? AND p.key IN (${placeholders})
        AND (t.assignee_id IS NULL OR t.assignee_id = ?)
        ORDER BY w.enqueued_at, w.rowid`
    )
    .all(Date.now(), ...projectKeys, userId);
  for (const row of rows) {
    if (userId && !canAccessProject(db, userId, { ownerId: row.projectOwnerId, teamId: row.projectTeamId }, 'task.update')) {
      continue;
    }
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, row.id);
    if (res.changes === 1) return getWake(db, row.id);
  }
  return null;
}

// Board-wide claim: the oldest pending wake for a task whose project has a LOCAL checkout on THIS host
// (root_path set). Used by the runner baked into `be10x serve`, which works every linked repo — so a user
// adds a folder on the board and it just works, no per-repo terminal. The `root_path IS NOT NULL` guard is
// what makes a HOSTED board coexist with remote connectors: distributed projects are registered path-less
// (their repo lives on a member's machine), so the baked runner never grabs — and then fails to worktree —
// a task that a `be10x connect` runner is meant to claim. It just idles when there are no local repos.
export function claimNextWakeAny(db, workerId = 'runner', { claimantUserId = null } = {}) {
  // Assignee-routing: claimantUserId is the user this host's runner acts for (GFA_WORKER_USER). An assigned
  // task is claimed only when assigned to that user; unassigned tasks are open. With no identity (a
  // board-only host) only unassigned tasks match — set GFA_WORKER_USER='' to keep the host from running work.
  const rows = db
    .prepare(
      `SELECT w.id FROM wake_queue w
         JOIN tasks t ON t.id = w.task_id
         JOIN projects p ON p.id = t.project_id
        WHERE w.claimed_at IS NULL AND w.enqueued_at <= ? AND p.root_path IS NOT NULL
        AND (t.assignee_id IS NULL OR t.assignee_id = ?)
        ORDER BY w.enqueued_at, w.rowid`
    )
    .all(Date.now(), claimantUserId);
  for (const { id } of rows) {
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, id);
    if (res.changes === 1) return getWake(db, id);
  }
  return null;
}
