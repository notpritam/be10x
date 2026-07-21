// ABOUTME: Pure derivation of a task's live agent-status snapshot from claude-code hook lifecycle events
// ABOUTME: (delivered inline via --include-hook-events). No I/O — the executor/recordProgress call into this.
// States: working | blocked | waiting | done. `stalled` is derived from heartbeat age at read time, never stored.

export const STALE_MS_DEFAULT = Number(process.env.GFA_STATUS_STALE_MS) || 300000; // 5 min

// Map a claude-code hook_event (+ optional response outcome) to an activity state, or null to leave state as-is.
// SessionStart/UserPromptSubmit/Pre|PostToolUse/SubagentStop = the agent is doing work (they double as the
// heartbeat). Notification = it needs a human. Stop = the turn ended. A deny/error tool outcome = blocked.
export function hookEventToActivity(hookEvent, outcome) {
  if (outcome === 'blocked' || outcome === 'error' || outcome === 'deny' || outcome === 'denied') return 'blocked';
  switch (hookEvent) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStop':
      return 'working';
    case 'Notification':
      return 'waiting';
    case 'Stop':
    case 'SubagentStart': // (SubagentStart is 'working'-ish, but keep the catalog explicit above)
      return hookEvent === 'Stop' ? 'done' : 'working';
    default:
      return null;
  }
}

// Fold one parsed stream event into the snapshot. `ev` may carry { hookEvent, outcome, sessionId, text }.
// stateStartedAt moves ONLY when the state actually changes (so heartbeats don't reset the clock); updatedAt
// bumps on every event so freshness/stalled reflects the last sign of life.
export function deriveStatus(prev = {}, ev = {}, now = Date.now()) {
  const next = { ...prev };
  if (ev.sessionId && !next.sessionId) next.sessionId = ev.sessionId;
  if (typeof ev.text === 'string' && ev.text) next.message = ev.text;
  if (ev.hookEvent) next.lastEvent = ev.hookEvent;

  const activity = ev.hookEvent ? hookEventToActivity(ev.hookEvent, ev.outcome) : null;
  if (activity && activity !== next.state) {
    next.state = activity;
    next.stateStartedAt = now;
  } else if (activity && next.stateStartedAt == null) {
    next.stateStartedAt = now;
  }
  next.updatedAt = now;
  return next;
}

// A non-done, non-waiting session whose last heartbeat is older than staleMs is presumed stuck/dead.
// `waiting` is a deliberate human-gated pause, so it is never "stalled". Done is terminal.
export function isStalled(snap, now = Date.now(), staleMs = STALE_MS_DEFAULT) {
  if (!snap || snap.state === 'done' || snap.state === 'waiting') return false;
  const updatedAt = Number(snap.updatedAt) || 0;
  return now - updatedAt > staleMs;
}

// The executor's run "mode" → a user-facing phase label that mirrors the task flow.
export function phaseFromMode(mode) {
  switch (mode) {
    case 'plan':
    case 'revise':
      return 'plan';
    case 'verify':
      return 'verify';
    case 'research':
      return 'research';
    default:
      return 'implement';
  }
}
