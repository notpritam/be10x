// ABOUTME: Plan version history — each setPlan snapshots the plan as an immutable row here, so the board
// ABOUTME: can show previous-vs-new plans and restore an earlier one. Pure core; no HTTP/MCP.
import { randomUUID } from 'node:crypto';

// Snapshot the current plan as a new version. Returns the new version id.
export function recordPlanVersion(db, { taskId, plan, createdBy = null }) {
  const id = randomUUID();
  db.prepare('INSERT INTO plan_versions (id, task_id, plan_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    taskId,
    JSON.stringify(plan),
    createdBy,
    Date.now()
  );
  return id;
}

function hydrate(row) {
  return { id: row.id, plan: JSON.parse(row.plan_json), createdBy: row.created_by, createdAt: row.created_at };
}

// Newest-first. rowid breaks ties when two snapshots land in the same millisecond (insertion order).
export function listPlanVersions(db, taskId) {
  return db
    .prepare('SELECT id, plan_json, created_by, created_at FROM plan_versions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(taskId)
    .map(hydrate);
}

export function getPlanVersion(db, id) {
  const row = db.prepare('SELECT id, plan_json, created_by, created_at FROM plan_versions WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}
