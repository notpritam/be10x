// ABOUTME: The wake queue — turns board events into agent runs. Enqueue on a human action; the scheduler
// ABOUTME: claims the oldest pending wake (optimistic lock) and drives the agent. Ephemeral, not always-live.
import { randomUUID } from 'node:crypto';

// Known wake reasons → the executor mode each maps to lives in the scheduler; these are the vocabulary.
export const WAKE_REASONS = ['plan', 'revise', 'input_answer', 'execute', 'pick_up_now', 'follow_up', 'verify'];

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
export function claimNextWake(db, { projectId, workerId = 'runner' } = {}) {
  const rows = db
    .prepare(
      `SELECT w.id FROM wake_queue w JOIN tasks t ON t.id = w.task_id
       WHERE w.claimed_at IS NULL AND w.enqueued_at <= ? AND (t.project_id = ? OR t.project_id IS NULL)
       ORDER BY w.enqueued_at, w.rowid`
    )
    .all(Date.now(), projectId);
  for (const { id } of rows) {
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, id);
    if (res.changes === 1) return getWake(db, id);
  }
  return null;
}

// Board-wide claim: the oldest pending wake for ANY task that has a project (the executor needs the
// project's repo to work in). Used by the runner baked into `be10x serve`, which works every linked
// repo — so a user adds a folder on the board and it just works, no per-repo terminal.
export function claimNextWakeAny(db, workerId = 'runner') {
  const rows = db
    .prepare(
      `SELECT w.id FROM wake_queue w JOIN tasks t ON t.id = w.task_id
       WHERE w.claimed_at IS NULL AND w.enqueued_at <= ? AND t.project_id IS NOT NULL
       ORDER BY w.enqueued_at, w.rowid`
    )
    .all(Date.now());
  for (const { id } of rows) {
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, id);
    if (res.changes === 1) return getWake(db, id);
  }
  return null;
}
