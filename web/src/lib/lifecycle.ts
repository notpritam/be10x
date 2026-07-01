// ABOUTME: The lifecycle state machine, mirrored from the backend. The board IS this machine:
// dragging a card to a column is a transition, and only legal moves are allowed to hit the API.
import type { Status } from "./types";

/** Columns shown on the board, in order. */
export const BOARD_COLUMNS: Status[] = [
  "backlog",
  "researching",
  "plan_review",
  "ready_to_work",
  "in_progress",
  "needs_input",
  "verifying",
  "done",
];

/** The happy-path lane rendered by the lifecycle strip in the detail panel. */
export const LIFECYCLE_LANE: Status[] = [
  "backlog",
  "researching",
  "plan_review",
  "ready_to_work",
  "in_progress",
  "verifying",
  "done",
];

/** Legal NEXT states per status — identical to src/tasks/lifecycle.js. */
export const TRANSITIONS: Record<Status, Status[]> = {
  backlog: ["researching", "ready_to_work", "not_a_bug", "wont_fix", "blocked"],
  researching: ["plan_review", "blocked"],
  plan_review: ["researching", "ready_to_work", "not_a_bug", "wont_fix", "blocked"],
  ready_to_work: ["in_progress", "plan_review", "blocked"],
  in_progress: ["needs_input", "verifying", "plan_review", "blocked"],
  needs_input: ["in_progress", "blocked"],
  verifying: ["done", "in_progress", "plan_review"],
  blocked: ["backlog", "researching", "plan_review", "ready_to_work", "in_progress"],
  done: [],
  not_a_bug: [],
  wont_fix: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function legalMoves(from: Status): Status[] {
  return TRANSITIONS[from] ?? [];
}

export interface StatusMeta {
  /** Sentence-case label. */
  label: string;
  /** CSS custom property carrying the status hue. */
  color: string;
  /** Verb-forward label for a "move to" action button. */
  moveVerb: string;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  backlog: { label: "Backlog", color: "var(--status-backlog)", moveVerb: "Move to backlog" },
  researching: { label: "Researching", color: "var(--status-researching)", moveVerb: "Start research" },
  plan_review: { label: "Plan review", color: "var(--status-plan_review)", moveVerb: "Send to plan review" },
  ready_to_work: { label: "Ready to work", color: "var(--status-ready_to_work)", moveVerb: "Mark ready to work" },
  in_progress: { label: "In progress", color: "var(--status-in_progress)", moveVerb: "Start work" },
  needs_input: { label: "Needs input", color: "var(--status-needs_input)", moveVerb: "Ask for input" },
  verifying: { label: "Verifying", color: "var(--status-verifying)", moveVerb: "Send to verify" },
  done: { label: "Done", color: "var(--status-done)", moveVerb: "Mark done" },
  blocked: { label: "Blocked", color: "var(--status-blocked)", moveVerb: "Block" },
  not_a_bug: { label: "Not a bug", color: "var(--status-not_a_bug)", moveVerb: "Not a bug" },
  wont_fix: { label: "Won't fix", color: "var(--status-wont_fix)", moveVerb: "Won't fix" },
};

export function statusLabel(status: Status): string {
  return STATUS_META[status]?.label ?? status;
}
