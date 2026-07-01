// ABOUTME: Persistence for agent runs — one row per ephemeral Claude session against a task, holding the
// ABOUTME: durable state (session_id, worktree, status) that lets a lost process resume from the DB.
import { randomUUID } from 'node:crypto';

// Map a snake_case `runs` row to the camelCase run object the rest of the code uses. `result` is the
// parsed result_json (null when unset). Returns null for a missing row.
function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    executor: row.executor,
    model: row.model,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseRef: row.base_ref,
    status: row.status,
    pid: row.pid,
    result: row.result_json == null ? null : JSON.parse(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function getRun(db, id) {
  return hydrate(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

// Open a new run for a task in status 'starting'. worktree/branch/baseRef are recorded up front so the
// row is a complete resume record even before the process has produced a session id.
export function createRun(db, { taskId, projectId = null, worktreePath = null, branch = null, baseRef = null }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO runs (id, task_id, project_id, worktree_path, branch, base_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, projectId, worktreePath, branch, baseRef, 'starting', Date.now());
  return getRun(db, id);
}

// The most-recently-created run for a task (the one a resume would pick up), or null.
export function getLatestRunForTask(db, taskId) {
  return hydrate(
    db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId)
  );
}

// All runs for a task, oldest first.
export function listRunsForTask(db, taskId) {
  return db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at, rowid').all(taskId).map(hydrate);
}

// Persist Claude's session id the moment it is first scraped from the stream.
export function setRunSession(db, id, sessionId) {
  db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, id);
  return getRun(db, id);
}

export function setRunPid(db, id, pid) {
  db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id);
  return getRun(db, id);
}

// Persist the model the agent actually ran on (scraped from its stream), so the board can show it.
export function setRunModel(db, id, model) {
  db.prepare('UPDATE runs SET model = ? WHERE id = ?').run(model, id);
  return getRun(db, id);
}

// Flip a run to 'running' and stamp started_at once (COALESCE keeps the first start time on re-entry).
export function markRunning(db, id) {
  db.prepare('UPDATE runs SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run(
    'running',
    Date.now(),
    id
  );
  return getRun(db, id);
}

// Close a run out. `status` must be 'done' or 'failed'. `result` (any JSON) and `error` (stringified)
// are optional; ended_at is stamped now.
export function finishRun(db, id, { status, result = null, error = null } = {}) {
  if (status !== 'done' && status !== 'failed') {
    throw new Error('finishRun: status must be done|failed');
  }
  db.prepare('UPDATE runs SET status = ?, result_json = ?, error = ?, ended_at = ? WHERE id = ?').run(
    status,
    result == null ? null : JSON.stringify(result),
    error == null ? null : String(error),
    Date.now(),
    id
  );
  return getRun(db, id);
}
