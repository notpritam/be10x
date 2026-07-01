// ABOUTME: The task engine — typed tasks over SQLite. Every mutation validates, updates the row,
// ABOUTME: bumps updated_at, and appends a task_events row. Pure core; no HTTP/MCP.
import { randomUUID } from 'node:crypto';
import { getType, validateContent } from './types.js';
import { appendEvent } from './events.js';

function hydrate(row) {
  return {
    id: row.id,
    humanId: row.human_id,
    type: row.type,
    scope: row.scope,
    teamId: row.team_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    assigneeId: row.assignee_id,
    reviewerId: row.reviewer_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    content: JSON.parse(row.content_json),
    plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    research: row.research_json ? JSON.parse(row.research_json) : null,
    rating: row.rating_json ? JSON.parse(row.rating_json) : null,
    refs: row.refs_json ? JSON.parse(row.refs_json) : null,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextHumanId(db) {
  const c = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  return 'GFA-' + String(c + 1).padStart(3, '0');
}

export function createTask(db, { type, scope, title, ownerId, content = {}, teamId = null, projectId = null, severity = 'medium' }) {
  getType(type);
  validateContent(type, content);
  const id = randomUUID();
  const humanId = nextHumanId(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, human_id, type, scope, team_id, project_id, owner_id, title, status, severity, content_json, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, 0, ?, ?)`
  ).run(id, humanId, type, scope, teamId, projectId, ownerId, title, severity, JSON.stringify(content), now, now);
  appendEvent(db, id, ownerId, 'created', { type, scope, title });
  return getTask(db, id);
}

export function getTask(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function listTasks(db, { scope, teamId, status, ownerId } = {}) {
  const where = [];
  const args = [];
  if (scope) { where.push('scope = ?'); args.push(scope); }
  if (teamId) { where.push('team_id = ?'); args.push(teamId); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (ownerId) { where.push('owner_id = ?'); args.push(ownerId); }
  const sql = 'SELECT * FROM tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at';
  return db.prepare(sql).all(...args).map(hydrate);
}
