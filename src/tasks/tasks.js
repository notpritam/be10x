// ABOUTME: The task engine — typed tasks over SQLite. Every mutation validates, updates the row,
// ABOUTME: bumps updated_at, and appends a task_events row. Pure core; no HTTP/MCP.
import { randomUUID } from 'node:crypto';
import { getType, validateContent } from './types.js';
import { assertTransition } from './lifecycle.js';
import { appendEvent } from './events.js';
import { recordPlanVersion } from '../plans/versions.js';

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
    agent: row.agent_json ? JSON.parse(row.agent_json) : null,
    artifacts: row.artifacts_json ? JSON.parse(row.artifacts_json) : [],
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

// Post a visual artifact (RCA, diagram, finding, suggestion) the human sees in the task view. `content`
// is rich like a plan — HTML (rendered in a sandbox), markdown, or a structured { blocks|html|steps|
// diagram } — HTML being the primary medium (visuals convey best). A stable `key` upserts, so the agent
// can refine an artifact (e.g. update the RCA as it learns) instead of piling up duplicates.
export function postArtifact(db, id, artifact, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const now = Date.now();
  const list = Array.isArray(task.artifacts) ? [...task.artifacts] : [];
  const a = artifact && typeof artifact === 'object' ? artifact : {};
  const key = typeof a.key === 'string' && a.key.trim() ? a.key.trim() : randomUUID();
  const kind = typeof a.kind === 'string' && a.kind.trim() ? a.kind.trim() : 'note';
  const title = typeof a.title === 'string' ? a.title : '';
  const content = a.content !== undefined ? a.content : a;
  const idx = list.findIndex((x) => x && x.key === key);
  if (idx >= 0) {
    list[idx] = { ...list[idx], kind, title, content, updatedAt: now };
  } else {
    list.push({ key, kind, title, content, createdAt: now });
  }
  db.prepare('UPDATE tasks SET artifacts_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), now, id);
  appendEvent(db, id, actor, 'artifact', { key, kind, title });
  return getTask(db, id);
}

export function setResearch(db, id, research, actor) {
  db.prepare('UPDATE tasks SET research_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(research), Date.now(), id);
  appendEvent(db, id, actor, 'research', { research });
  return getTask(db, id);
}

export function setPlan(db, id, plan, actor) {
  db.prepare('UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), Date.now(), id);
  appendEvent(db, id, actor, 'plan', { plan });
  // Snapshot this plan as an immutable version so the board can show history and restore an earlier one.
  recordPlanVersion(db, { taskId: id, plan, createdBy: actor });
  // A recorded plan supersedes any still-open question the agent asked while figuring it out — close them
  // so a stale "needs your input" can't linger on the board once the agent has moved on.
  const open = db.prepare("SELECT id FROM input_requests WHERE task_id = ? AND status = 'open'").all(id);
  if (open.length) {
    const now = Date.now();
    const upd = db.prepare("UPDATE input_requests SET status = 'cancelled', answered_at = ? WHERE id = ? AND status = 'open'");
    for (const r of open) {
      upd.run(now, r.id);
      appendEvent(db, id, actor, 'input_cancelled', { requestId: r.id, reason: 'superseded_by_plan' });
    }
  }
  return getTask(db, id);
}

export function updateContent(db, id, patch, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const merged = { ...task.content, ...patch };
  db.prepare('UPDATE tasks SET content_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), Date.now(), id);
  appendEvent(db, id, actor, 'content', { patch });
  return getTask(db, id);
}

export function transition(db, id, to, actor, meta = {}) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  assertTransition(task.status, to);
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, Date.now(), id);
  appendEvent(db, id, actor, 'status', { from: task.status, to, ...meta });
  return getTask(db, id);
}

export function retryTask(db, id, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const n = task.retryCount + 1;
  db.prepare('UPDATE tasks SET retry_count = ?, updated_at = ? WHERE id = ?').run(n, Date.now(), id);
  appendEvent(db, id, actor, 'retry', { retryCount: n });
  return getTask(db, id);
}

export function rateTask(db, id, rating, actor) {
  db.prepare('UPDATE tasks SET rating_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rating), Date.now(), id);
  appendEvent(db, id, actor, 'rating', { rating });
  return getTask(db, id);
}

export function setRefs(db, id, refs, actor) {
  const now = Date.now();
  db.prepare('UPDATE tasks SET refs_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(refs), now, id);
  // Submitting output means the implementation is done — reconcile the checklist so it can't be left with
  // a stale in-progress step (which happens if the agent stops right after shipping without a final
  // progress update). Any 'in_progress' todo is flipped to 'done'; pending items are left as-is.
  const row = db.prepare('SELECT agent_json FROM tasks WHERE id = ?').get(id);
  if (row && row.agent_json) {
    try {
      const agent = JSON.parse(row.agent_json);
      if (Array.isArray(agent.todos) && agent.todos.length) {
        const ACTIVE = new Set(['in_progress', 'in-progress', 'working', 'active', 'doing', 'started']);
        let changed = false;
        agent.todos = agent.todos.map((t) => {
          if (t && typeof t === 'object' && typeof t.status === 'string' && ACTIVE.has(t.status.toLowerCase())) {
            changed = true;
            return { ...t, status: 'done' };
          }
          return t;
        });
        if (changed) {
          agent.updatedAt = now;
          db.prepare('UPDATE tasks SET agent_json = ? WHERE id = ?').run(JSON.stringify(agent), id);
        }
      }
    } catch {
      // a malformed agent block never blocks shipping
    }
  }
  appendEvent(db, id, actor, 'ship', { refs });
  return getTask(db, id);
}
