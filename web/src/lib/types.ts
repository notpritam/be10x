// ABOUTME: Shared domain types mirroring the backend HTTP contract.

export type TaskType = "general" | "code-issue";
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
  [key: string]: unknown;
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
