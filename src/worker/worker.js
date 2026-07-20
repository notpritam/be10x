// ABOUTME: The cron worker's core: atomically claim the next ready_to_work agent-executable task,
// ABOUTME: and recordProgress — the changes-watcher sink that streams step/message/changes onto the task.
import { getType } from '../tasks/types.js';
import { getTask } from '../tasks/tasks.js';
import { appendEvent } from '../tasks/events.js';

// Claim the oldest ready_to_work task whose type is agent-executable. The conditional UPDATE makes the
// claim atomic, so two workers polling at once can never grab the same task.
export function claimNextReadyTask(db, workerId = 'worker') {
  const rows = db.prepare("SELECT id, type FROM tasks WHERE status = 'ready_to_work' ORDER BY created_at, rowid").all();
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
      appendEvent(db, row.id, workerId, 'status', { from: 'ready_to_work', to: 'in_progress', claimedBy: workerId });
      return getTask(db, row.id);
    }
  }
  return null;
}

// Stream progress / agent status onto a task (the changes-watcher data sink). Updates the latest agent
// block and appends a progress event so the board shows real movement, not just a spinner.
//
// todos/changes are PRESERVED when an update doesn't carry them: a plain progress note (from the executor
// stream or the runner's "woken" note) must not wipe the agent's implementation checklist. Only an update
// that actually provides todos/changes replaces them — that's why the task list used to vanish mid-run.
// `state`/`phase`/`stateStartedAt` carry the hook-derived agent state machine (see executor/agent-status.js).
// When an update omits `state`, the PRIOR state is preserved (a bare progress note must not flip a
// `waiting` session back to `working`); `stateStartedAt` moves only when the state actually changes.
export function recordProgress(db, taskId, { state, step = '', message = '', todos, changes, phase, stateStartedAt } = {}, actor = 'agent') {
  const prevRow = db.prepare('SELECT agent_json FROM tasks WHERE id = ?').get(taskId);
  const prev = prevRow && prevRow.agent_json ? JSON.parse(prevRow.agent_json) : {};
  const now = Date.now();
  const nextState = state !== undefined ? state : prev.state ?? 'working';
  const stateChanged = nextState !== prev.state;
  const agent = {
    state: nextState,
    step,
    message,
    phase: phase !== undefined ? phase : prev.phase ?? null,
    stateStartedAt: stateStartedAt !== undefined ? stateStartedAt : (stateChanged ? now : prev.stateStartedAt ?? now),
    todos: todos !== undefined ? todos : prev.todos ?? [],
    changes: changes !== undefined ? changes : prev.changes ?? null,
    updatedAt: now,
  };
  db.prepare('UPDATE tasks SET agent_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(agent), now, taskId);
  appendEvent(db, taskId, actor, 'progress', { step, message, changes });
  return getTask(db, taskId);
}
