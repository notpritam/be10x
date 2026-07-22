// ABOUTME: Persistence for agent runs — one row per ephemeral Claude session against a task, holding the
// ABOUTME: durable state (session_id, worktree, status) that lets a lost process resume from the DB.
import { randomUUID } from 'node:crypto';

// A SUM(...) fragment over runs' token/cost columns, aliased to the camelCase names every usage
// consumer (admin dashboard, leaderboard) expects. Shared so the two never drift apart. `alias` is
// the runs table's alias in the caller's query (never user input — always a literal at call sites).
export function usageTotalsSql(alias) {
  return `COALESCE(SUM(${alias}.input_tokens), 0) AS inputTokens,
          COALESCE(SUM(${alias}.output_tokens), 0) AS outputTokens,
          COALESCE(SUM(${alias}.cache_creation_tokens), 0) AS cacheCreationTokens,
          COALESCE(SUM(${alias}.cache_read_tokens), 0) AS cacheReadTokens,
          COALESCE(SUM(${alias}.cost_usd), 0) AS costUsd`;
}

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
    host: row.host,
    status: row.status,
    pid: row.pid,
    result: row.result_json == null ? null : JSON.parse(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    costUsd: row.cost_usd,
  };
}

export function getRun(db, id) {
  return hydrate(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

// Open a new run for a task in status 'starting'. worktree/branch/baseRef are recorded up front so the
// row is a complete resume record even before the process has produced a session id.
export function createRun(db, { taskId, projectId = null, worktreePath = null, branch = null, baseRef = null, host = null }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO runs (id, task_id, project_id, worktree_path, branch, base_ref, host, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, projectId, worktreePath, branch, baseRef, host, 'starting', Date.now());
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

// The DISTINCT { path, branch } worktrees recorded across a task's runs — the real, on-disk checkouts to
// reclaim when the task is archived. Driven by the paths persisted at run time (never re-derived from the
// title, which drifts). Runs that never recorded a path (plan-only sessions) are skipped. Ordered by path
// for stable output. This is what archiveTask hands back so a caller/connector can GC exactly these.
export function listRunWorktrees(db, taskId) {
  return db
    .prepare(
      'SELECT DISTINCT worktree_path AS path, branch FROM runs WHERE task_id = ? AND worktree_path IS NOT NULL ORDER BY worktree_path'
    )
    .all(taskId)
    .map((r) => ({ path: r.path, branch: r.branch }));
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
// are optional; ended_at is stamped now. `usage` ({ inputTokens, outputTokens,
// cacheCreationTokens, cacheReadTokens, costUsd }, see claude-adapter.js extractUsage) is optional
// and each field independently nullable — a run that never reached a result event just persists
// nulls rather than blocking on missing usage data.
export function finishRun(db, id, { status, result = null, error = null, usage = null } = {}) {
  if (status !== 'done' && status !== 'failed') {
    throw new Error('finishRun: status must be done|failed');
  }
  db.prepare(
    'UPDATE runs SET status = ?, result_json = ?, error = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?, cost_usd = ? WHERE id = ?'
  ).run(
    status,
    result == null ? null : JSON.stringify(result),
    error == null ? null : String(error),
    Date.now(),
    usage?.inputTokens ?? null,
    usage?.outputTokens ?? null,
    usage?.cacheCreationTokens ?? null,
    usage?.cacheReadTokens ?? null,
    usage?.costUsd ?? null,
    id
  );
  return getRun(db, id);
}
