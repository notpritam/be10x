// ABOUTME: Append-only task event log — the activity feed / audit trail behind every task.
import { randomUUID } from 'node:crypto';

export function appendEvent(db, taskId, actor, kind, payload = {}) {
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
