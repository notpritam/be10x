# Hook-driven session state, liveness & control — design

**Date:** 2026-07-20
**Owner:** pritam@emergent.sh
**Status:** design (pending review)

## Problem

On the be10x board you cannot tell whether a task's agent is **working**, **waiting on a human**,
**stalled/dead**, or **done**. The plan phase already communicates *what* the agent will do; the missing
signal is *what state it is in right now*, and especially "is it still alive or stuck?" This is the #1
visibility gap. Secondary: no first-class way to **start / resume / create** a session from the board or CLI.

## Scope (decided)

- **VM-local runner first.** The on-VM baked runner (`be10x serve`) gets full state+liveness. Remote
  connectors keep reporting via the agent's `gfa_update_progress` for now (fast-follow below).
- **Bundle session control** (start / resume / create) into this feature.
- **be10x-spawned runs only.** Hooks/attribution are scoped to runs be10x launches (per-run, task-attributed).
  Global "adopt any manually-started claude session" is a fast-follow.
- **States:** `working | blocked | waiting | done` plus a derived `stalled`.

## Mechanism — hook events via the stream, NOT `~/.claude` hooks

be10x already spawns claude headless with `-p --verbose --output-format stream-json` and parses the stream.
Claude Code's `--include-hook-events` flag streams **all hook lifecycle events inline** — no configured
hooks, no settings mutation, no loopback HTTP server (this is where we diverge from Orca, which needs a
loopback server because it runs claude in an unparsed PTY). Verified empirically 2026-07-20; each event is:

```json
{"type":"system","subtype":"hook_started","hook_event":"SessionStart",
 "hook_name":"SessionStart:startup","hook_id":"…","session_id":"…","uuid":"…"}
```
(with a matching `hook_response` carrying `outcome`/`exit_code`). `hook_event` ∈ {SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, …}, and `session_id` is on
every line.

**Change:** add `--include-hook-events` to `buildClaudeCommand` (`src/executor/claude-adapter.js`); teach the
stream parser to surface these lifecycle events; derive state from them.

## State model

Board state = **task phase × agent activity**. be10x already tracks the phase (research → plan → implement
→ verify → ship). Agent activity is derived from hook events:

| Signal | Activity state |
|---|---|
| `SessionStart` | session begins; capture `session_id` |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `working` (these double as the **heartbeat**) |
| `Notification` **or** an open board input-request / review gate | `waiting` (needs a human) |
| a tool `hook_response` with a permission-deny / error `outcome`, or run failure | `blocked` |
| `Stop` / stream `result` | `done` (turn ended) |
| state=`working` but no event for > `GFA_STATUS_STALE_MS` | **`stalled`** (derived at read time) |

`stalled` is the core fix for "is it stuck?": it's not stored, it's derived from heartbeat age (default
`GFA_STATUS_STALE_MS = 300000`, 5 min). No server-side scheduler — computed when the snapshot is read.
`waiting` is derived from BOTH the `Notification` hook and the board's own open-input/review state, so it's
robust even when claude emits no Notification (the common bypassPermissions case).

The board badge reads: **"Implementing · working · 30s ago"**, **"Plan · waiting for you"**,
**"Implementing · stalled · 12m no signal"**, **"Verify · done"**.

## Data model — `AgentStatus` snapshot (`tasks.agent_json`, extended)

Extend the existing snapshot (backward-compatible; existing fields preserved):

```
state:          'working' | 'blocked' | 'waiting' | 'done'
phase:          'research' | 'plan' | 'implement' | 'verify' | 'ship'   (mirrors task flow)
message:        last assistant text (truncated)          ← existing
todos, changes: preserved                                ← existing
updatedAt:      ms (last heartbeat/event)                ← existing
stateStartedAt: ms (when the CURRENT state began; NOT reset by heartbeats)
lastEvent:      last hook_event name (e.g. 'PreToolUse')  — coarse, for debugging
runId, sessionId
```
`stale`/`stalled` and the age are computed at read time, not stored.

## Derivation module — `src/executor/agent-status.js` (pure, unit-tested)

- `hookEventToActivity(hookEvent, outcome)` → `working|waiting|blocked|done|null`.
- `deriveStatus(prev, {hookEvent, text, sessionId, outcome, now})` → next snapshot fields; `stateStartedAt`
  changes only when `state` changes; `updatedAt` bumps on every event.
- `isStalled(snapshot, now, staleMs)` → bool.
- `phaseFromMode(mode)` → maps the executor run mode (plan/execute/verify) to a phase label.

The executor's existing `consume(line)` loop and `recordProgress` call into this; `recordProgress`
(`src/worker/worker.js`) is extended to carry `state`/`phase`/`stateStartedAt` while keeping its
todos/changes-preservation. `executor.js` barely grows.

## Session control — start / resume / create

Uses the `session_id` captured from `SessionStart` (already stored on the `runs` row; resume records exist).

- **start** `be10x start <task>` / board "Start": move the task to `ready_to_work` and enqueue an `execute`
  wake → the runner launches a fresh session. (Assignee-routing still applies.)
- **resume** `be10x resume <task>` / board "Resume": relaunch `claude --resume <session_id>` in the task's
  worktree via the runner (a new wake with reason `resume` carrying the run's `sessionId`). Distinct from
  the existing retry path in that it continues the *same* provider session.
- **create** `be10x new [--project <key>] [--title …] [--start]` / board "New task": create a task (must
  resolve a project — mirrors the pick-project rule), optionally start it immediately.

CLI commands emit the uniform result; board actions are thin POSTs to existing/new endpoints
(`/api/tasks/:id/transition` already backs start; add `/api/tasks/:id/resume`).

## Surfaces

1. **Board API:**
   - `GET /api/tasks/:id/status` → the snapshot + derived `{stalled, ageMs}`.
   - `GET /api/ps` → fleet view (session-authed, viewer-scoped): `[{taskId, humanId, title, phase, state,
     stalled, ageMs, assignee, project}]`, backed by a shared `assembleFleetStatus(db, {viewerId})`.
   - `POST /api/tasks/:id/resume` → enqueue a resume wake.
2. **CLI:** `be10x ps [--json]` (docker-ps-style table: TASK · PHASE · STATE · ASSIGNEE · PROJECT · AGE),
   `be10x status <task>`, `be10x start|resume|new`. Reads the local board db on the VM (mirrors existing
   local CLI commands); `--json` everywhere.
3. **Web:** task cards show a state dot (working/waiting/blocked/done/stalled) + phase + age, from the
   extended task payload. Requires a dashboard rebuild.

## Testing (TDD)

- **Pure module** (`agent-status.js`): `hookEventToActivity` mapping; `deriveStatus` transitions
  (SessionStart→captures id; PreToolUse→working + heartbeat; Notification→waiting; Stop→done; error→blocked;
  `stateStartedAt` only changes on state change); `isStalled` at the threshold; `phaseFromMode`.
- **Stream parse** (`claude-adapter.js`): a `hook_started` line yields a `{hookEvent, sessionId}` event;
  non-hook lines unaffected; `--include-hook-events` present in `buildClaudeCommand`.
- **`recordProgress`**: preserves todos/changes; sets `phase`/`state`/`stateStartedAt` correctly.
- **`assembleFleetStatus`**: returns active tasks, viewer-scoped, with derived `stalled`.
- **API**: `GET /api/ps`, `GET /api/tasks/:id/status`, `POST /api/tasks/:id/resume`.
- **CLI**: `be10x ps` render (table + `--json`); resume enqueues the right wake.
- Fixtures use recorded stream-json hook lines (captured 2026-07-20) so tests are deterministic offline.

## Fast-follows (explicitly out of scope now)

- **Remote-connector status forwarding**: the connector parses its own stream and POSTs the same snapshot to
  the board, so teammates' remote runs get automatic state (not only agent-self-reported). The board
  contract (`assembleFleetStatus`, the snapshot shape) is designed so this is purely an additional writer.
- **Global/adopted-session hooks**: install `~/.claude` hooks so a manually-started `claude` in a linked
  repo reports to the board (needs cwd→task mapping + unattributed-session handling).
- **Web "Resume" one-click** polish and richer per-session detail view.

## Out-of-scope non-goals

- Per-tool real-time readout ("Editing src/auth.ts") — the plan already conveys intent; we track state, not
  keystrokes. (`lastEvent` is coarse, for debugging only.)
- Changing the task lifecycle/phase model itself.
