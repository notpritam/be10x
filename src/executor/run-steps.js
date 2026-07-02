// ABOUTME: The execution trace — one row per meaningful thing a run did: the prompt/context handed to the
// ABOUTME: agent, each tool it invoked (with input), tool results, and the terminal outcome. Debug depth.
import { randomUUID } from 'node:crypto';

// Record one step of a run's trace. `detail` is any JSON (the prompt text, a tool's input, the result
// object) — stored verbatim (NOT truncated like board progress notes) so a human can reconstruct exactly
// what the agent ran and saw. Best-effort: a trace write must never crash the run, so callers guard it.
export function recordRunStep(db, { runId, taskId, seq, kind, tool = null, detail = null }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO run_steps (id, run_id, task_id, seq, kind, tool, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, runId, taskId, seq, kind, tool, detail == null ? null : JSON.stringify(detail), Date.now());
  return id;
}

function hydrate(row) {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    seq: row.seq,
    kind: row.kind,
    tool: row.tool,
    detail: row.detail_json == null ? null : safeParse(row.detail_json),
    createdAt: row.created_at,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// The ordered trace for one run.
export function listRunSteps(db, runId) {
  return db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq, rowid').all(runId).map(hydrate);
}

// The whole trace for a task across all its runs (newest run's steps last), for a task-wide timeline.
export function listRunStepsForTask(db, taskId) {
  return db.prepare('SELECT * FROM run_steps WHERE task_id = ? ORDER BY created_at, rowid').all(taskId).map(hydrate);
}
