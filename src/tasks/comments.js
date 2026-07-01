// ABOUTME: Comments — the human's channel for steering the agent on a task (plan feedback, direction).
// ABOUTME: Delta-aware: unseen comments feed the next wake prompt, then markSeen so follow-ups stay cheap.
import { randomUUID } from 'node:crypto';
import { appendEvent } from './events.js';

const ANCHORS = ['general', 'plan_line', 'diagram'];

function hydrate(row) {
  return row
    ? {
        id: row.id,
        taskId: row.task_id,
        author: row.author,
        body: row.body,
        anchor: row.anchor,
        createdAt: row.created_at,
        seenAt: row.seen_at,
      }
    : null;
}

// Add a comment. anchor defaults to 'general' and is coerced to a known value. Appends a task event so
// the activity feed shows the exchange.
export function addComment(db, taskId, { author, body, anchor = 'general' } = {}) {
  const a = ANCHORS.includes(anchor) ? anchor : 'general';
  const id = randomUUID();
  db.prepare('INSERT INTO comments (id, task_id, author, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    taskId,
    author,
    String(body ?? ''),
    a,
    Date.now()
  );
  appendEvent(db, taskId, author, 'comment', { commentId: id, anchor: a, body });
  return getComment(db, id);
}

export function getComment(db, id) {
  return hydrate(db.prepare('SELECT * FROM comments WHERE id = ?').get(id));
}

// All comments on a task, oldest first (the thread).
export function listComments(db, taskId) {
  return db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid').all(taskId).map(hydrate);
}

// Comments the agent has not yet folded into a wake prompt (seen_at IS NULL), oldest first.
export function unseenComments(db, taskId) {
  return db
    .prepare('SELECT * FROM comments WHERE task_id = ? AND seen_at IS NULL ORDER BY created_at, rowid')
    .all(taskId)
    .map(hydrate);
}

// Mark the given comment ids seen (called after they have been delivered to the agent).
export function markCommentsSeen(db, ids = []) {
  if (!ids.length) return 0;
  const now = Date.now();
  const stmt = db.prepare('UPDATE comments SET seen_at = ? WHERE id = ? AND seen_at IS NULL');
  let n = 0;
  for (const id of ids) n += stmt.run(now, id).changes;
  return n;
}
