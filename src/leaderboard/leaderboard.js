// ABOUTME: Public leaderboard rankings — tasks completed and token usage through be10x, either
// ABOUTME: platform-wide or scoped to one team. See docs/superpowers/specs/2026-07-03-admin-dashboard-leaderboard-design.md
// for why this is always-on platform data rather than gated behind the opt-in CLI telemetry flag.
import { usageTotalsSql } from '../executor/runs.js';

// Ranked by tasks completed (the primary "how much have you shipped through be10x" signal), then
// total tokens as a tiebreaker. `teamId` scopes to that team's members only; omitted, it's every
// user on the platform. Callers are responsible for authorizing a team-scoped request (see the
// GET /api/leaderboard route) — this function itself trusts whatever teamId it's given.
//
// `sinceMs` scopes to a period (e.g. "this month") instead of all-time: a task counts toward
// tasksDone only if it's done AND its updated_at (the schema has no dedicated completed_at, so
// this is the best proxy for "when it finished") falls on/after sinceMs; a run's usage counts
// only if the run itself started on/after sinceMs. The time condition lives in the LEFT JOIN's ON
// clause, not a WHERE — that way a user with zero activity in the period still gets a row (with
// zeros) instead of disappearing from the ranking entirely.
export function leaderboard(db, { teamId = null, sinceMs = null } = {}) {
  const taskDoneCond = sinceMs ? "t.status = 'done' AND t.updated_at >= @sinceMs" : "t.status = 'done'";
  const runJoinCond = sinceMs ? 'r.task_id = t.id AND r.created_at >= @sinceMs' : 'r.task_id = t.id';
  const sql = `
    SELECT u.id, u.email, u.display_name AS displayName,
      COUNT(DISTINCT CASE WHEN ${taskDoneCond} THEN t.id END) AS tasksDone,
      ${usageTotalsSql('r')}
    FROM users u
    ${teamId ? 'JOIN memberships m ON m.user_id = u.id AND m.team_id = @teamId' : ''}
    LEFT JOIN tasks t ON t.owner_id = u.id
    LEFT JOIN runs r ON ${runJoinCond}
    GROUP BY u.id
    ORDER BY tasksDone DESC, inputTokens DESC, u.created_at ASC
  `;
  const params = {};
  if (teamId) params.teamId = teamId;
  if (sinceMs) params.sinceMs = sinceMs;
  return db.prepare(sql).all(params);
}

// The start of the current calendar month, in local server time — the cutoff a "this month"
// period leaderboard uses.
export function startOfCurrentMonthMs(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}
