// ABOUTME: Assembles a consolidated raw snapshot of everything the board knows about a task — the
// "what's going on exactly" blob behind the debug button: live agent status, run rows (with results
// and errors), the wake queue, recent events, and any open question, plus the server clock so the
// client can show accurate "Xs ago" without trusting its own time.
import { getTask } from './tasks.js';
import { listEvents } from './events.js';
import { listRunsForTask } from '../executor/runs.js';
import { getOpenInputRequest } from './input_requests.js';

const EVENT_LIMIT = 60;

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// The wake queue tells you WHY a task is (or isn't) moving: a pending wake with claimed_at null means
// the runner hasn't picked it up yet; a claimed wake with a live run means an agent is on it.
function listWakesForTask(db, taskId) {
  return db
    .prepare(
      'SELECT id, reason, context_json, enqueued_at AS enqueuedAt, claimed_at AS claimedAt, claimed_by AS claimedBy FROM wake_queue WHERE task_id = ? ORDER BY enqueued_at DESC, rowid DESC'
    )
    .all(taskId)
    .map((w) => ({
      id: w.id,
      reason: w.reason,
      context: w.context_json ? safeParse(w.context_json) : null,
      enqueuedAt: w.enqueuedAt,
      claimedAt: w.claimedAt,
      claimedBy: w.claimedBy,
      pending: w.claimedAt == null,
    }));
}

// Everything the debug view needs in one call. Returns null when the task doesn't exist.
export function taskDebug(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return null;
  const events = listEvents(db, taskId);
  return {
    now: Date.now(),
    task,
    agent: task.agent ?? null,
    runs: listRunsForTask(db, taskId),
    wakes: listWakesForTask(db, taskId),
    events: events.slice(-EVENT_LIMIT).reverse(), // most-recent first for the debug view
    input: getOpenInputRequest(db, taskId),
  };
}
