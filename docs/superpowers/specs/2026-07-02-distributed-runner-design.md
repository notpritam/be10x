# Distributed Runner — each member runs the agent on their own machine

**Goal:** Let a hosted be10x board (state only, e.g. on Render) drive a Claude agent that runs on **each team member's own machine** — their own repo, their own `claude` CLI, their own auth — linked to the board over HTTPS with a personal token. No CLI or agent runs on the server.

**Status:** V1 launch feature. Additive — the existing single-host flow (`be10x serve` = board + baked runner + local MCP) is unchanged.

---

## Why this doesn't work today (the three coupling points)

Everything the agent side does is coupled to a **local SQLite file on the same host as `serve`**:

1. **MCP server** (`src/mcp/server.js`) opens the DB via `GFA_DB_PATH` and verifies `GFA_TOKEN` against the local `tokens` table. The agent's `gfa_*` tools write the DB directly.
2. **Runner** (`src/runner/runner.js` → `wakeLoopAll` → `claimNextWakeAny(db)`) reads/writes the local DB directly to claim wakes and drive the executor.
3. **Executor** (`src/executor/executor.js`) spawns `claude` locally (this part is already what we want) but reports every run/progress row through the local `db`.

A remote member's machine can't reach Render's SQLite file, so none of these can talk to a hosted board. The fix is to give the agent side an **HTTP transport** to the board.

---

## Architecture

```
   HOSTED BOARD (Render — state only, no agent)
   ┌───────────────────────────────────────────────────────┐
   │ web UI + human REST (session cookie)                   │
   │ NEW: /api/agent/*  (token-auth, the agent transport)   │
   │   • rpc      — universal gfa_* gateway                  │
   │   • claim    — hand the next wake to a connector        │
   │   • report   — take the run outcome back (durability)   │
   │   • projects — a connector declares the repos it serves │
   │ SQLite: tasks · plans · comments · wakes · runs · tokens│
   └──────▲───────────────────────────▲─────────────────────┘
    HTTPS │ browser (use the board)    │ HTTPS + Bearer token
          │                            │
   each member's own machine ──────────┴────────────────────┐
   │ be10x connect (local runner loop)                       │
   │   claim → spawn `claude` in THEIR repo → report         │
   │ remote executor: local worktree + local claude auth     │
   │ agent's gfa_* tools → HTTP MCP → board /api/agent/rpc    │
   └─────────────────────────────────────────────────────────┘
```

**Principle preserved:** "sessions disposable, state durable." The board still owns all durable state and all lifecycle/retry logic. The connector is a stateless worker that borrows a wake, runs one local session, and hands the outcome back.

---

## Board-side: the `/api/agent/*` namespace (token-auth)

Auth: a new bearer path in the HTTP server. `Authorization: Bearer <gfa_token>` → `verifyToken(db, token)` → `ctx = { userId, tokenId }`. Reuses the existing `tokens` table (minted by `be10x token` or the dashboard). Routes below are gated on a valid token instead of the session cookie.

### `POST /api/agent/rpc` — the universal agent gateway
Body `{ tool, args }`. Dispatches to the **same** registry the stdio MCP server uses:
```
const tool = getTool(body.tool)          // src/mcp/tools.js
const result = tool.handler(db, ctx, args)   // ctx from verifyToken
→ 200 { result }   |   400 { error: <domain error> }
```
Every `gfa_*` tool is instantly available over HTTP with zero duplication. This is what the agent's MCP calls hit.

### `POST /api/agent/projects` — declare served repos
Body `{ key, name }`. `registerProject(db, { key, name, rootPath: null })` (path-less — the repo lives on the member's machine, not the server). Idempotent. Lets tasks target the repo and lets `claim` match it. Returns `{ project }`.

### `POST /api/agent/claim` — hand out the next wake
Body `{ projectKeys: [...], workerId }`. Runs `prepareWake` (see refactor) scoped to tasks whose `project.key ∈ projectKeys` (or personal/no-project). On a hit it: does the lifecycle pre-transition (backlog→researching / ready_to_work→in_progress), opens a **run row**, records a "woken/starting" note, and returns:
```
{ wake: { id, reason }, task: <full task>, mode, comments: [...], commentIds: [...],
  plan, resumeSessionId, runId }   |   200 {}   // nothing ready
```
Does **not** mark comments seen (a failed run must re-deliver them). `resumeSessionId` = the task's latest run session, so the connector can `--resume`.

### `POST /api/agent/report` — take the outcome back
Body `{ wakeId, runId, taskId, summary, commentIds }`. Runs `settleWake`: finalize the run row (done/failed + session + git), then the durability tail — auto-retry retryable failures with backoff, hand a successful `execute` to `verifying` + enqueue `verify`, mark the delivered `commentIds` seen, or surface a blocked/gave-up note. Returns `{ ok, retrying? }`.

---

## Refactor: split `driveWake` into `prepareWake` + `settleWake`

`src/runner/runner.js` `driveWake` currently does pre-transition → gather comments → `execute()` → post-run durability, all in one call. Extract the halves so the in-process runner AND the HTTP claim/report share one source of truth:

- `prepareWake(db, { wake, task, workerId })` → `{ mode, staged, comments }` (pre-transition + gather + "woken" note).
- `settleWake(db, { wake, task, workerId, comments, summary })` → the post-run logic (retry/verify/markSeen/blocked), returns the same result shape.
- `driveWake` becomes `const p = prepareWake(...); const summary = await execute(p.staged, {...}); return settleWake(..., p.comments, summary)` — behaviour identical, all existing scheduler tests stay green.

The board's `claim` calls `prepareWake`; `report` calls `settleWake`. Comment identity is threaded via `commentIds` (claim returns them, report passes them back) so a comment posted *during* the run isn't wrongly consumed.

---

## Member-side: the connector

### `src/connect/remote-executor.js` — `makeRemoteExecutor(board, repo, opts)`
A sibling of `makeClaudeExecutor` with no local `db`. Reuses `claude-adapter.js` (`buildClaudeCommand`, `StreamAccumulator`, `BE10X_SYSTEM_PROMPT`) and `worktree.js` (`ensureWorktree`, `worktreeBranch`, `collectGitMeta`). Given a claimed wake payload it: stages the worktree in the member's local `repo.rootPath`, spawns `claude` (with `--resume resumeSessionId` when present, and the board-pointing MCP config so the agent's tools reach the board), scrapes `sessionId` + `done`, and returns a summary `{ done, ok, sessionId, error, failureKind, git, branch }`. All rich state (plan/progress/artifacts/output/replies) travels through the agent's own `gfa_*` calls to `/api/agent/rpc` — the connector itself only reports the run outcome. `spawn`/`ensureWorktree` injected for tests.

### `src/mcp/http-server.js` — the HTTP-transport MCP server
When `GFA_BOARD_URL` is set, this variant serves the identical tool list (from `TOOLS` metadata — no DB needed) but each `tools/call` forwards `{ tool, args }` to `POST {GFA_BOARD_URL}/api/agent/rpc` with `Authorization: Bearer {GFA_TOKEN}`, mapping the JSON result back to MCP content. `fetch` injected for tests. The connector writes each repo an `mcp.json` pointing `command: node http-server.js`, `env: { GFA_BOARD_URL, GFA_TOKEN }`.

### `src/connect/connect.js` + `be10x connect` (bin)
Config `~/.be10x/connect.json`: `{ board, token, repos: [{ key, path }] }`, seeded from `be10x connect --board <url> --token <gfa_...> [--repo <path> ...]` (a repo's key is auto-detected from its git remote via `detectProjectKey`). On start: `POST /api/agent/projects` for each repo, write each a board-pointing `mcp.json`. Then the poll loop: `POST /api/agent/claim {projectKeys}` → on a wake, `makeRemoteExecutor` runs it in the matching local path → `POST /api/agent/report`. A single failing wake never kills the loop (mirrors the runner). `--once` for a single pass (tests/cron).

---

## Auth & trust (V1)

Matches today's MCP trust model: any valid token can drive tasks via `rpc` (the stdio MCP already grants this). `claim` is naturally contained — a connector only receives wakes for the `projectKeys` it declares. Team-scoping the gateway (a token may only touch tasks whose team it belongs to) is a documented hardening follow-up, not a V1 blocker for a trusted team. Tokens are bearer secrets over HTTPS only (`GFA_SECURE_COOKIES=1` deploys already terminate TLS).

## What stays unchanged

`be10x serve` still boots the board + the baked `wakeLoopAll` runner + local stdio MCP (via `GFA_DB_PATH`). Single-host users are unaffected. On Render the baked runner simply finds no local-path projects and idles; remote connectors do the work. Both can coexist — `claim`/`claimNextWakeAny` are atomic against the same queue.

---

## Testing

- **rpc gateway:** bad/missing token → 401; known tool dispatches to its handler; a domain error (e.g. `NO_TASK`) passes through as 400. In-memory db.
- **claim/report:** `prepareWake`/`settleWake` parity — the existing `scheduler.test.js` cases must stay green after the refactor; new cases drive claim→report over an in-memory db and assert the same transitions/wakes as `driveWake` (retry backoff, execute→verifying+verify, markSeen).
- **remote executor:** injected `spawn` emitting stream-json → asserts the returned summary; injected `board` records the report call shape.
- **http MCP:** injected `fetch` → asserts the forwarded `{ tool, args }` + bearer header and the mapped result/error.
- **connect loop:** injected `board` + executor → claim→run→report happens once for a queued wake; `--once` resolves.

## Task breakdown

1. Refactor `driveWake` → `prepareWake` + `settleWake` (behaviour-preserving; existing tests green).
2. Bearer-token auth in the HTTP server + `POST /api/agent/rpc` gateway + tests.
3. `POST /api/agent/projects` + `/api/agent/claim` + `/api/agent/report` (board runner API) + tests.
4. `src/connect/remote-executor.js` + tests.
5. `src/mcp/http-server.js` (HTTP-transport MCP) + tests.
6. `src/connect/connect.js` + `be10x connect` command + config + tests.
7. Dashboard "Connect your machine" settings panel (mint token + show the one-liner) + build.
8. Member setup doc (`docs/connect.html` / README) + Dockerfile/hosting note.
