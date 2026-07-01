// ABOUTME: The plan-review gate — tag a reviewer, then approve (→ ready_to_work) or request changes (→ researching).
// ABOUTME: Every review is recorded in the reviews table and mirrored to the task event log.
import { randomUUID } from 'node:crypto';
import { getTask, transition } from '../tasks/tasks.js';
import { appendEvent } from '../tasks/events.js';

export function requestReview(db, taskId, reviewerId, actor) {
  const task = getTask(db, taskId);
  if (!task) throw new Error('NO_TASK');
  db.prepare('UPDATE tasks SET reviewer_id = ?, updated_at = ? WHERE id = ?').run(reviewerId, Date.now(), taskId);
  if (task.status !== 'plan_review') {
    transition(db, taskId, 'plan_review', actor, { review: 'requested', reviewerId });
  } else {
    appendEvent(db, taskId, actor, 'review_requested', { reviewerId });
  }
  return getTask(db, taskId);
}

export function submitReview(db, taskId, reviewerId, verdict, comment = '') {
  if (!['approved', 'changes_requested'].includes(verdict)) throw new Error('INVALID_VERDICT');
  const task = getTask(db, taskId);
  if (!task) throw new Error('NO_TASK');
  const id = randomUUID();
  db.prepare('INSERT INTO reviews (id, task_id, reviewer_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    taskId,
    reviewerId,
    verdict,
    comment,
    Date.now()
  );
  appendEvent(db, taskId, reviewerId, 'review', { verdict, comment });
  if (verdict === 'approved') transition(db, taskId, 'ready_to_work', reviewerId, { review: 'approved' });
  else transition(db, taskId, 'researching', reviewerId, { review: 'changes_requested' });
  return { id, taskId, reviewerId, verdict, comment };
}

export function listReviews(db, taskId) {
  return db
    .prepare('SELECT id, reviewer_id AS reviewerId, verdict, comment, created_at AS createdAt FROM reviews WHERE task_id = ? ORDER BY rowid')
    .all(taskId);
}
