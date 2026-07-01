<!-- ABOUTME: be10x orchestration design (v2) — how be10x spawns/controls an ephemeral, resumable Claude session per task, in a per-task worktree, woken by board events. -->
<!-- ABOUTME: Grounded in the paperclip + vibe-kanban reference implementations (both cloned under reference/); cites the exact mechanics to copy. -->

# be10x — Agent Orchestration Design (v2)

**Date:** 2026-07-01 · **Status:** draft · **Builds on:** the v1 core (`2026-07-01-git-for-agents-v1-design.md`). **References studied (cloned under `reference/`):** `paperclip` and `vibe-kanban` — both independently converge on the model below, which de-risks it.

---

## 1. Summary

be10x becomes an **agent orchestrator**: on a board event it spawns an **ephemeral, resumable Claude session per task**, in that task's **own git worktree**, seeded with **our** system prompt, running **headless in the background**. All human interaction happens **on the board** — the agent *generates* the plan, diagrams, and questions the board renders — with a **CLI escape hatch** to attach to a task's session from a terminal. **Sessions are disposable; state is durable:** the plan, comments, worktree, tracking state, and the agent's own `session_id` all live in be10x (DB + files) as the primary source, so any run can be resumed — or restarted fresh from saved state — and the CLI can be closed when idle (no memory, no token burn).

## 2. Core principle — event-woken, ephemeral, resumable (NOT always-live)

Both references reject long-lived agents; so do we. Board events (create · comment · input-answer · approve · "pick up now") **enqueue a run**; a scheduler claims it, spawns the agent, it works, then **exits**. "Staying on a task" is *re-waking from durable state*, not a process held open.

- vibe-kanban: `spawn_exit_monitor` finalizes each process and consumes queued follow-ups (`crates/local-deployment/src/container.rs:480-813`); boot-time `cleanup_orphan_executions` reaps stale runs (`crates/server/src/main.rs:76`).
- paperclip: `enqueueWakeup` writes an `agent_wakeup_requests` row + a queued `heartbeat_run` with a `contextSnapshot {issueId, wakeReason, resumeSessionParams}` (`server/src/services/heartbeat.ts:11891`); the scheduler tick claims slots and executes (`heartbeat.ts:9201-9236`, `server/src/index.ts:861`).

## 3. What we already have vs. what we build

**Have (the control plane) — v1, tested:** typed tasks · governed lifecycle · review gate · input requests · append-only event log · `refs.worktree` slot · the `be10x work` claim-loop · live agent-status block · MCP tools · HTTP API + board.

**Build (the runtime) — v2:**
1. **Executor** — adapter (per agent) over a shared process runner.
2. **Worktree manager** — a git-worktree per task, reuse-on-resume.
3. **Session save/resume** — persist the agent's `session_id` per task; `--resume` it.
4. **Wake-queue + scheduler** — events → runs → spawn → exit; orphan recovery.
5. **Plan / review / approve loop** — plan doc + anchored comments + approval, re-injected on wake.
6. **Comments + attachments** — human context delivered inline + as files in the worktree.
7. **Board-generated UI** — the agent emits structured plan/diagram/question components the board renders.
8. **CLI-resume** — a per-task command to attach a session in the worktree with saved state.

## 4. Data model additions

- **`sessions`** — one agent conversation per task: `id, task_id, executor (claude|codex|…), agent_session_id (the CLI's own id, scraped from its stream), agent_working_dir, status, created_at, last_run_at`.
- **`runs`** (execution processes) — `id, session_id, run_reason (plan|execute|review|follow_up|setup|cleanup), action_json (a self-describing, resumable action chain), status (running|completed|failed|killed), pid, pgid, exit_code, started_at, completed_at, logs_path`.
- **`worktrees`** (or fields on the task/session; `refs.worktree` reserved) — `repo_root, branch, path, base_ref, isolation (worktree|branch), status`.
- **`comments`** — `id, task_id, author, body, anchor (plan_line|diagram|general), created_at, seen_at`.
- **`attachments`** — `id, task_id, name, path, kind, created_at`.
- **`wake_queue`** — `id, task_id, reason, context_json, enqueued_at, claimed_at`.

Rationale for `action_json` (copy vibe-kanban's `ExecutorAction { typ, next_action }`, `crates/executors/src/actions/mod.rs:35-52`): store the run as *data* so "plan → wait-for-approval → execute → cleanup" survives a crash/restart and is re-drivable by a generic monitor.

## 5. Executor — adapter + shared runner

**Split the per-agent adapter from the process runner** (both references do this; it makes Codex/Gemini a drop-in later).

- **Adapter (Claude):** builds the command + args + prompt and parses the stream.
  - Command: `npx -y @anthropic-ai/claude-code@<pinned>` (vibe: `crates/executors/src/executors/claude.rs:61-67`; paperclip: `packages/adapters/claude-local/src/server/execute.ts:710-738`).
  - Args: `-p --verbose --output-format stream-json` (+ `--input-format stream-json` for the control protocol); `--resume <agent_session_id>` on follow-up; `--append-system-prompt-file <our-prompt>` on a fresh session; `--add-dir <worktree>`; permission/plan-mode flags.
  - **Prompt over stdin / the stream-json control protocol, not argv** — so we get streaming events, tool-approval gating, and plan-mode / AskUserQuestion interception (vibe: `ProtocolPeer` + `ClaudeAgentClient`, `claude.rs:620-711`, `claude/client.rs:279-380`; paperclip pipes prompt on stdin, `execute.ts:790`).
- **Runner (shared):** `spawn(cmd, {cwd: worktree, env, process-group, stdio piped})`; forward stdout to the board (live) + a JSONL logs file; **scrape the agent's `session_id` + message ids** and persist onto the `session`/`run` (vibe: `claude.rs:811-838`; paperclip: `execute.ts:899-933`); detect completion from the terminal `result` object; register pid/pgid for kill; graceful `CancellationToken`-then-SIGKILL of the whole group. **Strip host `CLAUDECODE*` env** so a nested `claude` will start (paperclip: `server-utils.ts:2779-2787`).
- **Our system prompt** enforces the be10x flow: plan first (don't implement), ask when unsure (emit board questions), generate board components, iterate on review.

## 6. Worktree per task

Copy vibe-kanban's `WorktreeManager` (`crates/worktree-manager/src/worktree_manager.rs`) and paperclip's `workspace-runtime.ts`:

- **Deterministic branch + path:** branch `be10x/<GFA-id>-<slug>`, path `<repo_root>/.be10x/worktrees/<branch>` (parent overridable).
- **`ensureWorktree()` is idempotent + lock-guarded + recreate-if-missing** (per-path mutex) — called before *every* run/follow-up, so a deleted/absent worktree self-heals on resume (vibe: `worktree_manager.rs:88-153`).
- **Reuse-on-resume:** an existing valid worktree for the branch is reused; unstarted ones refreshed to base (paperclip: `workspace-runtime.ts:1266-1352`).
- **cwd == worktree assertion** before spawning (paperclip: `heartbeat.ts:1372-1379`) — an agent must never run in the wrong folder.
- **Cleanup/gc:** `git worktree remove --force` + prune, tolerant of a deleted parent repo.
- **Per-task isolation choice:** `worktree` vs `branch-in-place` — user picks, or the agent decides by blast radius (a task field).

## 7. Wake-queue + scheduler

- Board events (`created`, `comment`, `input_answer`, `review resolved`, `pick_up_now`) → `enqueue(task, reason, context_snapshot)`.
- **Scheduler tick** claims queued runs against **concurrency slots** with an optimistic lock — `UPDATE tasks SET status='in_progress' WHERE id=? AND status='ready_to_work'` (a second claimer gets nothing / 409; copy paperclip `issues.ts:5575-5595`, vibe start-flow). Then spawn via the executor; on exit, finalize or **chain** the next action, and consume any **queued follow-up** (one per session; vibe `QueuedMessageService`, `crates/services/src/services/queued_message.rs`).
- **Orphan recovery on boot:** mark runs left `running` at last shutdown as `failed`; shutdown kills all process groups (vibe: `main.rs:76`, `:236-242`).

## 8. Plan / review / approve loop

The heart of your flow — copy paperclip's plan/annotation/approval trio:

- **Plan is a first-class doc** on the task (`plan_json` + a generated diagram). A **planning mode** prompt makes the agent *write the plan and not implement* (paperclip `work_mode:"planning"`, directive at `server-utils.ts:1242-1257`).
- **Anchored comments:** humans comment on specific plan lines / the diagram (`comments.anchor`); paperclip's `document_annotation_threads` + `buildPlanReviewContext` (`server/src/services/plan-review-context.ts:133`).
- **On the next wake**, be10x builds the prompt with the plan + open comments (**delta-only on resume**, so follow-ups are cheap; paperclip `renderPaperclipWakePrompt` `server-utils.ts:1165`, `execute.ts:689-691`) → the agent **revises** → loop until you're happy.
- **Approval** reuses our v1 review gate (tag a reviewer → approve / request-changes); resolving an approval **wakes the agent to continue** (paperclip `routes/approvals.ts:227`). Anyone tagged can review.

## 9. Human inputs + attachments

- **Comments** ride inline in the wake prompt (delta-only on resume).
- **Attachments** are copied into the worktree (`.be10x-attachments/`) and referenced by path in the prompt (agent-agnostic; both references do markdown-link rewriting — vibe `attachment://` → file, `crates/server/src/routes/workspaces/create.rs:88-210`).
- **Input requests** (§10) answered on the board fold into the next wake.
- The agent is **proactive** (reads all context in depth on each wake) **and** promptable via the **"pick up now"** button, which just enqueues a wake.

## 10. Board-generated UI (the agent builds the interface)

Instead of text, the agent emits **structured components** the board renders — the generative-UI idea, now core:
- Extend the tool surface (MCP + HTTP): `gfa_set_plan` (with a diagram spec), `gfa_ask` (a question with options → rendered one-at-a-time), and a general `gfa_render` (schema-described component: choices, form, diagram, wireframe, iframe, or an MCP action).
- The board renders these from a **safe, schema-driven** spec (sandbox any raw HTML/iframe). The mockup (`docs/board-mockup.html`) shows the target: a plan diagram + a "3 of 6" question flow + a comment thread pinned to the diagram.

## 11. CLI-resume escape hatch

Board-primary, **plus** a per-task command: `be10x resume <GFA-id>` opens/attaches a session **in the task's worktree** with the saved `agent_session_id` + state (or starts fresh from state if the session id is gone) — the same resume mechanism as `be10x work`, but interactive. Paperclip's `agent local-cli` (prints env + resume) is the model. You only touch it when you *want* to.

## 12. Session save/resume from durable state (the stateless-resumable principle)

Everything needed to resume — `agent_session_id`, worktree, plan, comments, tracking state — is persisted (DB + files) as the **primary source**. Resume paths: (a) `--resume <agent_session_id>` if still valid; (b) a **fresh session seeded from saved state** if the id is lost/poisoned (validate-before-resume; paperclip drops poisoned sessions, `execute.ts:910-918`). Idle → close the CLI, zero cost.

## 13. Reference map — what to copy, from where

| be10x piece | vibe-kanban | paperclip |
|---|---|---|
| Adapter/runner split | `executors/mod.rs:220-302`, `command.rs:65-160` | `adapter.execute` + `server-utils.ts:2750` |
| Prompt over stream-json; scrape session-id | `claude.rs:620-711,811-838` | `execute.ts:710-805,899-933` |
| Session per task → `--resume` | `coding_agent_turn.rs`, `claude.rs:360-382` | `agent_task_sessions.ts`, `execute.ts:625-691` |
| Worktree ensure/reuse/gc | `worktree_manager.rs:88-153,229-300` | `workspace-runtime.ts:1223-1422` |
| Wake-queue + scheduler + orphan recovery | `container.rs:480-813`, `main.rs:76` | `heartbeat.ts:11891,9201-9236`, `index.ts:861` |
| Checkout optimistic lock | workspace start-flow | `issues.ts:5575-5595` |
| Plan/annotations/approval | plan-mode + follow-ups | `plan-review-context.ts:133`, `approvals.ts:117-286` |
| Human input inline + attachments | `queued_message.rs`, `create.rs:88-210` | `server-utils.ts:1165`, `routes/issues.ts:8288` |
| CLI = trigger/attach, server spawns | `npx-cli/src/cli.ts` | `cli/commands/run.ts:84`, `heartbeat-run.ts` |

## 14. Build slices (each its own plan → build)

1. **Executor + worktree (the runtime).** Claude adapter + shared runner (spawn · stream-json · session-id scrape · completion · kill) + `WorktreeManager` (ensure/reuse/cleanup). Deliverable: given a `ready_to_work` task, `be10x work` really spawns Claude in a fresh worktree with our prompt, streams progress to the board, and persists the session id. *(Turns today's stub executor real.)*
2. **Wake-queue + scheduler + resume.** Events → runs; concurrency slots + optimistic checkout; follow-up/`--resume`; orphan recovery. Deliverable: comment/answer/approve auto-wakes the agent; kill the CLI mid-task and resume from state.
3. **Plan / review / approve loop + comments/attachments.** Plan doc + planning-mode + anchored comments + wake-prompt builder + attachment copy-in. Deliverable: the full plan → comment → revise → tag-approve → execute loop.
4. **Board-generated UI.** `gfa_set_plan`/`gfa_ask`/`gfa_render` + the schema-driven renderer (diagram, one-at-a-time questions). Deliverable: the mockup, live.
5. **CLI-resume** command + polish.

## 15. Open questions

- Pin which agent CLI + version; support Codex/Gemini adapters now or later.
- Sandbox model for agent-generated components (schema-only vs sandboxed HTML/iframe).
- Concurrency limits per laptop; single-repo vs multi-repo workspaces (vibe supports multi).
- How much of vibe-kanban's full `ExecutorAction` chain to adopt vs a simpler state machine on our existing lifecycle.
- Where the runtime lives: extend the current Node server, or a dedicated runner process the CLI manages.
