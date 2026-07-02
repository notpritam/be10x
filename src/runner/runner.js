// ABOUTME: The per-project agent runner — the local sibling of src/worker: atomically claim the next
// ABOUTME: ready_to_work agent-executable task scoped to ONE project, then drive an injected executor.
import { getType } from '../tasks/types.js';
import { getTask, transition } from '../tasks/tasks.js';
import { appendEvent } from '../tasks/events.js';
import { recordProgress } from '../worker/worker.js';
import { claimNextWake, claimNextWakeAny, enqueueWake } from '../executor/wake.js';
import { unseenComments, markCommentsSeen } from '../tasks/comments.js';
import { finishRun } from '../executor/runs.js';
import { getProject } from '../projects/projects.js';

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

const REASON_MODE = { plan: 'plan', revise: 'revise', input_answer: 'input_answer', execute: 'execute', follow_up: 'follow_up', verify: 'verify' };

// The executor mode a wake maps to. pick_up_now is contextual — it means "do the useful next thing",
// which depends on where the task currently sits.
function modeForWake(wake, task) {
  // A query/chat task is always a conversation — never plan/review/execute, whatever woke it.
  if (task.type === 'query') return 'chat';
  if (wake.reason === 'pick_up_now') {
    if (task.status === 'plan_review') return 'revise';
    if (['ready_to_work', 'in_progress', 'needs_input', 'verifying'].includes(task.status)) return 'execute';
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

// Drive an already-claimed wake with a resolved executor. The scheduler owns only the lifecycle *claims*
// (hand-off, checkout, verify hand-back); the agent owns plan/progress/review via the gfa_* tools. A
// failing run records a blocked note and returns { wake, error } — one bad wake never kills the loop.
async function driveWake(db, { wake, task, workerId, execute }) {
  const mode = modeForWake(wake, task);

  // Scheduler-owned lifecycle claims (optimistic; guarded by current status):
  if (mode === 'plan' && task.status === 'backlog') safeTransition(db, task.id, 'researching', workerId, { wake: wake.reason });
  if (mode === 'execute' && task.status === 'ready_to_work')
    safeTransition(db, task.id, 'in_progress', workerId, { wake: wake.reason, claimedBy: workerId });

  const staged = getTask(db, task.id);
  const comments = unseenComments(db, task.id);
  recordProgress(db, task.id, { state: 'working', step: 'woken', message: `woken to ${mode} (${wake.reason})` }, workerId);

  let summary;
  try {
    // Context policy (resume vs fresh) is owned by the executor per mode — don't force it here.
    summary = await execute(staged, { mode, wakeContext: wake.context, comments });
  } catch (error) {
    recordProgress(db, task.id, { state: 'blocked', step: 'error', message: String(error?.message ?? error) }, workerId);
    return { wake, task: staged, error };
  }

  // Deltas consumed → mark them seen so the next wake stays delta-only.
  markCommentsSeen(db, comments.map((c) => c.id));

  // A successful implementation pass hands the task to verifying, then wakes a FRESH agent to
  // self-verify the diff against the plan (it reports; the human still does final sign-off).
  if (mode === 'execute' && summary && summary.done && getTask(db, task.id).status === 'in_progress') {
    safeTransition(db, task.id, 'verifying', workerId, { wake: wake.reason });
    enqueueWake(db, task.id, 'verify');
  }
  return { wake, task: getTask(db, task.id), summary };
}

// Claim one wake for a single project and drive it (used by `be10x work` inside one repo).
export async function runWakeOnce(db, { projectId, workerId = 'runner', execute } = {}) {
  const wake = claimNextWake(db, { projectId, workerId });
  if (!wake) return null;
  const task = getTask(db, wake.taskId);
  if (!task) return { wake, skipped: 'no-task' };
  const run = execute || ((t, o) => defaultExecute(db, t, workerId, o));
  return driveWake(db, { wake, task, workerId, execute: run });
}

// Board-wide: claim the oldest wake for ANY project and drive it in that project's own repo. Used by the
// runner baked into `be10x serve`, so the user never runs a per-repo terminal. `makeExecutor(project)`
// builds the executor for the resolved project.
export async function runAnyWakeOnce(db, { workerId = 'runner', makeExecutor } = {}) {
  const wake = claimNextWakeAny(db, workerId);
  if (!wake) return null;
  const task = getTask(db, wake.taskId);
  if (!task) return { wake, skipped: 'no-task' };
  const project = getProject(db, task.projectId);
  if (!project) {
    recordProgress(db, task.id, { state: 'blocked', step: 'no-project', message: 'task has no linked repo to work in' }, workerId);
    return { wake, task, skipped: 'no-project' };
  }
  return driveWake(db, { wake, task, workerId, execute: makeExecutor(project) });
}

// Is a pid still a live process? `kill(pid, 0)` sends no signal — it just probes existence. ESRCH means
// gone; EPERM means it exists but isn't ours (still alive). A null pid never ran far enough to record one.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Orphan recovery: a run left 'starting'/'running' whose process is gone must be failed so it can't wedge
// the task or falsely read as "Agent running" forever. An agent spawned by a previous server can OUTLIVE a
// restart, so we only reap runs whose recorded pid is actually dead — a genuinely-live agent is left alone.
//
// `requirePid` distinguishes two callers:
//   - boot (false, default): a run with NO pid is a genuine orphan from a dead process (the parent died
//     before it ever recorded a pid) → reap it.
//   - live periodic sweep (true): a pid-less run is almost certainly one we just created and haven't
//     spawned yet (createRun sets status before setRunPid) → LEAVE it, or we'd reap our own newborn run.
// Returns how many were reaped.
export function recoverOrphans(db, { requirePid = false } = {}) {
  const rows = db.prepare("SELECT id, pid FROM runs WHERE status IN ('starting','running')").all();
  let reaped = 0;
  for (const r of rows) {
    if (r.pid == null) {
      if (requirePid) continue; // live sweep: mid-spawn, not an orphan
      // boot: a pid-less starting run is a genuine leftover — fall through and reap
    } else if (pidAlive(r.pid)) {
      continue; // process still alive — leave it running
    }
    finishRun(db, r.id, { status: 'failed', error: 'orphaned: process gone before completion' });
    reaped++;
  }
  return reaped;
}

// Poll runWakeOnce on an interval (recovering orphans once at start, then sweeping dead-pid runs on a
// separate timer so an agent that dies AFTER a restart doesn't linger as a false "running"). Same
// stoppable handle as workLoop.
export function wakeLoop(db, { projectId, workerId = 'runner', intervalMs = 3000, sweepMs = 15000, execute, once = false } = {}) {
  recoverOrphans(db);
  let stopped = false;
  let timer = null;
  let sweepTimer = null;
  let lastResult = null;
  if (!once) sweepTimer = setInterval(() => { try { recoverOrphans(db, { requirePid: true }); } catch { /* best-effort */ } }, sweepMs);

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
      if (sweepTimer) clearInterval(sweepTimer);
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}

// Board-wide poll: drain wakes across ALL linked repos, spawning the agent in each task's own repo. This
// is the runner baked into `be10x serve` so a user never runs a per-repo terminal.
export function wakeLoopAll(db, { workerId = 'runner', intervalMs = 3000, sweepMs = 15000, makeExecutor, once = false } = {}) {
  recoverOrphans(db);
  let stopped = false;
  let timer = null;
  let sweepTimer = null;
  let lastResult = null;
  // A dedicated timer (not the wake tick, which is busy awaiting a running agent) reaps runs whose pid has
  // died since boot — so a false "Agent running" self-corrects within sweepMs instead of at the next restart.
  if (!once) sweepTimer = setInterval(() => { try { recoverOrphans(db, { requirePid: true }); } catch { /* best-effort */ } }, sweepMs);

  async function loop() {
    do {
      if (stopped) break;
      lastResult = await runAnyWakeOnce(db, { workerId, makeExecutor });
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
      if (sweepTimer) clearInterval(sweepTimer);
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}
