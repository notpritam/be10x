# Admin dashboard, token-usage capture, and a public leaderboard — design

Date: 2026-07-03
Status: approved, implementing

## Why

Three related asks, decomposed together because (2) produces the data (1) and (3) both consume:

1. An admin dashboard to see/debug platform state in depth (user counts, activity, per-user task
   completion) — extends the `GFA_ADMIN_TOKEN`-gated pattern already shipped for the telemetry
   viewer.
2. Capture token usage per agent run, through be10x specifically.
3. A public leaderboard ranking users by tasks completed and token usage.

## Decisions

- **Leaderboard consent**: NOT tied to the opt-in CLI telemetry flag. Task-completion counts and
  token usage *through be10x* are treated as platform usage data (like a GitHub contribution
  graph), shown for every account by default — no toggle, no opt-out. This is a deliberately
  different category from the opt-in telemetry, which can carry actual task/plan *content*;
  the leaderboard only ever shows counts.
- **Leaderboard scope**: one global ranking, with a scope filter (Everyone, or one of the
  viewer's teams).
- **Admin auth**: reuses the existing `GFA_ADMIN_TOKEN` bearer secret — no new "admin user"
  role/column on `users`. The dashboard page prompts for the token once, keeps it in
  `sessionStorage`, sends it as a header to `/api/admin/*`.
- **Usage attribution**: credited to the task's **owner**, not whichever machine/connector
  happened to execute it.
- **Explicitly out of scope**: total/"overall" Claude usage outside of be10x-orchestrated runs.
  be10x has no visibility into a user's unrelated `claude` sessions; this tracks tokens **through
  be10x** only.

## 1. Data model

Additive columns on the existing `runs` table (one row per agent execution already), via the
same self-healing `COLUMN_MIGRATIONS` pattern already used for `runs.executor`/`runs.model`:

```
runs.input_tokens            INTEGER
runs.output_tokens           INTEGER
runs.cache_creation_tokens   INTEGER
runs.cache_read_tokens       INTEGER
runs.cost_usd                REAL
```

No new table. Aggregation (per-user totals, leaderboard ranking) is computed with `SUM()`/`JOIN`
queries against `runs` + `tasks` at read time — this app's task/run volume doesn't need a
precomputed rollup table yet.

## 2. Capture point

`src/executor/claude-adapter.js`'s `parseStreamLine`/`StreamAccumulator` already receives Claude
Code's `type: "result"` stream event (which carries a `usage` object — input/output/cache token
counts — and `total_cost_usd`) into `acc.result`, but nothing downstream reads it. Extract those
fields where `acc.result` is consumed:

- `src/executor/executor.js` (local `work` runner) and `src/connect/remote-executor.js` (remote
  `connect` runner) both build a `summary` object from `acc`/the executor's return value — add the
  extracted usage fields there.
- `POST /api/agent/report` (already receives `summary` from a connector) and the local runner's
  equivalent finish-path both call `finishRun` — extend it to persist the new columns.
- Fields absent or malformed (a stream that never reached `result`, an unexpected shape) leave the
  columns `NULL` — never blocks or fails a run over missing usage data.

## 3. Admin dashboard

New endpoints, gated by the existing `validAdminToken` check (same 404-on-any-auth-failure
posture as the telemetry viewer):

- `GET /api/admin/overview` — total user count, active users (created/updated a task in the last
  7 days), total tasks, total tokens/cost through be10x.
- `GET /api/admin/users?q=&limit=` — searchable user list: id, email, display name, join date,
  task counts by status, total tokens/cost.
- `GET /api/admin/users/:id` — one user's full detail (their tasks, per-task usage).

New web page (`/admin`, client-side route, not part of the marketing site) prompting for the
admin token on first visit, storing it in `sessionStorage`, attaching it as a bearer header to
the above. A wrong/missing token gets the same 404 the API already returns — the page doesn't
distinguish "wrong token" from "no such page" for an unauthenticated visitor.

## 4. Public leaderboard

- `GET /api/leaderboard?scope=all|team:<teamId>` — no auth (this is the always-on platform data
  per the consent decision above). Returns users ranked by tasks completed (status = `done`) and
  total tokens through be10x, for the requested scope. `team:<id>` requires the CALLER to supply
  their own session (so team-scoped rankings don't leak a team's roster to an outsider who
  guesses a team id) — `scope=all` needs no session.
- New in-app page (behind login, not the public marketing site) with a scope dropdown and a
  ranked table.

## Testing

Unit coverage for: usage extraction from a `result` stream event (present, absent, malformed),
`finishRun` persisting the new columns, the admin overview/user-list/user-detail endpoints
(auth-gated the same way as the telemetry viewer, correct aggregation), and the leaderboard
endpoint (global vs. team scope, ranking order, a team scope requires a session and only exposes
that team's own members).
