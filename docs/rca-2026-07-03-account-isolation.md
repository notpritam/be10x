# RCA — cross-account data leak & connector crash-loop

Date: 2026-07-03
Reported by: notpritamm (second account on a second laptop saw the first account's data; `be10x connect` stuck retrying)
Severity: Critical — live cross-account data exposure (read + write) on a publicly deployed board (be10x.notpritam.in)

---

## Issue 1 — Any authenticated account can read and modify any task

**Symptom:** A second account showed every task the first account had created, including personal ones.

**Root cause:** `GET /api/tasks` (`src/http/server.js:219-222`) forwards only client-supplied query params into `listTasks()` — it never derives a filter from the requesting session. The frontend calls it with no filter at all (`web/src/state/app-store.tsx` `reloadTasks`), so every browser downloads every task in the database; the sidebar's "Personal"/team views then filter that firehose **client-side by `scope`/`teamId` only**, never by "is this mine." Every single-task route (`transition`, `plan`, `research`, `content`, `retry`, `review/*`, `comments`, `share`, `hand-to-agent`, `pick-up-now`) has the same gap: none of them check that the caller owns the task or belongs to its team.

This is a wiring gap, not a fresh regression. `src/authz/authz.js` already has a correct, unit-tested primitive (`assertCan`, role-ranked owner>admin>member>viewer, with `task.read`/`task.create`/`task.update` actions already defined) and it's correctly used for the team-membership routes (`/api/teams/:id/members`). It was never called from any task route. The project's own v1 design doc states the intended rule outright (`docs/superpowers/specs/2026-07-01-git-for-agents-v1-design.md:121`): *"personal tasks are private to their owner; project/team tasks are visible to team members... every core mutation checks (actor, task scope, team role)"* — that line was never implemented.

**Evidence:**
- `src/http/server.js:219` — `GET /api/tasks` ignores `user` entirely.
- `src/tasks/tasks.js:60-69` — `listTasks()` has an `ownerId` filter parameter that nothing ever supplies.
- `test/authz.test.js` — proves `can()`/`assertCan()` correctly deny cross-team reads *in isolation*, but no test exercises this through an actual task HTTP route (the gap was untested at the integration layer).

**Impact:** Any signed-up user (any account, first-party or self-registered) can list, read, and mutate every task on the board — personal or team, theirs or not.

**Fix:** Scope `GET /api/tasks` server-side to (owned personal tasks) ∪ (tasks on teams the caller belongs to); `assertCan`-gate every single-task route on the task's actual scope before acting.

---

## Issue 2 — Linked repos ("projects") have no owner/team identity, causing cross-account visibility and a connector crash-loop

**Symptom A:** "I am able to see projects of everyone" — every registered repo is visible to every user.
**Symptom B:** A second account on a second laptop, fully connected (`be10x connect`), sits in an infinite claim/retry loop and never runs work.

**Root cause:** The `projects` table (`src/db/schema.sql`) has no `team_id`/`owner_id` column at all, even though the v1 design doc calls for `projects.team_id (nullable for personal)`. `GET /api/projects` returns every row unconditionally. Worse, `registerProject()` (`src/projects/projects.js:68-76`) is idempotent **by `key` alone, globally** — and `key` falls back to `'local:' + slugify(folder name)` when a repo has no git remote (`detectProjectKey`, `src/projects/projects.js:44-51`). Two different accounts on two different laptops whose checkout folders share a name (e.g. both named `git-for-agents` — the exact scenario here, since this project is being dogfooded on itself) resolve to the **identical** project key and silently collide onto one shared row.

Once collided, `claimNextWakeForKeys()` (`src/executor/wake.js:73-92`) — what `be10x connect` calls every ~3s — matches wakes to a connector purely by `project.key IN (...)`, with no owner/team check. The second laptop's connector can be handed wakes for tasks whose local checkout it doesn't actually have (or that belong to the other account entirely). `runConnectOnce` (`src/connect/connect.js:90-117`) then reports `failureKind: 'crash'` ("connector has no local checkout for X") and the loop (`connectLoop`, 3s interval) tries again forever — this is the "going, going, retry, retry, retry" behavior, and it's driven by the same missing-identity root cause as Symptom A, not a separate bug.

**Evidence:**
- `src/db/schema.sql` — `projects` table: no `team_id`/`owner_id` column.
- `docs/superpowers/specs/2026-07-01-git-for-agents-v1-design.md:93` — spec called for `team_id (nullable for personal)` on `projects`; never implemented (confirmed via `git log --oneline -p -- src/db/schema.sql`, commit `64b261d`).
- `src/http/server.js:223` — `GET /api/projects` has no scoping.
- `src/executor/wake.js:80` — claim join has no owner/team predicate.

**Impact:** Every repo linked by anyone is visible to everyone platform-wide; distinct accounts' connectors can collide onto the same project identity and permanently crash-loop instead of doing work.

**Fix:** Add `owner_id` + `team_id` (nullable) to `projects`; scope project identity/uniqueness per (key, team) or (key, owner) instead of per key alone; scope `GET /api/projects` and the claim/registration paths accordingly.

---

## Issue 3 — Sidebar navigation doesn't leave an open task tab

**Symptom:** With a task tab open, clicking a different view in the sidebar (e.g. "Personal") changes the label but keeps showing the open task instead of that view's board, and the sidebar/tab-bar highlight doesn't move.

**Root cause:** `Sidebar.tsx`'s nav `onClick` handlers call `setView(...)` only. `AppShell.tsx` renders the open task (`DeepDivePanel`) whenever `selectedTaskId` is non-null, regardless of `view` — nothing about a sidebar click clears `selectedTaskId`, so the shell keeps showing the old task. `TabBar.tsx`'s context button only reads as active when `selectedTaskId === null` (`onBoard`), so the highlight doesn't move either. Pure state-transition omission — no bug in the render logic itself.

**Evidence:** `web/src/components/shell/Sidebar.tsx:105-179` (every `setView` call site); `web/src/state/app-store.tsx` (`setView` never touches `selectedTaskId`).

**Impact:** Confusing navigation; cosmetic/UX only, no data exposure.

**Fix:** Sidebar (and other view-changing) navigation should also deselect the open task so the shell falls back to that view's board.

---

## Status

| # | Issue | Status |
|---|-------|--------|
| 1 | Task read/write authorization | Fixed — every task route now calls `assertCanAccessTask` (owner, team role, or tagged reviewer for reads); `GET /api/tasks` scoped via `listTasksForUser`; same checks applied in the MCP tool layer. |
| 2 | Project identity/visibility + connector collision | Fixed — `projects` gained `owner_id`/`team_id` (self-healing migration, backfilled from task history), identity scoped per (key, team) or (key, owner); `claimNextWakeForKeys` scoped by the calling token's user. |
| 3 | Sidebar nav doesn't clear open tab | Fixed — `setView` now deselects the open task; verified live in a browser. |

Verified: 286 backend tests pass (`node --test test/*.test.js`), frontend typecheck and production build pass, and the exact reported repro (second account seeing/reaching the first account's task) was re-run live against a built server and confirmed fixed.
