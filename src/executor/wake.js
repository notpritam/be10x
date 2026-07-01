// ABOUTME: The wake queue — turns board events into agent runs. Enqueue on a human action; the scheduler
// ABOUTME: claims the oldest pending wake (optimistic lock) and drives the agent. Ephemeral, not always-live.
import { randomUUID } from 'node:crypto';

// Known wake reasons → the executor mode each maps to lives in the scheduler; these are the vocabulary.
export const WAKE_REASONS = ['plan', 'revise', 'input_answer', 'execute', 'pick_up_now', 'follow_up'];

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
// verdict) — stored so the scheduler can build a cheap, delta-only wake prompt.
export function enqueueWake(db, taskId, reason, context = null) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO wake_queue (id, task_id, reason, context_json, enqueued_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, taskId, reason, context == null ? null : JSON.stringify(context), Date.now());
  return getWake(db, id);
}

// Pending (unclaimed) wakes for a task, oldest first.
export function listPendingWakes(db, taskId) {
  return db
    .prepare('SELECT * FROM wake_queue WHERE task_id = ? AND claimed_at IS NULL ORDER BY enqueued_at, rowid')
    .all(taskId)
    .map(hydrate);
}

// Atomically claim the oldest pending wake whose task belongs to `projectId`. The conditional UPDATE
// (WHERE claimed_at IS NULL) makes the claim safe against concurrent schedulers — a loser gets the next
// row or null. Returns the claimed (hydrated) wake, or null if the queue is empty for this project.
export function claimNextWake(db, { projectId, workerId = 'runner' } = {}) {
  const rows = db
    .prepare(
      `SELECT w.id FROM wake_queue w JOIN tasks t ON t.id = w.task_id
       WHERE w.claimed_at IS NULL AND t.project_id = ?
       ORDER BY w.enqueued_at, w.rowid`
    )
    .all(projectId);
  for (const { id } of rows) {
    const res = db
      .prepare('UPDATE wake_queue SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
      .run(Date.now(), workerId, id);
    if (res.changes === 1) return getWake(db, id);
  }
  return null;
}
