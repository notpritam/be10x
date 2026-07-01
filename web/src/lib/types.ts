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

export interface Member {
  userId: string;
  displayName: string | null;
  email: string | null;
  role: TeamRole;
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
  todos?: string[];
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

/** One execution of the agent against a task — the "where/how it worked" metadata. */
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
