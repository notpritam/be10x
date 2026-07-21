// ABOUTME: The notifications feed — a per-user "something needs you" stream. Clients (the connector, the web
// ABOUTME: bell) read it with a monotonic `since` seq (the row's rowid) for exactly-once, catch-up delivery.
import { randomUUID } from 'node:crypto';

function hydrate(row) {
  return row
    ? {
        id: row.id,
        seq: row.seq,
        userId: row.user_id,
        kind: row.kind,
        taskId: row.task_id,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        seenAt: row.seen_at,
      }
    : null;
}

// Record a notification for `userId`. Best-effort and self-aware: a null/empty user, or a user acting on
// their OWN task (userId === actorId), produces nothing — you never get pinged for what you did yourself.
// Never throws (a feed write must not break the mutation that triggered it).
export function notify(db, userId, kind, { taskId = null, title, body = null, actorId = null } = {}) {
  if (!userId || userId === actorId) return null;
  try {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO notifications (id, user_id, kind, task_id, title, body, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
    ).run(id, userId, kind, taskId, title, body, Date.now());
    return hydrate(db.prepare('SELECT rowid AS seq, * FROM notifications WHERE id = ?').get(id));
  } catch {
    return null;
  }
}

// Notifications for `userId` newer than `sinceSeq` (a rowid), oldest→newest — the connector's catch-up read.
export function listNotificationsSince(db, userId, sinceSeq = 0, limit = 50) {
  return db
    .prepare('SELECT rowid AS seq, * FROM notifications WHERE user_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?')
    .all(userId, Number(sinceSeq) || 0, limit)
    .map(hydrate);
}

// Newest-first, for the web bell dropdown.
export function listNotificationsForUser(db, userId, limit = 30) {
  return db
    .prepare('SELECT rowid AS seq, * FROM notifications WHERE user_id = ? ORDER BY rowid DESC LIMIT ?')
    .all(userId, limit)
    .map(hydrate);
}

export function unseenCount(db, userId) {
  return db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND seen_at IS NULL').get(userId).c;
}

export function markAllSeen(db, userId, now = Date.now()) {
  db.prepare('UPDATE notifications SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL').run(now, userId);
}
