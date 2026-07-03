// ABOUTME: Typed client for the same-origin HTTP API. Relative paths only; the session
// cookie (gfa_sid) rides along automatically because the app is served same-origin.
import type {
  AgentConfig,
  Artifact,
  Comment,
  FsListing,
  InputRequest,
  Isolation,
  LeaderboardRow,
  Member,
  MintedToken,
  Project,
  ReviewVerdict,
  Run,
  Severity,
  Status,
  Task,
  TaskDebug,
  TaskEvent,
  TaskType,
  Team,
  TeamRole,
  TokenInfo,
  User,
  UserLite,
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

function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  /** Which linked repo the agent works this task in. */
  projectId?: string | null;
  /** Isolation: a fresh worktree (default) or the repo root in place. */
  isolation?: Isolation;
  /** Hand straight to the agent (→ researching + a plan wake) on create. */
  handOff?: boolean;
}

/** What the bearer of a share link may do: comment/review only, or also run the agent. */
export type SharePermission = "comment_only" | "run_agent";

/** A verdict a shared reviewer can leave — Approve / Request changes / Reject. */
export type ShareVerdict = "approved" | "changes_requested" | "rejected";

/** A minted share link, as returned by the backend (raw row — snake_case). The token IS the credential. */
export interface ShareLink {
  id: string;
  task_id: string;
  token: string;
  permission: SharePermission;
  created_by: string | null;
  created_at: number;
  /** Non-null once revoked — the token then reads as gone. */
  revoked_at: number | null;
}

/** The public, token-scoped view behind a valid link: the task header, its plan, the agent's visual
 *  artifacts (RCA / diagrams / findings), and the discussion. */
export interface ShareView {
  task: { id: string; humanId: string; title: string; status: Status; type: TaskType };
  plan: unknown;
  artifacts?: Artifact[];
  comments: Comment[];
}

/** One saved snapshot of a task's plan — powers the version history / restore UI. */
export interface PlanVersion {
  id: string;
  plan: unknown;
  createdBy: string | null;
  createdAt: number;
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

  // Leaderboard — tasks completed + tokens through be10x. scope: "all" or `team:<id>`; period: "all" or "month".
  leaderboard: (scope: string = "all", period: "all" | "month" = "all") =>
    request<{ scope: string; period: string; rows: LeaderboardRow[] }>(
      `/api/leaderboard?scope=${encodeURIComponent(scope)}&period=${period}`,
    ),

  // Team membership
  listMembers: (teamId: string) =>
    request<{ members: Member[] }>(`/api/teams/${teamId}/members`),
  addMember: (teamId: string, email: string, role?: TeamRole) =>
    post<{ member: { userId: string; role: TeamRole } }>(`/api/teams/${teamId}/members`, {
      email,
      ...(role ? { role } : {}),
    }),
  /** Add a known user (from search / recent quick-add) by id — no email typing. */
  addMemberById: (teamId: string, userId: string, role?: TeamRole) =>
    post<{ member: { userId: string; role: TeamRole } }>(`/api/teams/${teamId}/members`, {
      userId,
      ...(role ? { role } : {}),
    }),
  setMemberRole: (teamId: string, userId: string, role: TeamRole) =>
    patch<{ ok: true }>(`/api/teams/${teamId}/members/${userId}`, { role }),
  removeMember: (teamId: string, userId: string) =>
    del<{ ok: true }>(`/api/teams/${teamId}/members/${userId}`),
  deleteTeam: (teamId: string) => del<{ ok: true }>(`/api/teams/${teamId}`),

  // Find people on the platform to add to a team.
  searchUsers: (q: string, excludeTeam?: string) => {
    const p = new URLSearchParams({ q });
    if (excludeTeam) p.set("excludeTeam", excludeTeam);
    return request<{ users: UserLite[] }>(`/api/users/search?${p.toString()}`);
  },
  /** People you've recently worked with — quick-add chips. */
  recentPeople: (excludeTeam?: string) => {
    const p = new URLSearchParams();
    if (excludeTeam) p.set("excludeTeam", excludeTeam);
    const qs = p.toString();
    return request<{ users: UserLite[] }>(`/api/users/recent${qs ? `?${qs}` : ""}`);
  },

  // Projects (linked repos)
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  /** Register a git repo on the server by absolute path (writes its .be10x/mcp.json). Personal unless
   *  teamId is given, in which case it's shared with that team (caller must already be a member). */
  addProject: (path: string, teamId?: string | null) =>
    post<{ project: Project }>("/api/projects", { path, ...(teamId ? { teamId } : {}) }),
  /** Browse the server's directories for the folder picker (defaults to the server user's home). */
  browseDirs: (path?: string) =>
    request<FsListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  // Tasks
  listTasks: (filter?: TaskFilter) =>
    request<{ tasks: Task[] }>(`/api/tasks${taskQuery(filter)}`),
  getTask: (id: string) => request<{ task: Task }>(`/api/tasks/${id}`),
  createTask: (input: CreateTaskInput) => post<{ task: Task }>("/api/tasks", input),
  events: (id: string) => request<{ events: TaskEvent[] }>(`/api/tasks/${id}/events`),
  /** The agent's execution history for a task — branch, model, session, status, timing. */
  listRuns: (id: string) => request<{ runs: Run[] }>(`/api/tasks/${id}/runs`),
  /** Consolidated raw state for the debug view — agent, runs, wake queue, events, server clock. */
  taskDebug: (id: string) => request<TaskDebug>(`/api/tasks/${id}/debug`),

  // Task actions
  transition: (id: string, to: Status) =>
    post<{ task: Task }>(`/api/tasks/${id}/transition`, { to }),
  setPlan: (id: string, plan: unknown) => post<{ task: Task }>(`/api/tasks/${id}/plan`, { plan }),
  /** Plan version history + restore (snapshots taken on every setPlan). */
  listPlanVersions: (id: string) => request<{ versions: PlanVersion[] }>(`/api/tasks/${id}/plan-versions`),
  restorePlanVersion: (id: string, versionId: string) =>
    post<{ task: Task }>(`/api/tasks/${id}/plan-versions/${versionId}/restore`),
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

  // Device authorization — the browser half of `be10x login`. The approve screen (/connect?code=…) fetches
  // what's asking, then the signed-in user authorizes (minting the machine a token) or denies it.
  devicePending: (code: string) =>
    request<{ userCode: string; label: string | null; status: string; createdAt: number }>(
      `/api/device/pending?code=${encodeURIComponent(code)}`,
    ),
  deviceApprove: (code: string) => post<{ ok: true; label: string | null }>("/api/device/approve", { code }),
  deviceDeny: (code: string) => post<{ ok: true }>("/api/device/deny", { code }),

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

  // Shareable, permissioned review links.
  // Owner-only (session): mint / list / revoke a task's links.
  createShareLink: (taskId: string, permission: SharePermission) =>
    post<{ share: ShareLink }>(`/api/tasks/${taskId}/share`, { permission }),
  listShares: (taskId: string) => request<{ shares: ShareLink[] }>(`/api/tasks/${taskId}/shares`),
  revokeShare: (token: string) => del<{ ok: true }>(`/api/share/${encodeURIComponent(token)}`),
  // Public (no session — the token is the credential): view, comment, review, and (if permitted) run the agent.
  getShare: (token: string) => request<ShareView>(`/api/share/${encodeURIComponent(token)}`),
  shareComment: (token: string, author: string, body: string) =>
    post<{ comment: Comment }>(`/api/share/${encodeURIComponent(token)}/comment`, { author, body }),
  shareReview: (token: string, verdict: ShareVerdict, comment: string, author: string) =>
    post<{ ok: true }>(`/api/share/${encodeURIComponent(token)}/review`, { verdict, comment, author }),
  /** Ask the owner's agent to pick the task up now. 403 FORBIDDEN when the link is comment-only. */
  shareRunAgent: (token: string, message: string, author: string) =>
    post<{ ok: true; wake: unknown }>(`/api/share/${encodeURIComponent(token)}/run-agent`, { message, author }),
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
      case "NO_SUCH_PATH":
        return "That folder doesn't exist on the server.";
      case "NOT_A_GIT_REPO":
        return "That folder isn't a git repo — run `git init` there first.";
      case "ALREADY_MEMBER":
        return "That person is already on the team.";
      case "FORBIDDEN":
        return "You don't have permission to do that.";
      case "NO_SUCH_SHARE":
        return "This link is no longer active — it may have been revoked.";
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
