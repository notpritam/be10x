// ABOUTME: Human-in-the-loop input requests. The agent asks a scoped question (quick choices + custom),
// ABOUTME: the task pauses in needs_input, and answering it resumes the task to in_progress.
import { randomUUID } from 'node:crypto';
import { getTask, transition } from './tasks.js';
import { appendEvent } from './events.js';

export function requestInput(db, taskId, question, { choices = null, allowCustom = true } = {}, actor = 'agent') {
  const task = getTask(db, taskId);
  if (!task) throw new Error('NO_TASK');
  const id = randomUUID();
  db.prepare(
    'INSERT INTO input_requests (id, task_id, question, choices_json, allow_custom, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, question, choices ? JSON.stringify(choices) : null, allowCustom ? 1 : 0, 'open', Date.now());
  appendEvent(db, taskId, actor, 'input_request', { requestId: id, question, choices, allowCustom });
  if (task.status === 'in_progress') transition(db, taskId, 'needs_input', actor, { requestId: id });
  return getOpenInputRequest(db, taskId);
}

// The task an input request belongs to, without pulling the whole request row — the id-only lookup an
// authorization check needs before answerInput mutates anything.
export function getRequestTaskId(db, requestId) {
  const row = db.prepare('SELECT task_id AS taskId FROM input_requests WHERE id = ?').get(requestId);
  return row ? row.taskId : null;
}

export function answerInput(db, requestId, answer, answeredBy) {
  const req = db.prepare('SELECT id, task_id AS taskId, status FROM input_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('NO_REQUEST');
  if (req.status !== 'open') throw new Error('ALREADY_ANSWERED');
  db.prepare('UPDATE input_requests SET answer = ?, answered_by = ?, status = ?, answered_at = ? WHERE id = ?').run(
    answer,
    answeredBy,
    'answered',
    Date.now(),
    requestId
  );
  appendEvent(db, req.taskId, answeredBy, 'input_answer', { requestId, answer });
  const task = getTask(db, req.taskId);
  if (task.status === 'needs_input') transition(db, req.taskId, 'in_progress', answeredBy, { requestId, resumed: true });
  return getOpenInputRequest(db, req.taskId);
}

export function getOpenInputRequest(db, taskId) {
  const r = db
    .prepare(
      "SELECT id, task_id AS taskId, question, choices_json AS choices, allow_custom AS allowCustom, status, answer FROM input_requests WHERE task_id = ? AND status = 'open' ORDER BY rowid DESC"
    )
    .get(taskId);
  if (!r) return null;
  return { ...r, choices: r.choices ? JSON.parse(r.choices) : null, allowCustom: !!r.allowCustom };
}
