// ABOUTME: The per-project agent runner — the local sibling of src/worker: atomically claim the next
// ABOUTME: ready_to_work agent-executable task scoped to ONE project, then drive an injected executor.
import { getType } from '../tasks/types.js';
import { getTask } from '../tasks/tasks.js';
import { appendEvent } from '../tasks/events.js';
import { recordProgress } from '../worker/worker.js';

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
