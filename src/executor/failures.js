// ABOUTME: Classifies WHY an ephemeral agent run died, so the runner can decide whether to auto-retry
// ABOUTME: (self-heal from an environmental blip) or surface it for a human. The GFA-003 RCA showed the
// agent's runs die overwhelmingly from the ENVIRONMENT — lost CLI auth, transient network, and process
// death on restart/sleep — not from be10x logic or the agent's own task work. Treating those as retryable
// (with backoff) is what turns "the agent keeps stopping" into "the agent resumes on its own".

// Environmental auth loss: the CLI comes up "Not logged in · Please run /login" and exits in ~1s. Retryable,
// but on a LONG backoff — it only clears once a human sets a key or re-logs in, so hammering it just spams.
const AUTH_RE =
  /not logged in|please run \/login|invalid api key|authentication[_ ]?error|unauthorized|\b401\b|no api key|api key[^.]*\b(missing|invalid|expired)\b|oauth/i;
// Transient network / upstream: usually clears on its own within seconds — retry fast.
const NETWORK_RE =
  /econnreset|econnrefused|connection ?refused|unable to connect|etimedout|esockettimedout|socket hang ?up|enotfound|eai_again|network ?error|\b50[234]\b|overloaded|\b429\b|rate.?limit|timed? ?out/i;
// The process died before it could finish: server restart, laptop sleep, OOM kill. Retryable — resume from
// durable state. The generic "exited without a result" also lands here (it's almost always a process death).
const CRASH_RE = /orphaned|process gone|sigterm|sigkill|killed|exited without a result|spawn error|exited \(code/i;

export const FAILURE_KINDS = ['auth', 'network', 'crash', 'other'];

// Best-effort classification from the failure text we captured (CLI result payload / last assistant line /
// stderr). Order matters: auth before network (a 401 is auth, not a generic 4xx).
export function classifyFailure(text) {
  const s = String(text ?? '');
  if (AUTH_RE.test(s)) return 'auth';
  if (NETWORK_RE.test(s)) return 'network';
  if (CRASH_RE.test(s)) return 'crash';
  return 'other';
}

// Which kinds self-heal on retry. 'other' (a genuine code/logic error) is NOT retried — that would loop on
// a real bug; the human sees it and decides.
const RETRYABLE = new Set(['auth', 'network', 'crash']);
export function isRetryable(kind) {
  return RETRYABLE.has(kind);
}

// How many auto-retries before giving up and surfacing it. Auth gets fewer (it needs a human to fix the
// credential) but is still retried a couple of times to ride out a token refresh.
export function maxAttempts(kind) {
  return kind === 'auth' ? 3 : 6;
}

// Backoff before the next retry. Network/crash: fast exponential (2s, 4s, 8s… capped at 60s) to ride out a
// blip. Auth: a fixed 30s — long enough not to spam, short enough to self-heal within ~30s of a human fix.
export function backoffMs(kind, attempt) {
  if (kind === 'auth') return 30_000;
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

// A human-facing, ACTIONABLE line for the board — what to do, not just what broke.
export function guidance(kind) {
  switch (kind) {
    case 'auth':
      return 'the agent is not authenticated — set ANTHROPIC_API_KEY (or run `claude` then /login) on the be10x host, then Pick up now';
    case 'network':
      return 'a network/upstream error hit the agent — retrying automatically';
    case 'crash':
      return 'the agent process died before finishing (a restart or the machine sleeping) — resuming automatically';
    default:
      return null;
  }
}
