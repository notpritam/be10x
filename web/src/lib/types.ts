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
  /** `error` = auto-marker synthesized at a captured error moment; `user` (or absent) = a hand-placed pin.
   *  The replay + marker list style error pins in a warning color so failures stand out from intentional marks. */
  kind?: "user" | "error";
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

/** One console line captured during the recording. `ts` is epoch ms (same wall clock as the replay events), so
 *  the fullscreen activity rail can position it on the timeline. Shared contract with the capture extension —
 *  it populates `meta.console` with exactly this shape; undefined/empty on bugs filed before console capture. */
export type ConsoleEntry = { ts: number; level: "log" | "info" | "warn" | "error" | "debug"; text: string };

/** One freehand annotation the reporter drew over the page during the recording. `points` are normalized to
 *  the captured viewport (0..1), so the replay overlay scales them onto the stage at any zoom; `ts`/`tEnd` are
 *  epoch ms (replay wall clock), so a stroke surfaces at the moment it was drawn. Shared contract with the
 *  capture extension — undefined/empty on bugs filed before drawing capture. */
export type DrawStroke = {
  ts: number;
  tEnd: number;
  color: string;
  width: number;
  points: { x: number; y: number }[];
};

/** The login the reporter used while reproducing the bug — entered by hand in the report form so a developer
 *  can sign in with the same account. Surfaced on the bug (password masked by default). Shared contract with
 *  the capture extension; absent on bugs where the reporter didn't provide one. */
export interface TestCredentials {
  username?: string;
  password?: string;
  notes?: string;
}

/** One loaded resource from the page's PerformanceResourceTiming manifest. Bytes are 0 for cross-origin
 *  resources served without Timing-Allow-Origin. Shared contract with the capture extension. */
export interface SourceResource {
  url: string;
  type?: string;
  transferBytes?: number;
  encodedBytes?: number;
  decodedBytes?: number;
  durationMs?: number;
  startMs?: number;
}

/** The page's source bundle (`source.json` artifact) — rendered HTML + inline script/style text + external
 *  references + the resource manifest, so a dev can read the markup/JS that shipped. Bounded caps upstream. */
export interface BugSource {
  html?: string;
  htmlBytes?: number;
  htmlTruncated?: boolean;
  scripts?: { type?: string; bytes: number; text: string; truncated?: boolean }[];
  styles?: { bytes: number; text: string; truncated?: boolean }[];
  stylesheets?: string[];
  externalScripts?: { src: string; type?: string; async?: boolean; defer?: boolean }[];
  resources?: SourceResource[];
  resourceCount?: number;
  resourcesTruncated?: boolean;
  capturedAt?: number;
}

/** The reporter's device + browser + page-load environment, captured at report time. Every field is
 *  best-effort/optional. Shared contract with the capture extension (`meta.environment`); the dashboard
 *  parses `userAgent`/`brands` into a browser+OS line and renders the rest as a facts grid. */
export interface BugEnvironment {
  userAgent?: string;
  platform?: string;
  brands?: string[];
  mobile?: boolean;
  language?: string;
  languages?: string[];
  timezone?: string;
  online?: boolean;
  cores?: number;
  memoryGb?: number;
  screen?: { w: number; h: number; dpr: number; colorDepth?: number };
  connection?: { effectiveType?: string; downlinkMbps?: number; rttMs?: number; saveData?: boolean };
  performance?: { ttfbMs?: number; domInteractiveMs?: number; domContentLoadedMs?: number; loadMs?: number; fcpMs?: number };
  capturedAt?: number;
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
  /** The QA reporter's free-text investigation notes, surfaced as a card on the bug. */
  notes?: string;
  /** Elements the reporter picked on the page — highlighted over the replay/snapshot. */
  pickedElements?: PickedElement[];
  /** Console output captured during the recording, in time order — surfaced in the fullscreen activity rail.
   *  Populated by the capture extension; undefined/empty on bugs filed before console capture. */
  console?: ConsoleEntry[];
  /** Freehand annotations the reporter drew over the page — replayed as a synced overlay on the recording. */
  drawings?: DrawStroke[];
  /** The login the reporter used while reproducing — surfaced as its own card (password masked by default). */
  credentials?: TestCredentials;
  /** The reporter's device/browser/page-load environment — surfaced as an "Environment" card. */
  environment?: BugEnvironment;
  /** Count of error-level console entries captured in the recording window — drives the "N errors" chip. */
  errorCount?: number;
  [key: string]: unknown;
}

/** One message exchanged over a captured WebSocket. `t` is epoch ms (same wall clock as the replay). */
export interface WsFrame {
  dir: "send" | "recv";
  data: string;
  t: number;
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
  /** How the call was made — drives special rendering (WebSocket frames). Older captures omit it. */
  kind?: "fetch" | "xhr" | "ws";
  /** The recorder caps bodies (req 10KB / resp 50KB); these flag a clipped payload so the UI can say so. */
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  /** For `kind: "ws"` — the messages sent/received over the socket, in capture order. */
  frames?: WsFrame[];
}

/** One element the QA reporter picked on the captured page — its selector identity, on-page geometry, and
 *  (when the page was a React app the extension could introspect) the owning component + props. `rect` is in
 *  page pixels, so the replay/snapshot overlay maps it onto the scaled stage. All but the core fields are
 *  optional — older captures and non-React pages omit them. */
export interface PickedElement {
  selector: string;
  xpath?: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  /** Epoch ms when the reporter picked this element (same wall clock as the replay). Lets the picked-elements
   *  panel seek the player to the capture moment. Shared contract with the extension; older captures omit it. */
  ts?: number;
  /** The reporter's note on why this element matters — surfaced under the element in the picked-elements panel. */
  note?: string;
  react?: {
    component?: string;
    props?: Record<string, unknown>;
    source?: string;
    chain?: string[];
  };
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
  /** Free-form triage labels set by the reporter — routes the bug to whoever owns that tag. [] when none. */
  tags: string[];
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
  /** The page-source bundle artifact key (source.json: HTML + inline scripts/styles + resource manifest). */
  sourceKey: string | null;
  /** The agent-board task this bug was handed off to be fixed in ("send to an agent to fix"), or null. */
  taskId: string | null;
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
