// ABOUTME: The task engine — typed tasks over SQLite. Every mutation validates, updates the row,
// ABOUTME: bumps updated_at, and appends a task_events row. Pure core; no HTTP/MCP.
import { randomUUID } from 'node:crypto';
import { getType, validateContent } from './types.js';
import { assertTransition } from './lifecycle.js';
import { appendEvent } from './events.js';
import { recordPlanVersion } from '../plans/versions.js';
import { listProjectsForUser } from '../projects/projects.js';
import { listRunWorktrees } from '../executor/runs.js';

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

// Resolve a user-facing task reference to its internal uuid: accept the uuid itself, or the GFA-123 human id
// people actually see and type (case-insensitively, and zero-padded so `gfa-1` matches `GFA-001`). Returns
// the uuid or null. Lets the CLI (`be10x archive GFA-1`) and the connector-facing agent archive route take a
// friendly id without every caller re-implementing the lookup. Read-only.
export function resolveTaskId(db, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(s)) return s;
  const up = s.toUpperCase();
  const m = /^GFA-(\d+)$/.exec(up);
  const candidates = m ? [up, 'GFA-' + m[1].padStart(3, '0')] : [up];
  for (const c of candidates) {
    const row = db.prepare('SELECT id FROM tasks WHERE human_id = ?').get(c);
    if (row) return row.id;
  }
  return null;
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

// The authorization-scoped counterpart HTTP callers must use instead of listTasks: every row returned is
// one userId can actually see — owned personally, tagging them as reviewer (reviewers are picked by
// platform-wide search, not just teammates — see authz.js canAccessTask), on a team they belong to, or
// filed under a project they can access (see projects.js listProjectsForUser — includes pre-scoping legacy
// projects). scope/teamId/status further NARROW that visible set; they can never widen it, so a
// caller-supplied teamId for a team the user isn't in just yields zero rows instead of leaking anything
// (see RCA issue 1).
export function listTasksForUser(db, userId, { scope, teamId, status } = {}) {
  const myTeamIds = db.prepare('SELECT team_id FROM memberships WHERE user_id = ?').all(userId).map((r) => r.team_id);
  const visibleProjectIds = listProjectsForUser(db, userId).map((p) => p.id);

  const visible = ['owner_id = @userId', 'reviewer_id = @userId'];
  const args = { userId };
  if (myTeamIds.length) {
    visible.push(`team_id IN (${myTeamIds.map((_, i) => '@myTeam' + i).join(',')})`);
    myTeamIds.forEach((id, i) => (args['myTeam' + i] = id));
  }
  if (visibleProjectIds.length) {
    visible.push(`project_id IN (${visibleProjectIds.map((_, i) => '@proj' + i).join(',')})`);
    visibleProjectIds.forEach((id, i) => (args['proj' + i] = id));
  }

  const where = ['(' + visible.join(' OR ') + ')'];
  if (scope) { where.push('scope = @scope'); args.scope = scope; }
  if (teamId) { where.push('team_id = @teamId'); args.teamId = teamId; }
  if (status) { where.push('status = @status'); args.status = status; }

  const sql = 'SELECT * FROM tasks WHERE ' + where.join(' AND ') + ' ORDER BY created_at';
  return db.prepare(sql).all(args).map(hydrate);
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

// Soft-archive a task from ANY stage: flip its status to 'archived' and append an 'archived' event. The row
// is deliberately KEPT (never hard-deleted) so bug links and the full history survive; only the git
// worktree/branch on disk get reclaimed, and that happens separately (gcTaskWorktrees, driven by the
// returned `worktrees`) where those checkouts actually live. Returns { task, worktrees } — worktrees being
// the DISTINCT real paths+branches recorded across the task's runs. Idempotent: re-archiving an
// already-archived task is a no-op success (no second event) that still reports its worktrees so a retried
// GC keeps its targets. Throws NO_TASK for an unknown id.
// Assign / unassign a task to a teammate (assigneeId null clears it). Drives strict assignee-routing: once
// assigned, only the assignee's worker claims the task's wakes (see executor/wake.js). Throws NO_TASK.
export function setTaskAssignee(db, id, assigneeId, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?').run(assigneeId ?? null, Date.now(), id);
  appendEvent(db, id, actor, 'assign', { from: task.assigneeId ?? null, to: assigneeId ?? null });
  return getTask(db, id);
}

export function archiveTask(db, id, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const worktrees = listRunWorktrees(db, id);
  if (task.status === 'archived') return { task, worktrees };
  assertTransition(task.status, 'archived');
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('archived', Date.now(), id);
  appendEvent(db, id, actor, 'archived', { from: task.status });
  return { task: getTask(db, id), worktrees };
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

// The phases an external/CLI ("trajectory") session can be in when it's adopted onto the board, and the
// lifecycle path to walk a fresh backlog task to each. 'idea' just lands in the backlog; later phases mean
// the session already has more (research, a plan, work in flight) so we attach it and advance the task.
const IMPORT_PHASE_PATH = {
  idea: [],
  backlog: [],
  researching: ['researching'],
  plan_review: ['researching', 'plan_review'],
  ready: ['ready_to_work'],
  in_progress: ['ready_to_work', 'in_progress'],
};
export const IMPORT_PHASES = ['idea', 'researching', 'plan_review', 'ready', 'in_progress'];

// If the human wants the board to CONTINUE the adopted work (handoff), the wake reason that matches the
// phase. plan_review returns null: a plan awaiting review is the human's turn, so we never auto-wake there.
export function handoffReasonForPhase(phase) {
  switch (phase) {
    case 'ready':
      return 'execute';
    case 'in_progress':
      return 'pick_up_now';
    case 'plan_review':
      return null;
    default:
      return 'plan'; // idea | researching | backlog | unknown → (re)start planning
  }
}

// Adopt an in-flight session (typically a terminal/CLI Claude run) onto the board as ONE task, filed in a
// project at the phase it's actually in. Creates the task, attaches whatever the session already produced
// (summary/symptom content, research, plan, artifacts, output refs), and walks the lifecycle to the target
// phase. This is the counterpart to "sessions disposable, state durable": one call turns loose terminal
// work into a durable, board-controllable task. Content is shaped for the type so createTask's validation
// passes; a missing required field falls back to the title.
export function importTask(db, spec = {}, actor) {
  const {
    title,
    type = 'general',
    projectId = null,
    teamId = null,
    severity = 'medium',
    summary = null,
    symptom = null,
    content = {},
    research = null,
    plan = null,
    artifacts = null,
    refs = null,
    phase = 'idea',
    source = 'cli-adopt',
  } = spec;
  if (!title || typeof title !== 'string') throw new Error('MISSING_FIELD:title');

  const scope = spec.scope || (projectId ? 'project' : teamId ? 'team' : 'personal');
  // Shape the type's required content field; any extra fields passed in `content` are preserved.
  const base = { ...(content && typeof content === 'object' ? content : {}) };
  if (type === 'code-issue') base.symptom = base.symptom ?? symptom ?? summary ?? title;
  else base.summary = base.summary ?? summary ?? title;

  const created = createTask(db, { type, scope, title, ownerId: actor, content: base, teamId, projectId, severity });
  const id = created.id;
  appendEvent(db, id, actor, 'imported', { source, phase });

  // Attach whatever the session already has — each is optional and independently useful.
  if (research != null) setResearch(db, id, research, actor);
  if (plan != null) setPlan(db, id, plan, actor);
  if (Array.isArray(artifacts)) for (const a of artifacts) postArtifact(db, id, a, actor);
  if (refs != null) setRefs(db, id, refs, actor);

  // Walk to the target phase. plan_review needs a plan to review; without one, stop at researching.
  let path = IMPORT_PHASE_PATH[phase] ?? [];
  if (phase === 'plan_review' && plan == null) path = ['researching'];
  for (const to of path) transition(db, id, to, actor);

  return getTask(db, id);
}

export function setRefs(db, id, refs, actor) {
  // Guard existence up front: a bad/missing id used to fall through to appendEvent and surface as a
  // cryptic "NOT NULL constraint failed: task_events.task_id" (the gfa_submit_output failure).
  if (!getTask(db, id)) throw new Error('NO_TASK');
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
