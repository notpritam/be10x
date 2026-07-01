// ABOUTME: Typed client for the same-origin HTTP API. Relative paths only; the session
// cookie (gfa_sid) rides along automatically because the app is served same-origin.
import type {
  AgentConfig,
  Comment,
  InputRequest,
  Member,
  MintedToken,
  ReviewVerdict,
  Severity,
  Status,
  Task,
  TaskEvent,
  TaskType,
  Team,
  TeamRole,
  TokenInfo,
  User,
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) {
    const code =
      (data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : null) || `HTTP_${res.status}`;
    throw new ApiError(code, res.status);
  }
  return data as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export interface TaskFilter {
  scope?: string;
  teamId?: string;
  status?: Status;
}

function taskQuery(filter?: TaskFilter): string {
  if (!filter) return "";
  const q = new URLSearchParams();
  if (filter.scope) q.set("scope", filter.scope);
  if (filter.teamId) q.set("teamId", filter.teamId);
  if (filter.status) q.set("status", filter.status);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export interface CreateTaskInput {
  type: TaskType;
  scope: string;
  title: string;
  content: Record<string, unknown>;
  teamId?: string | null;
  severity?: Severity;
}

export const api = {
  // Auth
  me: () => request<{ user: User }>("/api/me"),
  login: (email: string, password: string) =>
    post<{ user: User }>("/api/auth/login", { email, password }),
  signup: (email: string, displayName: string, password: string) =>
    post<{ user: User }>("/api/auth/signup", { email, displayName, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),

  // Teams
  listTeams: () => request<{ teams: Team[] }>("/api/teams"),
  createTeam: (name: string) => post<{ team: Team }>("/api/teams", { name }),

  // Team membership
  listMembers: (teamId: string) =>
    request<{ members: Member[] }>(`/api/teams/${teamId}/members`),
  addMember: (teamId: string, email: string, role?: TeamRole) =>
    post<{ member: { userId: string; role: TeamRole } }>(`/api/teams/${teamId}/members`, {
      email,
      ...(role ? { role } : {}),
    }),
  deleteTeam: (teamId: string) => del<{ ok: true }>(`/api/teams/${teamId}`),

  // Tasks
  listTasks: (filter?: TaskFilter) =>
    request<{ tasks: Task[] }>(`/api/tasks${taskQuery(filter)}`),
  getTask: (id: string) => request<{ task: Task }>(`/api/tasks/${id}`),
  createTask: (input: CreateTaskInput) => post<{ task: Task }>("/api/tasks", input),
  events: (id: string) => request<{ events: TaskEvent[] }>(`/api/tasks/${id}/events`),

  // Task actions
  transition: (id: string, to: Status) =>
    post<{ task: Task }>(`/api/tasks/${id}/transition`, { to }),
  setPlan: (id: string, plan: unknown) => post<{ task: Task }>(`/api/tasks/${id}/plan`, { plan }),
  setResearch: (id: string, research: unknown) =>
    post<{ task: Task }>(`/api/tasks/${id}/research`, { research }),
  patchContent: (id: string, patch: Record<string, unknown>) =>
    post<{ task: Task }>(`/api/tasks/${id}/content`, { patch }),
  retry: (id: string) => post<{ task: Task }>(`/api/tasks/${id}/retry`),

  // Reviews
  requestReview: (id: string, reviewerId: string) =>
    post<{ task: Task }>(`/api/tasks/${id}/review/request`, { reviewerId }),
  submitReview: (id: string, verdict: ReviewVerdict, comment?: string) =>
    post<{ review: unknown }>(`/api/tasks/${id}/review/submit`, { verdict, comment: comment ?? "" }),
  /** Tasks awaiting the current user's review. */
  pendingReviews: () => request<{ tasks: Task[] }>("/api/reviews/pending"),

  // Agent tokens & MCP config
  listTokens: () => request<{ tokens: TokenInfo[] }>("/api/tokens"),
  createToken: (name: string) => post<{ token: MintedToken }>("/api/tokens", { name }),
  revokeToken: (id: string) => del<{ ok: true }>(`/api/tokens/${id}`),
  agentConfig: () => request<AgentConfig>("/api/agent-config"),

  // Agent orchestration — hand a task to the agent, ping it to pick up now, and the comment thread it reads
  handToAgent: (id: string) => post<{ task: Task }>(`/api/tasks/${id}/hand-to-agent`),
  pickUpNow: (id: string) => post<{ ok: true; wake: unknown }>(`/api/tasks/${id}/pick-up-now`),
  listComments: (id: string) => request<{ comments: Comment[] }>(`/api/tasks/${id}/comments`),
  addComment: (id: string, body: string, anchor?: string) =>
    post<{ comment: Comment }>(`/api/tasks/${id}/comments`, { body, ...(anchor ? { anchor } : {}) }),

  // Human-in-the-loop input
  getInput: (id: string) =>
    request<{ inputRequest: InputRequest | null }>(`/api/tasks/${id}/input`),
  requestInput: (id: string, question: string, choices?: string[], allowCustom = true) =>
    post<{ inputRequest: InputRequest | null }>(`/api/tasks/${id}/input/request`, {
      question,
      choices: choices ?? null,
      allowCustom,
    }),
  answerInput: (reqId: string, answer: string) =>
    post<{ ok: true }>(`/api/input/${reqId}/answer`, { answer }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "BAD_CREDENTIALS":
        return "That email and password don't match.";
      case "EMAIL_TAKEN":
        return "An account with that email already exists.";
      case "ILLEGAL_TRANSITION":
        return "That move isn't allowed from here.";
      case "ALREADY_ANSWERED":
        return "This question was already answered.";
      case "USER_NOT_FOUND":
        return "No account found with that email.";
      case "ALREADY_MEMBER":
        return "That person is already on the team.";
      case "FORBIDDEN":
        return "You don't have permission to do that.";
      case "NETWORK":
        return "Network error. Check your connection.";
      case "NO_SESSION":
        return "Your session expired. Please sign in again.";
      default:
        return err.code.startsWith("MISSING_FIELD")
          ? "Please fill in the required fields."
          : "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
