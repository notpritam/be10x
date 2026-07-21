// ABOUTME: The single source of truth for "what is the agent doing right now" on a task. Derives a live
// ABOUTME: state from the HOOK signal (task.agent.state + heartbeat freshness) first, and only falls back
// ABOUTME: to the run row's status when hooks haven't reported yet. Both the status pill and the action
// ABOUTME: buttons read from here so they never disagree (e.g. pill "working" while a "Resume" still shows).
import type { Run, Task } from "./types";

// Working but silent for this long → surface as "quiet" (amber), a real stall isn't mistaken for activity.
const QUIET_MS = 90_000;
// Silent this much longer → presumed stuck. Mirrors the board's GFA_STATUS_STALE_MS (5 min).
const STALE_MS = 5 * 60_000;

export type LiveState =
  | "starting" // a session is spinning up; no hook heartbeat yet
  | "working" // hook says working, fresh
  | "quiet" // working but silent a while
  | "waiting" // wants the human (needs_input / hook "waiting")
  | "blocked" // hook says blocked
  | "stalled" // was working, went silent past the stall threshold
  | "failed" // the run errored out
  | "done" // hook says the session finished
  | "idle"; // nothing running

export interface LiveAgent {
  state: LiveState;
  /** A session is genuinely alive right now — offering "Pick up"/"Resume" would fight it. */
  active: boolean;
  updatedAt: number | null;
  model: string | null;
  message: string;
  step: string | null;
}

/** Resolve the live agent state for a task from its hook status + latest run. `now` is injectable for tests. */
export function liveAgentState(task: Task, runs: Run[], now: number = Date.now()): LiveAgent {
  const run = runs.length ? runs[runs.length - 1] : null;
  const agent = task.agent;
  const updatedAt = agent?.updatedAt ?? run?.startedAt ?? run?.createdAt ?? null;
  const ageMs = updatedAt != null ? now - updatedAt : null;
  const runActive = run?.status === "running" || run?.status === "starting";
  const hs = agent?.state; // hook-derived: working | waiting | blocked | done

  let state: LiveState;
  if (hs === "waiting" || task.status === "needs_input") {
    state = "waiting";
  } else if (hs === "blocked") {
    state = "blocked";
  } else if (hs === "done") {
    state = "done";
  } else if (hs === "working") {
    // The hook is the truth while it's reporting; freshness decides working / quiet / stalled.
    state = ageMs != null && ageMs > STALE_MS ? "stalled" : ageMs != null && ageMs > QUIET_MS ? "quiet" : "working";
  } else if (runActive) {
    // No hook heartbeat yet — trust the run row. "starting" only survives until the first hook write.
    state = run?.status === "starting" ? "starting" : "working";
  } else if (run?.status === "failed") {
    state = "failed";
  } else {
    state = "idle";
  }

  const active = state === "starting" || state === "working" || state === "quiet";
  const message = typeof agent?.message === "string" ? agent.message : "";
  const step = typeof agent?.step === "string" ? agent.step : null;
  return { state, active, updatedAt, model: run?.model ?? null, message, step };
}
