// ABOUTME: Append-only task event log — the activity feed / audit trail behind every task.
import { randomUUID } from 'node:crypto';

export function appendEvent(db, taskId, actor, kind, payload = {}) {
  // A null/undefined task id would otherwise hit the task_events.task_id NOT NULL constraint with a
  // cryptic SQLite error. Fail with a clear, catchable code instead — this is the guard that turns the
  // gfa_submit_output "NOT NULL constraint failed: task_events.task_id" crash into a clean NO_TASK.
  if (!taskId) throw new Error('NO_TASK');
  const id = randomUUID();
  db.prepare('INSERT INTO task_events (id, task_id, actor, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    taskId,
    actor,
    kind,
    JSON.stringify(payload),
    Date.now()
  );
  return { id, taskId, actor, kind, payload };
}

export function listEvents(db, taskId) {
  // Order by rowid (monotonic insertion order) — same-millisecond events would otherwise tie on created_at.
  return db
    .prepare('SELECT id, actor, kind, payload_json AS payload, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY rowid')
    .all(taskId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
