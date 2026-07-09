// ABOUTME: Shared domain types mirroring the backend HTTP contract.

export type TaskType = "general" | "code-issue" | "query";
export type Severity = "high" | "medium" | "low";

export type Status =
  | "backlog"
  | "researching"
  | "plan_review"
  | "ready_to_work"
  | "in_progress"
  | "needs_input"
  | "verifying"
  | "done"
  | "blocked"
  | "not_a_bug"
  | "wont_fix";

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt?: number;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
}

/** A linked repository the agent can work a task in (from `be10x link`). */
export interface Project {
  id: string;
  key: string;
  name: string;
  defaultBranch: string | null;
  rootPath: string | null;
}

/** Per-task isolation: a fresh worktree (default) or work in the repo root directly. */
export type Isolation = "worktree" | "branch";

/** A directory on the server, for the "add a repo" folder picker. */
export interface FsEntry {
  name: string;
  path: string;
  isRepo: boolean;
}
export interface FsListing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: FsEntry[];
}

export type TeamRole = "owner" | "admin" | "member" | "viewer";

/** One row of the public leaderboard — tasks completed and token usage through be10x only. */
export interface LeaderboardRow {
  id: string;
  email: string;
  displayName: string;
  tasksDone: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface Member {
  userId: string;
  displayName: string | null;
  email: string | null;
  role: TeamRole;
}

/** A lightweight public user card — search results, recent collaborators, quick-add chips. */
export interface UserLite {
  id: string;
  email: string;
  displayName: string;
}

/** A personal access token as shown in a list — never carries the plaintext secret. */
export interface TokenInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A freshly minted token — the plaintext `token` is returned exactly once. */
export interface MintedToken {
  id: string;
  name: string;
  token: string;
}

/** Paths the MCP config needs, from GET /api/agent-config. */
export interface AgentConfig {
  mcpServerPath: string;
  dbPath: string;
}

export interface AgentStatus {
  name?: string;
  state?: string;
  model?: string;
  note?: string;
  /** The current step label (e.g. "agent", "revise", "woken"). */
  step?: string;
  /** The latest human-readable progress line — "what it's doing right now". */
  message?: string;
  /** The agent's implementation task list — plain strings or { text, status } items. */
  todos?: unknown[];
  changes?: unknown;
  /** Epoch ms of the last progress write — the "last update Xs ago" signal. */
  updatedAt?: number;
}

/** One wake in the queue — why a task is (or isn't) moving. `pending` means unclaimed by the runner. */
export interface WakeEntry {
  id: string;
  reason: string;
  context: unknown;
  enqueuedAt: number;
  claimedAt: number | null;
  claimedBy: string | null;
  pending: boolean;
}

/** The consolidated debug snapshot (GET /api/tasks/:id/debug) — everything the board knows about a task. */
export interface TaskDebug {
  now: number;
  task: Task;
  agent: AgentStatus | null;
  runs: Run[];
  wakes: WakeEntry[];
  events: TaskEvent[];
  input: InputRequest | null;
}

/** A visual artifact the agent posted to a task — RCA, diagram, finding, suggestion, verification —
 *  rendered richly (HTML preferred) in the task view. `content` has the same shape as a plan value. */
export interface Artifact {
  key: string;
  kind: string;
  title?: string;
  content: unknown;
  createdAt?: number;
  updatedAt?: number;
}

export interface Task {
  id: string;
  humanId: string;
  type: TaskType;
  scope: string;
  teamId: string | null;
  projectId?: string | null;
  ownerId: string;
  assigneeId: string | null;
  reviewerId: string | null;
  title: string;
  status: Status;
  severity: Severity;
  content: Record<string, unknown>;
  plan: unknown | null;
  research: unknown | null;
  rating: unknown | null;
  refs: unknown | null;
  agent: AgentStatus | null;
  artifacts?: Artifact[];
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  id: string;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface InputRequest {
  id: string;
  taskId: string;
  question: string;
  choices: string[] | null;
  allowCustom: boolean;
  status: string;
  answer: string | null;
}

export type ReviewVerdict = "approved" | "changes_requested";

/** One step of a run's execution trace — the prompt/context we handed down, a tool the agent invoked
 *  (with its input), a tool result, or the terminal outcome. The "what happened, in depth" record. */
export interface RunStep {
  id: string;
  runId: string;
  taskId: string;
  seq: number;
  kind: "prompt" | "tool" | "tool_result" | "text" | "result";
  tool: string | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

/** One execution of the agent against a task — the "where/how it worked" metadata. `steps` is the
 *  execution trace, present on the debug snapshot (GET /api/tasks/:id/debug) and absent elsewhere. */
export interface Run {
  id: string;
  taskId: string;
  projectId: string | null;
  sessionId: string | null;
  executor: string;
  model: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseRef: string | null;
  status: "starting" | "running" | "done" | "failed";
  pid: number | null;
  result: unknown | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  steps?: RunStep[];
}

/** QA bug lifecycle — the dashboard side of the capture extension. Distinct from task Status. */
export type BugStatus = "open" | "in_progress" | "resolved" | "not_a_bug" | "wont_fix";

/** QA bug severity — includes `critical`, unlike task Severity. */
export type BugSeverity = "low" | "medium" | "high" | "critical";

/** Who the reporter was logged in as on the captured page — or an explicit logged-out marker. Open-ended
 *  (the extension may add fields); the dashboard reads `loggedIn` / `email` / `tokenPreview`. */
export interface BugIdentity {
  loggedIn?: boolean;
  email?: string | null;
  tokenPreview?: string | null;
  [key: string]: unknown;
}

/** A marked moment on the session-recording clock — "this is the bug". `t` is epoch ms (same wall clock
 *  as the rrweb event timestamps), so the player maps it to a scrubber offset via its metadata startTime. */
export interface BugMarker {
  t: number;
  label?: string;
}

/** One navigation captured during the recording — a full page load or an SPA route change. `t` is epoch ms. */
export interface BugVisit {
  t: number;
  url: string;
  title?: string;
}

/** The recording window + how it was captured: an always-on rolling buffer or a deliberate start/stop. */
export interface BugRecording {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  mode?: "rolling" | "explicit" | string;
}

/** Small capture metadata that rides in the bug's `meta_json` (no columns). Known replay fields are typed;
 *  the index signature keeps it open-ended and lets the Details card still enumerate unknown keys. */
export interface BugMeta {
  markers?: BugMarker[];
  visits?: BugVisit[];
  recording?: BugRecording;
  pageTitle?: string;
  userAgent?: string;
  viewport?: { w: number; h: number };
  [key: string]: unknown;
}

/** One timestamped network call in `network.json` — synced to the replay clock so the panel can highlight
 *  the requests in flight at the playhead. Bodies are capped upstream (req 10KB, resp 50KB). */
export interface NetEntry {
  id: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  type?: string;
}

/** The `session.json` artifact — rrweb's `record()` output plus the capture window. `events` is passed
 *  straight to rrweb-player. Typed loosely here (unknown[]) so this module needn't depend on rrweb. */
export interface RrwebSession {
  events: unknown[];
  startedAt?: number;
  endedAt?: number;
}

/** A filed bug ticket. Mirrors hydrate() in src/bugs/bugs.js — the binary artifacts (screenshot / DOM /
 *  network) live on UploadThing; the row carries only their keys. */
export interface Bug {
  id: string;
  humanId: string;
  reporterId: string;
  projectId: string | null;
  teamId: string | null;
  pageUrl: string;
  title: string;
  description: string;
  status: BugStatus;
  severity: BugSeverity;
  assigneeId: string | null;
  resolution: string | null;
  screenshotKey: string | null;
  domKey: string | null;
  networkKey: string | null;
  /** The rrweb session-recording artifact key — the scrubbable replay. Null on bugs filed before replay. */
  sessionKey: string | null;
  identity: BugIdentity;
  meta: BugMeta;
  createdAt: number;
  updatedAt: number;
}

/** One entry in a bug's history — created / status / comment / assign. Mirrors listBugEvents(). */
export interface BugEvent {
  id: string;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** Per-reporter rollup for the profile card. Mirrors bugStatsForUser(). */
export interface BugStats {
  reported: number;
  resolved: number;
  open: number;
}

/** A comment on a task — the human's channel for steering the agent (plan feedback, direction). */
export interface Comment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  anchor: string;
  createdAt: number;
  seenAt: number | null;
}
