# Hook-driven Session State, Liveness & Control — Implementation Plan

> **For agentic workers:** implement task-by-task, TDD, commit per task. Steps use `- [ ]`.

**Goal:** Give the be10x board a reliable, hook-driven view of every VM-local agent session's state
(working / waiting / blocked / done / stalled) and phase, plus start/resume/create controls — surfaced in
the board API, the `be10x` CLI, and the web dashboard.

**Architecture:** be10x already spawns `claude -p --output-format stream-json` and parses it. Add
`--include-hook-events` so hook lifecycle events (SessionStart, PreToolUse, Notification, Stop, SubagentStop)
arrive inline. A pure module derives a phase-aware state snapshot from those events; `stalled` is derived
from heartbeat age at read time. Surface via `assembleFleetStatus` → `/api/ps` + `be10x ps` + web badges.
Session control reuses the captured `session_id` (`claude --resume`).

**Tech Stack:** Node 18+ (ESM), better-sqlite3, node:test, vanilla HTTP server, React (web/, Vite).

## Global Constraints
- Dependency-free core (node built-ins + existing src/* + better-sqlite3 only).
- All new pure logic in focused modules; TDD with `node --test`.
- `GFA_STATUS_STALE_MS` default 300000 (5 min).
- States: `working | blocked | waiting | done`; `stalled` is derived, never stored.
- Backward-compatible with the existing `tasks.agent_json` snapshot (preserve todos/changes).

---

## Phase 1 — Hook-event state derivation (backend core)

### Task 1: Pure state-derivation module `src/executor/agent-status.js`
**Files:** Create `src/executor/agent-status.js`; Test `test/agent-status.test.js`.
**Produces:** `hookEventToActivity(hookEvent, outcome)`, `deriveStatus(prev, ev, now)`,
`isStalled(snap, now, staleMs)`, `phaseFromMode(mode)`, `STALE_MS_DEFAULT`.

- [ ] Test: `hookEventToActivity('PreToolUse')==='working'`, `'Notification'==='waiting'`,
  `'Stop'==='done'`, `'SessionStart'==='working'`, `('PostToolUse', 'error'|deny)==='blocked'`, unknown→null.
- [ ] Test: `deriveStatus` — SessionStart sets sessionId+state working+stateStartedAt; a second working event
  bumps updatedAt but NOT stateStartedAt; Notification flips state→waiting and moves stateStartedAt; Stop→done.
- [ ] Test: `isStalled({state:'working',updatedAt:0}, 10*60000, 300000)===true`; done never stalls; fresh working false.
- [ ] Test: `phaseFromMode('plan')==='plan'`, `'execute'==='implement'`, `'verify'==='verify'`, default 'implement'.
- [ ] Implement; run `node --test test/agent-status.test.js`; commit.

### Task 2: Stream parser surfaces hook events + flag `src/executor/claude-adapter.js`
**Files:** Modify `src/executor/claude-adapter.js`; Test `test/claude-adapter-hooks.test.js`.
**Consumes:** existing `StreamAccumulator`/`push`. **Produces:** parsed event gains `hookEvent` (string|null);
`buildClaudeCommand` includes `--include-hook-events`.

- [ ] Test: `buildClaudeCommand({}).args` contains `--include-hook-events`.
- [ ] Test: pushing `{"type":"system","subtype":"hook_started","hook_event":"Notification","session_id":"s1"}`
  yields an event with `hookEvent:'Notification'` and `sessionId:'s1'`; a normal assistant line has `hookEvent:null`.
- [ ] Implement (parse `system`/`hook_started`, expose `hookEvent`; add flag); run tests; commit.

### Task 3: Wire executor + recordProgress to the state machine
**Files:** Modify `src/executor/executor.js` (`consume`), `src/worker/worker.js` (`recordProgress`);
Test `test/recordProgress-state.test.js`.
**Consumes:** Task 1 `deriveStatus`, Task 2 `hookEvent`. **Produces:** `recordProgress` accepts
`{state, phase, stateStartedAt}`, preserves todos/changes; executor updates the snapshot per hook event.

- [ ] Test: `recordProgress(db, t, {state:'waiting', phase:'plan'})` then a bare `{message}` keeps state/phase +
  todos; `stateStartedAt` set once and preserved while state unchanged.
- [ ] Test (executor, using fake spawn + recorded hook lines fixture): a Notification hook line drives
  `tasks.agent_json.state==='waiting'`; a Stop line → `'done'`.
- [ ] Implement; run tests + full `npm test`; commit.

---

## Phase 2 — Aggregation, API & resume

### Task 4: `assembleFleetStatus(db, {viewerId})` `src/tasks/fleet.js`
**Files:** Create `src/tasks/fleet.js`; Test `test/fleet.test.js`.
**Produces:** `assembleFleetStatus(db,{viewerId,staleMs})` → `[{taskId,humanId,title,phase,state,stalled,ageMs,
assignee,project}]` for non-terminal tasks the viewer can see (reuse `listTasksForUser`/authz).

- [ ] Test: a working task <staleMs old → `stalled:false`; an old working task → `stalled:true`; a done task
  excluded (or state 'done'); viewer who can't access a task doesn't see it.
- [ ] Implement; run tests; commit.

### Task 5: Status endpoints `src/http/server.js`
**Files:** Modify `src/http/server.js`; Test `test/http-status.test.js`.
**Produces:** `GET /api/ps` → `{sessions: assembleFleetStatus(...)}`; `GET /api/tasks/:id/status` → snapshot +
`{stalled, ageMs}`.

- [ ] Test: signup → create task → set agent_json working → `GET /api/ps` lists it with state; `GET
  /api/tasks/:id/status` returns snapshot+stalled; 401 without session.
- [ ] Implement; run tests; commit.

### Task 6: Resume wake + endpoint
**Files:** Modify `src/executor/wake.js` (accept reason 'resume'), `src/runner/runner.js`/`src/executor/executor.js`
(resume path uses run.sessionId → `--resume`), `src/http/server.js` (`POST /api/tasks/:id/resume`); Test
`test/task-resume.test.js`.
**Produces:** `POST /api/tasks/:id/resume` enqueues a `resume` wake carrying the latest run's sessionId.

- [ ] Test: a task with a prior run (sessionId set) → `POST .../resume` 200 + a pending wake reason 'resume';
  no prior session → 409 NO_SESSION.
- [ ] Test (executor): a resume wake builds a claude command with `--resume <sessionId>`.
- [ ] Implement; run tests + `npm test`; commit.

---

## Phase 3 — CLI

### Task 7: `be10x ps` + `be10x status <task>`
**Files:** Modify `bin/be10x.js`; add `src/cli/fleet-format.js` (pure table formatter); Test
`test/cli-fleet-format.test.js`.
**Produces:** `cmdPs` reads local db → `assembleFleetStatus` → table (TASK·PHASE·STATE·ASSIGNEE·PROJECT·AGE),
`--json` raw; `cmdStatus` prints one task's snapshot.

- [ ] Test: `formatFleetTable([{humanId:'T-1',phase:'implement',state:'working',stalled:false,ageMs:5000,...}])`
  contains `T-1`, `implement`, `working`, `5s`.
- [ ] Implement `cmdPs`/`cmdStatus` + formatter; wire into arg dispatch; manual run on prod db; commit.

### Task 8: `be10x resume|start|new`
**Files:** Modify `bin/be10x.js`; Test covered by Task 6 endpoints + a light dispatch test.
**Produces:** `cmdResume` (enqueue resume wake locally or POST to board), `cmdStart` (transition→ready_to_work),
`cmdNew` (create task, resolve project, optional --start).

- [ ] Implement against local db (GFA_DB_PATH) mirroring existing local commands; smoke-run on dev; commit.

---

## Phase 4 — Dashboard (web/) — make it 10x better

Apply the frontend-design skill. Focus: live session visibility + the missing task controls + project linking.

### Task 9: Session state on task cards + a Fleet view
**Files:** Modify `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/components/board/TaskCard.tsx`;
add `web/src/components/board/SessionStateBadge.tsx`, `web/src/components/fleet/FleetView.tsx`.
- [ ] Add `AgentStatus` fields to the task type + `getPs()` API call.
- [ ] `SessionStateBadge`: dot + label (working/waiting/blocked/done/stalled) + phase + relative age.
- [ ] Render the badge on `TaskCard`; add a Fleet page listing all active sessions from `/api/ps`.

### Task 10: Task assignee picker + Start/Resume + project-link visibility
**Files:** Modify task detail component(s), `web/src/lib/api.ts`; add an assignee picker (mirror the bug one),
Start/Resume buttons (call `/transition` + `/resume`), and show the task's project + team.
- [ ] Assignee dropdown of team members → `POST /api/tasks/:id/assign`.
- [ ] Start (→ready_to_work) + Resume buttons using the endpoints from Phase 2.
- [ ] Show linked project/team on the task detail.

### Task 11: Rebuild + verify
- [ ] `npm run --prefix web build`; confirm `public/` updated.
- [ ] `npm test` (full suite green); restart dev service; smoke the dashboard over the dev tunnel.
- [ ] Commit the rebuilt bundle.

---

## Self-review notes
- Spec coverage: state model (T1–3), liveness/stalled (T1,4), phase (T1), API (T5), ps/CLI (T7), resume/start/new
  (T6,8), web badges + controls (T9–10). ✓
- `waiting` also derivable from board input/review state — T4/T9 may layer that on the stored state; the stored
  `waiting` from Notification is the baseline.
- Fast-follows (remote connector forwarding, global hooks) intentionally excluded.
