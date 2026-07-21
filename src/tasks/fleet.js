// ABOUTME: assembleFleetStatus — the board's "what is every agent doing right now" view. Collects the
// ABOUTME: in-flight tasks a viewer can see and attaches each one's live agent state + derived stalled flag.
import { listTasksForUser } from './tasks.js';
import { isStalled, STALE_MS_DEFAULT } from '../executor/agent-status.js';
import { getProject } from '../projects/projects.js';
import { getUserById } from '../auth/users.js';

// Statuses that represent work in flight (a running or human-gated session). Terminal/backlog states are
// excluded — the fleet view is about what's live, not the whole board.
const ACTIVE = new Set(['researching', 'ready_to_work', 'in_progress', 'verifying', 'plan_review']);

// When there's no agent snapshot yet, NOTHING is actually running — so never infer "working" (that was a
// false green: a task with pending, unclaimed wakes and no project looked like it was working). It's
// waiting: 'waiting' for a human at plan_review, else 'queued' (waiting for a runner to claim it).
function statusToState(status) {
  if (status === 'plan_review') return 'waiting';
  return 'queued';
}

export function assembleFleetStatus(db, { viewerId, staleMs = STALE_MS_DEFAULT, now = Date.now() } = {}) {
  const tasks = listTasksForUser(db, viewerId);
  const out = [];
  for (const t of tasks) {
    if (!ACTIVE.has(t.status)) continue;
    const agent = t.agent || {};
    const state = agent.state || statusToState(t.status);
    const hasSnap = agent.updatedAt != null;
    const project = t.projectId ? getProject(db, t.projectId) : null;
    const assignee = t.assigneeId ? getUserById(db, t.assigneeId) : null;
    out.push({
      taskId: t.id,
      humanId: t.humanId,
      title: t.title,
      status: t.status,
      phase: agent.phase || null,
      state,
      // A task with no snapshot yet (just queued/starting) is "unknown", not stalled.
      stalled: hasSnap ? isStalled({ state, updatedAt: agent.updatedAt }, now, staleMs) : false,
      ageMs: hasSnap ? now - agent.updatedAt : null,
      updatedAt: agent.updatedAt || null,
      message: agent.message || null,
      assignee: assignee ? { id: assignee.id, email: assignee.email, displayName: assignee.displayName } : null,
      project: project ? { id: project.id, key: project.key, name: project.name } : null,
    });
  }
  out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)); // most recently active first
  return out;
}
