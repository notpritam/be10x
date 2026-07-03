// ABOUTME: Read-only aggregation queries behind the admin dashboard — platform-wide counts, a
// ABOUTME: searchable user list, and one user's full detail. Pure (db-in, plain objects out).
import { usageTotalsSql } from '../executor/runs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Platform-wide counts for the dashboard's top line. "Active" = owns a task created or updated
// within the window (created_at == updated_at on a brand-new task, so this covers both).
export function adminOverview(db, { activeSinceMs = 7 * DAY_MS } = {}) {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers = db
    .prepare('SELECT COUNT(DISTINCT owner_id) AS c FROM tasks WHERE updated_at >= ?')
    .get(Date.now() - activeSinceMs).c;
  const taskCount = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  const doneCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'").get().c;
  const usage = db.prepare(`SELECT ${usageTotalsSql('runs')} FROM runs`).get();
  return { userCount, activeUsers, taskCount, doneCount, usage };
}

// A searchable, paginated user list with per-user task/usage totals. `q` matches email or display
// name (case-insensitive substring); %/_ are escaped so they're literal, matching users.js
// searchUsers. Task-status counting uses COUNT(DISTINCT ...) rather than SUM of a per-row flag —
// a task with multiple runs fans out across the join, and a plain SUM would double-count its
// status for every extra run row.
export function listUsersForAdmin(db, { q = '', limit = 50 } = {}) {
  const term = String(q ?? '').trim().toLowerCase();
  const where = term ? 'WHERE LOWER(u.email) LIKE ? ESCAPE \'\\\' OR LOWER(u.display_name) LIKE ? ESCAPE \'\\\'' : '';
  const args = [];
  if (term) {
    const like = '%' + term.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    args.push(like, like);
  }
  const sql = `
    SELECT
      u.id, u.email, u.display_name AS displayName, u.created_at AS createdAt,
      COUNT(DISTINCT t.id) AS taskCount,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) AS tasksDone,
      ${usageTotalsSql('r')}
    FROM users u
    LEFT JOIN tasks t ON t.owner_id = u.id
    LEFT JOIN runs r ON r.task_id = t.id
    ${where}
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT ?
  `;
  args.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  return db.prepare(sql).all(...args);
}

// One user's full task list (each with its own usage totals) plus a rolled-up summary. Returns
// null for an unknown user id so the route can 404 instead of showing an empty shell.
export function userDetailForAdmin(db, userId) {
  const user = db
    .prepare('SELECT id, email, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?')
    .get(userId);
  if (!user) return null;

  const tasks = db
    .prepare(
      `SELECT
         t.id, t.human_id AS humanId, t.title, t.status, t.scope, t.team_id AS teamId,
         t.created_at AS createdAt, ${usageTotalsSql('r')}
       FROM tasks t
       LEFT JOIN runs r ON r.task_id = t.id
       WHERE t.owner_id = ?
       GROUP BY t.id
       ORDER BY t.created_at DESC`
    )
    .all(userId);

  const totals = tasks.reduce(
    (acc, t) => ({
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + t.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + t.cacheReadTokens,
      costUsd: acc.costUsd + t.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 }
  );

  return { user, tasks, totals, tasksDone: tasks.filter((t) => t.status === 'done').length };
}
