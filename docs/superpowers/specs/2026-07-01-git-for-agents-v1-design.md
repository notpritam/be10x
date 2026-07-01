<!-- ABOUTME: v1 design spec for "Git for Agents" — a multi-tenant, typed-task board where humans and agents plan, review, approve, and ship work. -->
<!-- ABOUTME: Grown from the chat-v2-issues forensics tracker. This is the canonical engineering source of truth for v1; the overview.html is its visual companion. -->

# Git for Agents — v1 Design Spec

**Date:** 2026-07-01 · **Status:** draft, pending user review · **Visual companion:** `docs/overview.html` (served via `docs/serve.cjs`)

---

## 1. Summary

**Git for Agents** is a shared board where humans and agents plan, review, approve, execute, and record work — for *any* kind of task, not just code. It grows the existing chat-v2 issue-forensics tracker (a repo-local, single-user Kanban with a rich card contract and a two-way human↔agent loop) into a **multi-tenant, project-agnostic platform** with authentication, teams, a plan-review gate, human-in-the-loop input requests, a background worker, and an MCP interface for agents.

The thesis: **the board is the shared state machine.** A human or an agent captures a task; the agent researches and drafts a plan; a human (or a tagged teammate) reviews and approves; a background worker picks up approved tasks and runs the task-type's flow; the agent pauses to ask when it needs a decision; on completion it self-rates and records what it produced. Everything is durable, scoped (personal / project / team), and reachable from two front doors — a buildless web board for humans and an MCP server for agents.

## 2. Background — the seed we are keeping

The prototype (`docs/chat-v2-issues/` in E1ectron) established two things worth preserving verbatim in spirit:

1. **The card content contract** — every card tells its story visually: a symptom, a Mermaid flow diagram, a red **root-cause** callout, a green **solution** callout, touched files, and a research dossier. (CONVENTIONS.md §2–§3.)
2. **The two-way agent loop** — moving a card to *In Progress* signals the agent to start; the agent writes a live `agent` status block (`state`, `step`, `message`, `todos[]`, `updatedAt`) that the board polls and renders. (CONVENTIONS.md §8.)

What changes in v1: storage moves from a repo-local gitignored folder of flat JSON files to a **real multi-tenant backend keyed by stable project identity** (survives repo moves/reinstalls/branch changes); "issue" generalizes to **typed task**; and the single-user assumption is replaced by **accounts + teams**.

## 3. Goals and non-goals (v1)

**Goals**
- A generic **typed-task engine** shipping **two task types** (`code-issue` ported from chat-v2, plus a generic `idea`/`research` type) to prove genericity.
- Full **task lifecycle**: add your own task, an explicit state machine, replan, retry-N, and agent **self-rating**.
- **Plan-review gate**: tag a reviewer → approve / request-changes → agent works.
- **Human-in-the-loop input requests**: agent pauses (`needs-input`) and asks a scoped question with quick-choice chips + custom input; the answer resumes it.
- **Cron worker**: a scheduled poller that claims `ready-to-work` tasks and drives them; plus a **changes watcher** that streams progress onto the card.
- **Full auth + teams**: accounts, login, sessions, hashed passwords, roles, per-team task visibility; personal / project / team scopes.
- **MCP interface**: agents create/claim/plan/update/rate/request-input via tools, token-authed.
- **Buildless web board**: Kanban + wide detail panel + review UI + live agent status.

**Non-goals (deferred to v2+)**
- Public managed hosting, multi-instance operations, custom domains.
- Phone-optimized responsive UI and free remote access via Cloudflare Tunnel.
- Playwright/Chromium deterministic verification and persistent Chrome-profile runs.
- External task-tracker sync (do-it, Jira, …).
- Task-type marketplace / sharing.
- Cross-team analytics and agent-fleet orchestration.
- Postgres migration (only if hosted at scale).

## 4. Core concepts

- **Task** — the unit of work. Has a `type`, a `scope` (personal/project/team), a `status` (lifecycle state), an owner, an optional assignee/reviewer, a `plan`, a `research` dossier, a `rating`, and type-specific content.
- **Task type (plugin)** — defines exactly three things:
  - **Content contract** — the fields a card of this type needs.
  - **Flow** — the ordered steps the agent runs.
  - **Definition-of-done** — how completion is proven.
  - v1 types: `code-issue` (contract: symptom · rootCause · solution · diagram · files; flow: debug → failing test → green → static-analysis → commit → PR; done: tests pass + ship refs) and `idea`/`research` (contract: proposal/question · rationale/findings · sources/criteria; flow: draft/gather → discuss/verify → decide/synthesize; done: approved + criteria met).
- **Scopes** — **personal** (private), **project** (keyed by stable project identity), **team** (shared, members join and collaborate).
- **Team bias** — team-level conventions injected into every flow (the team's shared "how we work"). Makes two teams run the same type differently.
- **Review gate** — before execution, the plan is posted for approval; a tagged human approves or requests changes.
- **Input request** — a mid-flow, human-in-the-loop question with optional quick-choice options and a free-form answer; blocks the task until answered.
- **Cron worker** — a scheduled process that polls for `ready-to-work` tasks, claims them, and runs their flow.
- **Changes watcher** — a background observer that records what changed during execution (files/diffs/status) and streams it to the card.

## 5. Architecture — two front doors, one core, one store

```
   Humans ─▶ Web board (buildless HTML/JS, session cookie)
                          │
   Agents ─▶ MCP server (tools, personal access token)
                          │
                 ┌────────▼─────────┐
                 │   Core (shared)  │
                 │  · Task engine   │  typed-task model, lifecycle state machine,
                 │  · Auth & teams  │  review gate, input requests, self-rating,
                 │  · Worker/loop   │  cron poll + changes watcher
                 └────────┬─────────┘
                          │
                    SQLite (single file)
        users · teams · memberships · projects · tasks ·
        task_events · reviews · input_requests · sessions · tokens
```

Both front doors call the **same core** over the **same store**, so a task an agent creates via MCP and a task a human drags on the board are the same row.

**Stack (recommended default, overridable):** Node runtime · SQLite (via `better-sqlite3` or `node:sqlite`) · a thin HTTP framework (Fastify or Hono) · buildless HTML/JS frontend · an MCP server sharing the core module.

## 6. Data model (SQLite)

Tables (columns abbreviated; all ids are text UUIDs unless noted):

- `users` — `id, email (unique), display_name, password_hash, created_at`
- `sessions` — `id, user_id, expires_at, created_at` (cookie session)
- `tokens` — `id, user_id, name, token_hash, scopes, last_used_at, created_at` (personal access tokens for MCP/agents)
- `teams` — `id, name, slug (unique), bias_md (team conventions), created_by, created_at`
- `memberships` — `id, team_id, user_id, role (owner|admin|member|viewer), created_at`
- `projects` — `id, team_id (nullable for personal), project_key (stable identity: git remote or slug), name, default_branch, created_at`
- `tasks` — `id, human_id (e.g. GFA-014), type, scope (personal|project|team), team_id (nullable), project_id (nullable), owner_id, assignee_id (nullable), reviewer_id (nullable), title, status, severity, content_json (type-specific contract), plan_json, research_json, rating_json, refs_json (ship/output), retry_count, created_at, updated_at`
- `task_events` — `id, task_id, actor (user id or 'agent'), kind (status_change|comment|plan|review|input_request|input_answer|progress|rating|ship), payload_json, created_at` (append-only audit + activity feed)
- `reviews` — `id, task_id, reviewer_id, verdict (approved|changes_requested), comment, created_at`
- `input_requests` — `id, task_id, question, choices_json (nullable), allow_custom (bool), answer, answered_by, status (open|answered|cancelled), created_at, answered_at`

Design rules: `content_json`/`plan_json`/`research_json` keep the flexible, type-specific shape the chat-v2 schema pioneered; the relational columns carry identity, scope, ownership, and status for querying and authorization. `task_events` is the append-only history — nothing is destructively overwritten, so replan/retry keep provenance.

## 7. Lifecycle state machine

States: `backlog → researching → plan_review → ready_to_work → in_progress → verifying → done`, with side/terminal states `needs_input`, `blocked`, `not_a_bug`, `wont_fix`. (`researching` is a universal lifecycle *phase* every task can pass through — distinct from any single task *type*; a "research task" is just the generic type in the `researching` phase.)

Transitions:
- `backlog → researching` — agent (or human) starts research.
- `researching → plan_review` — research done; plan drafted.
- `plan_review → {researching (re-research) | plan_review (reiterate/replan) | ready_to_work (approved)}` — reviewer can re-research, request plan changes, or approve. Verify-&-comment happens here as review activity.
- `ready_to_work → in_progress` — the **cron worker** (or a human) claims and starts it.
- `in_progress → needs_input → in_progress` — agent pauses for a human answer, then resumes.
- `in_progress → {verifying (work done) | plan_review (failure/replan) | blocked}`.
- `verifying → {done (passes self-rating/DoD) | in_progress (retry) | plan_review (rethink)}`.
- Any → `blocked` (external dependency); `blocked → previous` on unblock.

The **ready-to-work flag is the worker's pickup signal** (generalizing chat-v2's "move to In Progress = start"). `retry_count` bounds automatic retries; beyond the bound the task routes to `needs_input`.

## 8. Auth model

- **Humans** authenticate with email + password (hashed with a slow KDF: bcrypt/scrypt/argon2); a **cookie session** is issued (httpOnly, sameSite, expiry). CSRF protection on state-changing form posts.
- **Agents / MCP** authenticate with a **personal access token** (shown once, stored hashed). Tokens carry scopes and map to a user, so an agent acts as that user with that user's team permissions.
- **Authorization** is per-team role (`owner/admin/member/viewer`) plus scope: personal tasks are private to their owner; project/team tasks are visible to team members; only `member+` can move tasks or approve; `viewer` is read-only. Every core mutation checks (actor, task scope, team role).

## 9. MCP interface

The MCP server exposes the core as tools (token-authed, acting as the token's user):

- `list_tasks(scope?, project?, status?)` · `get_task(id)`
- `create_task(type, scope, title, content)` → new task in `backlog`
- `research_task(id, research)` → attach research dossier, `→ plan_review`-ready
- `plan_task(id, plan)` → attach/replace plan (replan-safe)
- `submit_for_review(id, reviewer?)` → `plan_review`
- `mark_ready(id)` → `ready_to_work` (if approved)
- `claim_task(id)` → `in_progress` (worker or agent)
- `update_progress(id, {step, message, todos, changes})` → live status + `task_events`
- `request_input(id, question, choices?, allow_custom?)` → opens an `input_request`, task `→ needs_input`; returns when answered (or the agent polls `get_task`)
- `submit_output(id, refs)` → record ship/output refs
- `rate_task(id, rating)` → self-rating against DoD
- `set_status(id, status)` · `comment(id, text)`

Semantics mirror the web board exactly — same transitions, same authorization, same `task_events` trail.

## 10. Web board

Buildless HTML/JS (inherits the chat-v2 design language: Space Grotesk / IBM Plex Sans / JetBrains Mono; coral/iris/emerald diagram legend; compact cards → wide detail panel). Views:
- **Board** — lanes by lifecycle state, filterable by scope/project/type/severity, searchable.
- **Detail panel** — the card contract (diagram · root-cause · solution · files · research), the **agent status block**, the **review UI** (tag reviewer, approve/request-changes), the **input-request component** (quick-choice chips + custom input + "Send & continue"), the activity feed (`task_events`), comments, and ship/output refs.
- **Auth** — sign-up / login; team create/join; token management.
- **"Needs you" filter** — surfaces every task awaiting a human (open input requests, pending reviews).

Display cadence follows chat-v2: poll every ~7s, never re-render a focused field (don't clobber in-progress edits).

## 11. Task types in v1

- **`code-issue`** — the ported chat-v2 contract and flow (systematic-debugging → TDD → static-analysis → commit → PR → ship refs).
- **`idea` / `research`** — a generic, code-free type proving the plugin model works for analysts/PMs/researchers.

A task type is data + a small handler describing {contract fields, flow steps, done-check}. Adding types later is additive, not a rewrite.

## 12. Cron worker + changes watcher

- **Worker** — a scheduled process (v1: Claude Code scheduled-wakeup or system cron; the floor is ~60s pickup) that polls the core for `ready_to_work` tasks in scopes it's authorized for, claims one **if its type is agent-executable** (atomic status flip to avoid double-claim; human-executed types wait in `ready_to_work` for a person), and runs the type's flow, calling `update_progress` as it goes. On completion it self-rates, records refs, and moves to `verifying`/`done`. Pushes (for `code-issue`) go to a campaign branch behind an open PR, never to protected branches — reversible by design.
- **Changes watcher** — during `in_progress`, observes the working tree / task artifacts and streams a compact "what changed" summary (files, diffs, status) to `task_events`, so the board shows real progress.

## 13. Testing strategy

- **TDD** (superpowers:test-driven-development) for the core: write the failing test, watch it fail, minimal green, refactor. Unit boundaries are small and independently testable: auth, authorization, task state machine, each task-type handler, the review gate, input-request flow, the worker's claim logic, and the MCP tool layer (thin adapters over the core).
- **State-machine tests** enumerate legal/illegal transitions.
- **Authorization tests** assert scope/role rules (personal privacy, viewer read-only, cross-team isolation).
- **Integration tests** exercise a full task through both front doors (web API + MCP) against a temp SQLite file.

## 14. Security considerations

Hashed passwords (slow KDF), httpOnly/sameSite session cookies, CSRF on form posts, tokens stored hashed and shown once, per-request authorization on every mutation, SQL via parameterized queries only, strict path handling on any static serving, and no secrets in `task_events`/content. Cross-team data isolation is an explicit, tested invariant.

## 15. v1 build decomposition (each slice = its own plan → build cycle)

v1 is large (full auth + teams + MCP + typed core + worker + input). It decomposes into buildable slices:

1. **Foundation: auth + teams + store.** SQLite schema + migrations; accounts, sessions, tokens; teams, memberships, roles; authorization module. Deliverable: sign up, log in, create/join a team, issue a token — all tested.
2. **Typed-task engine + lifecycle.** Task model, `content_json` contract per type, the state machine, `task_events`, replan/retry, self-rating. Deliverable: create/move/rate a task through every legal transition via the core API.
3. **Review gate + worker + input requests.** Tag-to-review approve/request-changes; the cron worker's poll+claim+run loop; the changes watcher; the input-request open/answer/resume cycle.
4. **Front doors: MCP + web board.** MCP tool adapters over the core; the buildless board (Kanban + detail panel + review UI + input component + agent status). Deliverable: drive a task end-to-end from both a browser and an agent.

Each slice gets its own implementation plan (writing-plans) and is built/tested before the next.

## 16. Deferred (v2+)

Remote & hosting (responsive/phone UI, free Cloudflare Tunnel, host-your-own instance, shared URLs) → **v2**. Deterministic verification (Playwright/Chromium, persistent Chrome profiles, verification recipes feeding self-rating) → **v3**. Ecosystem (more task types, type sharing, external sync) → **v4**. Scale & insight (cross-team analytics, fleet orchestration) → **v5**. **Background merge/verification status tracker** — a toggleable (via dashboard settings), cron-driven check the agent runs itself to keep each task's *verified / in-progress / done / merged* status live on the board without manual updates → rides the **v3** verification work. **GitHub PR integration (v2)** — link a task to its pull request (stored in `refs`), pull the PR's review comments and threads into the task's activity, and resolve or reply to them from within be10x with two-way sync back to GitHub, so a reviewer's GitHub comments and the board stay in lockstep. **Agent-driven generative UI (v3/v4)** — instead of a fixed input widget, the agent specifies the interactive component to render for a request (a JSON schema / sandboxed HTML / iframe / buttons / an MCP action), making approvals and inputs open-ended and agent-driven.

## 17. Open questions

- **User's cut-off requirement** — the message "…and also it needs to be" was truncated; resolve and fold in before slice 3 (worker/changes) is planned, since it likely concerns the in-progress/changes behavior.
- **Worker runtime in v1** — Claude Code scheduled-wakeup vs. system cron vs. a small long-running Node daemon. Leaning daemon-with-interval for tighter pickup; confirm.
- **Project identity source** — git remote URL when present, else an assigned slug. Confirm the fallback UX for non-git (analyst/PM) projects.
- **Single-instance auth vs. team hosting** — v1 auth runs locally; confirm whether "team" in v1 means multiple humans hitting one locally-hosted instance (LAN/tunnel) now, or single-human-multi-role until v2 hosting.
