// ABOUTME: The per-project agent runner — the local sibling of src/worker: atomically claim the next
// ABOUTME: ready_to_work agent-executable task scoped to ONE project, then drive an injected executor.
import { getType } from '../tasks/types.js';
import { getTask, transition } from '../tasks/tasks.js';
import { appendEvent } from '../tasks/events.js';
import { recordProgress } from '../worker/worker.js';
import { claimNextWake } from '../executor/wake.js';
import { unseenComments, markCommentsSeen } from '../tasks/comments.js';
import { finishRun } from '../executor/runs.js';

// Claim the oldest ready_to_work task in `projectId` whose type is agent-executable. The conditional
// UPDATE (WHERE ... AND status='ready_to_work') makes the claim atomic, so two runners polling the same
// project can never grab the same task. Returns the claimed task (now in_progress) or null.
export function claimNextForProject(db, projectId, workerId = 'runner') {
  const rows = db
    .prepare("SELECT id, type FROM tasks WHERE status = 'ready_to_work' AND project_id = ? ORDER BY created_at, rowid")
    .all(projectId);
  for (const row of rows) {
    let executable = false;
    try {
      executable = getType(row.type).agentExecutable;
    } catch {
      executable = false;
    }
    if (!executable) continue;
    const res = db
      .prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'ready_to_work'")
      .run(Date.now(), row.id);
    if (res.changes === 1) {
      appendEvent(db, row.id, workerId, 'status', {
        from: 'ready_to_work',
        to: 'in_progress',
        claimedBy: workerId,
        projectId,
      });
      return getTask(db, row.id);
    }
  }
  return null;
}

// A runner with no real executor still leaves a trail: record a no-op progress note so the board shows
// the task was picked up rather than silently flipping to in_progress.
function defaultExecute(db, task, workerId) {
  recordProgress(
    db,
    task.id,
    { state: 'working', step: 'runner', message: `runner ${workerId}: no executor configured (no-op)` },
    workerId
  );
}

// Claim one task for the project and run it. On success returns the claimed task; if nothing is ready
// returns null; if the executor throws, records a `blocked` progress note and returns { task, error }
// (rethrow-safe — a single failing task never kills the loop).
export async function runOnce(db, { projectId, workerId = 'runner', execute } = {}) {
  const task = claimNextForProject(db, projectId, workerId);
  if (!task) return null;
  recordProgress(
    db,
    task.id,
    { state: 'working', step: 'picked up', message: `runner ${workerId} picked up ${task.humanId}` },
    workerId
  );
  const run = execute || ((t) => defaultExecute(db, t, workerId));
  try {
    await run(task);
    return task;
  } catch (error) {
    recordProgress(db, task.id, { state: 'blocked', step: 'error', message: String(error?.message ?? error) }, workerId);
    return { task, error };
  }
}

// Poll runOnce on an interval. `once` runs exactly one pass then resolves. Returns a stoppable handle:
// { stop(), stopped, done } where `done` resolves to the last pass's result (useful for --once/tests).
export function workLoop(db, { projectId, workerId = 'runner', intervalMs = 3000, execute, once = false } = {}) {
  let stopped = false;
  let timer = null;
  let lastResult = null;

  async function loop() {
    do {
      if (stopped) break;
      lastResult = await runOnce(db, { projectId, workerId, execute });
      if (once || stopped) break;
      await new Promise((res) => {
        timer = setTimeout(res, intervalMs);
      });
    } while (!stopped);
    return lastResult;
  }

  const done = loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}

// --- wake-driven scheduler (v2) ---------------------------------------------
// The board is event-driven: human actions enqueue wakes (src/executor/wake.js); the scheduler drains
// them and drives an ephemeral, resumed agent per wake. "Staying on a task" is re-waking from durable
// state, never a live process.

const REASON_MODE = { plan: 'plan', revise: 'revise', input_answer: 'input_answer', execute: 'execute', follow_up: 'follow_up' };

// The executor mode a wake maps to. pick_up_now is contextual — it means "do the useful next thing",
// which depends on where the task currently sits.
function modeForWake(wake, task) {
  if (wake.reason === 'pick_up_now') {
    if (task.status === 'plan_review') return 'revise';
    if (['ready_to_work', 'in_progress', 'needs_input'].includes(task.status)) return 'execute';
    return 'plan';
  }
  return REASON_MODE[wake.reason] || 'plan';
}

// Transition, swallowing an illegal/again transition so orchestration never crashes on a race.
function safeTransition(db, taskId, to, actor, meta) {
  try {
    return transition(db, taskId, to, actor, meta);
  } catch {
    return null;
  }
}

// Claim one wake for the project and drive the agent. The scheduler owns only the lifecycle *claims*
// (hand-off, checkout, verify hand-back); the agent owns plan/progress/review via the gfa_* tools.
// A failing run records a blocked note and returns { wake, error } — one bad wake never kills the loop.
export async function runWakeOnce(db, { projectId, workerId = 'runner', execute } = {}) {
  const wake = claimNextWake(db, { projectId, workerId });
  if (!wake) return null;
  const task = getTask(db, wake.taskId);
  if (!task) return { wake, skipped: 'no-task' };

  const mode = modeForWake(wake, task);

  // Scheduler-owned lifecycle claims (optimistic; guarded by current status):
  if (mode === 'plan' && task.status === 'backlog') safeTransition(db, task.id, 'researching', workerId, { wake: wake.reason });
  if (mode === 'execute' && task.status === 'ready_to_work')
    safeTransition(db, task.id, 'in_progress', workerId, { wake: wake.reason, claimedBy: workerId });

  const staged = getTask(db, task.id);
  const comments = unseenComments(db, task.id);
  recordProgress(db, task.id, { state: 'working', step: 'woken', message: `woken to ${mode} (${wake.reason})` }, workerId);

  const run = execute || ((t, o) => defaultExecute(db, t, workerId, o));
  let summary;
  try {
    summary = await run(staged, { mode, wakeContext: wake.context, comments, resume: mode !== 'plan' });
  } catch (error) {
    recordProgress(db, task.id, { state: 'blocked', step: 'error', message: String(error?.message ?? error) }, workerId);
    return { wake, task: staged, error };
  }

  // Deltas consumed → mark them seen so the next wake stays delta-only.
  markCommentsSeen(db, comments.map((c) => c.id));

  // A successful implementation pass hands the task to verifying for human sign-off.
  if (mode === 'execute' && summary && summary.done && getTask(db, task.id).status === 'in_progress') {
    safeTransition(db, task.id, 'verifying', workerId, { wake: wake.reason });
  }
  return { wake, task: getTask(db, task.id), summary };
}

// Boot-time orphan recovery: a run left 'starting'/'running' means the process died mid-flight — mark it
// failed so it can't wedge the task. Returns how many were reaped.
export function recoverOrphans(db) {
  const rows = db.prepare("SELECT id FROM runs WHERE status IN ('starting','running')").all();
  for (const r of rows) finishRun(db, r.id, { status: 'failed', error: 'orphaned: process gone before completion' });
  return rows.length;
}

// Poll runWakeOnce on an interval (recovering orphans once at start). Same stoppable handle as workLoop.
export function wakeLoop(db, { projectId, workerId = 'runner', intervalMs = 3000, execute, once = false } = {}) {
  recoverOrphans(db);
  let stopped = false;
  let timer = null;
  let lastResult = null;

  async function loop() {
    do {
      if (stopped) break;
      lastResult = await runWakeOnce(db, { projectId, workerId, execute });
      if (once || stopped) break;
      await new Promise((res) => {
        timer = setTimeout(res, intervalMs);
      });
    } while (!stopped);
    return lastResult;
  }

  const done = loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}
