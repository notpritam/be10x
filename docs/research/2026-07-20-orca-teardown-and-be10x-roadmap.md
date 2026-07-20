# Orca teardown → be10x roadmap (2026-07-20)

Deep extraction of **Orca** (`stablyai/orca`, cloned at `~/personal/reference/orca`) — an Electron
desktop orchestrator that runs Claude Code / Codex / etc. side-by-side in isolated git worktrees, with a
CLI, a mobile companion, SSH remote worktrees, and GitHub/Linear task integration. Analyzed across four
dimensions (CLI, session lifecycle & visibility, relay/remote-control, data-model & Claude-Code
integration) to extract patterns for **be10x** (team task board + per-teammate connectors running `claude`).

## The one insight that reframes be10x

Orca's whole architecture is **one JSON-RPC method surface, exposed over many transports, with all state
living in the durable runtime and every client (CLI, web, phone) a thin, scoped RPC client.**

- The `orca` CLI has **no business logic** — it's an RPC shim to the running app over a local Unix socket.
- The phone is the *same* client over an E2EE WebSocket/relay. Same methods, different-scoped token.
- Agent status is **never scraped from the terminal** — agents POST structured hook events to a loopback
  server (`working|blocked|waiting|done` + current tool + last message + session_id).

be10x's board is already the durable server. The move is: **make the connector expose one RPC surface, and
make both the be10x CLI and the board thin clients of it** — then visibility, remote steer, and CLI control
all fall out of the same pipe. This directly serves the vision: *team in one place, agents on their
machines, board is the control plane, controllable from the CLI.*

---

## The #1 gap: live session visibility — and how Orca solves it

be10x today has poor insight into a running session. Orca's answer, portable as-is to our connector:

**Hook-driven status, not terminal scraping.** Orca writes managed hooks into `~/.claude/settings.json`
for `UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreToolUse, PostToolUse, PermissionRequest,
Notification` that `curl` the raw payload to a loopback HTTP server. From that stream it derives:

- A **flat 4-state machine**: `working | blocked | waiting | done` (`blocked`/`waiting` = needs a human).
  The single highest-value signal on a shared board is *which* session is stuck waiting vs. genuinely working.
- **Live detail**: current `toolName`+`toolInput` ("Edit src/auth.ts"), `lastAssistantMessage` preview, the
  full `interactivePrompt` (AskUserQuestion) as a clickable approval card, and **subagents** as child rows.
  Every field is length-bounded (tool input ~160 chars, message ~8KB, ≤32 subagents) against runaway bloat.
- **Freshness decay**: `stale_after = 30min` + `stateStartedAt` separate from `updatedAt` (so tool pings
  don't reset the clock). A "working" row silently decays to "unknown" if the hook stream goes quiet — so a
  crashed connector never shows "working" forever.
- **The session_id for resume** rides in the same hook payloads (plus the authoritative `transcript_path`,
  which recent Claude Code names with a UUID ≠ the hook session_id).

Four **separate** status layers, deliberately not conflated (learn this): (1) live agent status, (2) derived
worktree dot, (3) user-facing kanban column, (4) orchestration status.

---

## Prioritized roadmap for be10x

### P0 — Backbone (do first; unlocks everything else)

**1. Hook-driven agent status pipeline.**
Install Claude Code hooks in the connector's `~/.claude/settings.json` that POST `{taskId, event, tool,
toolInput, state, sessionId, lastMessage}` to a loopback endpoint on the connector; connector forwards to
the board. Store a per-task `AgentStatus` row; render a board badge. *This is the single change that turns
be10x from "did it finish?" into a live control plane.*
Orca refs: `src/main/claude/hook-settings.ts`, `src/relay/agent-hook-server.ts`, `src/shared/agent-status-types.ts`.

**2. Capture `session_id` → resume.**
From the same hook stream, persist Claude's `session_id` + `transcript_path` on the task. "Continue after
review" = relaunch `claude --resume <session_id>` in the same worktree. (Store the provider id explicitly —
it is *not* our task id.) Orca ref: `src/shared/agent-session-resume.ts` (`getAgentResumeArgv`).

**3. Pick-project(+repo)-before-start — the composer.**
User called this out as core: a task can't start until you choose *where* it runs. Orca's composer enforces
field order **project (required, first) → host/repo → base branch → agent**, blocking submit until a repo
resolves. Then **one backend call** creates the worktree + launches the agent + seeds the prompt:
`git worktree add --no-track -b <branch> <path> <base>`, set `push.autoSetupRemote=true`, launch `claude`
in that dir. Orca refs: `NewWorkspaceComposerCard.tsx`, `useComposerState.ts`, `src/main/git/worktree.ts:895`.

### P1 — Make it controllable (the "control from be10x CLI itself" vision)

**4. CLI becomes a thin, transport-agnostic board client with a uniform `--json` envelope.**
Every command emits `{ok, result|error, _meta}`; errors are JSON too; add `be10x agent-context --json`
(self-describing schema) so the `claude` sessions we spawn can drive `be10x` without guessing. Data-driven
spec registry feeds dispatch + help + validation + schema from one table. Orca refs: `src/cli/specs/*`,
`src/cli/agent-context.ts`, `src/cli/format.ts`.

**5. `be10x ps` — fleet status in one glance.**
`docker ps` for the board: task → assignee → connector → session state → column, `--json` for scripts.
Beats opening the web UI when many teammates × tasks are live. Orca ref: `orca worktree ps`.

**6. Cursor-tailing + blocking wait.**
`be10x logs --task <id> --cursor <n>` returns `{lines, nextCursor, oldestCursor}` (only new output; reports
drops). `be10x wait --task <id> --for done` long-polls with `{"_keepalive":true}` frames so a minutes-long
block survives idle timeouts. Orca refs: `terminal read --cursor`, `terminal wait`, `transport.ts:116`.

**7. One PTY-passthrough method for steer/approve/kill.**
Remote follow-up, answering an AskUserQuestion, and approving a tool call are all the *same* primitive:
raw text into the agent's stdin. `be10x send --task <id> --text "..."`. Approvals = the accept keystroke.
No separate command taxonomy. Orca ref: `terminal.send` passthrough.

**8. Selectors with a cwd shortcut.**
`--task active`/`current` resolves `$PWD` to the enclosing worktree by longest-path-prefix; reject the cwd
shortcut when targeting a *remote* board (cwd is client-side). Orca ref: `src/cli/selectors.ts`.

### P1 — Durability & catch-up

**9. Monotonic-seq replay buffer for missed events (the standout pattern).**
Every status/notification event gets a per-connector monotonic seq; clients persist a watermark and on
reconnect call `getMissedSince(lastSeenSeq)` → idempotent, exactly-once catch-up ("3 agents finished while
you were offline") with **no real queue and no duplicates**. Orca ref: `mobile-notification-replay.ts`.

**10. Heartbeats + orphan reconciliation.**
Connector heartbeats each live session; board marks silent sessions "stalled". On connector restart,
reconcile persisted sessions vs. actually-running processes and orphaned git worktrees, then offer
resume/cleanup. Completions authenticated by session identity (can't spoof "done"). Orca refs:
`orchestration/lifecycle-reconciliation.ts`, `worktree-removal-safety.ts`.

**11. Detached agent + persisted lease (survive connector restart).**
Spawn `claude` under a supervisor that outlives the connector (detached process / tmux / `systemd-run`
scope) keyed by task id; persist a lease `{taskId, worktreeInstanceId, pid, pane}` + a bounded output ring
buffer. Restart → re-attach + replay, don't respawn. Orca ref: the daemon attach model + SSH relay leases.

### P1 — Prompt hygiene & task↔PR loop

**12. Thin prompt + on-demand context via a CLI callback, task text treated as untrusted.**
Don't stuff the full bug/issue body into the launch prompt. Seed a short brief + the task URL/id; the agent
pulls full context via `be10x task current --json` (resolved from the worktree). Wrap any inline provider
text in `--- BEGIN/END UNTRUSTED CONTEXT ---`. Orca refs: `linked-work-item-context.ts`, the `orca linear`
skill. (be10x already has MCP `gfa_*` tools — extend with a "current task" resolver.)

**13. Link fields as the task↔session↔PR join.**
Persist `{sourceProvider, sourceRef, repoId, worktreePath, sessionId, status, linkedPrUrl}` on the task;
when the agent opens the PR, stamp `linkedPrUrl` + advance the column. Closes the board's loop. (be10x
already links bugs→tasks; extend to PRs.)

### P2 — Later / scale

**14. `be10x` SKILL.md served on demand.**
Ship a `be10x` skill (installed to `~/.claude/skills`) whose body is the connector's command recipes, so the
agent reliably uses our board commands (pick task, post plan, request review, attach PR). Generate from one
source with a CI drift check; agent self-serves via `be10x skills get`. Orca refs: `skill-guides/*`,
`src/cli/handlers/skills.ts`.

**15. Data-driven agent-launch registry.**
One `agent-config.ts` mapping agent → `{launchCmd, promptMode, permissionArgs, resume}` so adding Codex/
Gemini later is a table row, not new code. Orca refs: `src/shared/tui-agent-config.ts`, `tui-agent-startup.ts`.

**16. Orchestration groups (fan-out N agents on one prompt).**
be10x is one step from this: a SQLite-backed coordinator that decomposes a task into a child-task DAG,
dispatches to connectors with a `maxConcurrent` cap, **one-spawn-per-tick** throttle, a **circuit breaker**
(`failure_count → circuit_broken`), heartbeats, and `decision_gate` escalation to a human. Orca refs:
`src/main/runtime/orchestration/{coordinator,db,types,lifecycle-reconciliation}.ts`.

**17. Scoped device tokens + method allowlist + instant revoke; demand-gated E2EE relay for off-LAN.**
When board↔connector control goes cross-network: per-teammate scoped tokens (observe vs. control), a
default-deny method allowlist at the transport boundary, revoke that terminates live sockets, and a blind
E2EE relay opened only when a watcher is attached. Orca refs: `runtime-rpc.ts`, `desktop-relay-service.ts`.

---

## Sequencing recommendation

`1 → 2 → 3` first (status backbone + resume + pick-project). They deliver the visible product jump and are
each a few days. Then `4/5/6/7` (CLI-as-control-plane) since the vision is "control from the be10x CLI
itself." `9/10/11` harden durability. `12/13` clean up prompts and close the PR loop. `14–17` are scale.

**Architectural throughline to hold onto:** one RPC surface on the connector; board and CLI are thin,
scoped clients of it; status is hook-driven; state is durable on the board; every long op has a
cursor/watermark for exactly-once catch-up.
