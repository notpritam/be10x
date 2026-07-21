// ABOUTME: The at-a-glance "what state is this agent in" pill — working / waiting / blocked / done, and
// ABOUTME: stalled (derived: working but no heartbeat for a while). Ticks a local clock so the age stays live.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentPhase } from "@/lib/types";

// A working session silent this long is presumed stuck — mirrors the board's GFA_STATUS_STALE_MS (5 min).
const STALE_MS = 5 * 60_000;

type Display = "working" | "waiting" | "blocked" | "done" | "stalled" | "queued";

const STYLE: Record<Display, { dot: string; text: string; ring: string; label: string; live?: boolean }> = {
  working: { dot: "bg-emerald-500", text: "text-emerald-600", ring: "ring-emerald-500/20", label: "Working", live: true },
  waiting: { dot: "bg-sky-500", text: "text-sky-600", ring: "ring-sky-500/20", label: "Needs you" },
  blocked: { dot: "bg-red-500", text: "text-red-600", ring: "ring-red-500/20", label: "Blocked" },
  stalled: { dot: "bg-amber-500", text: "text-amber-600", ring: "ring-amber-500/20", label: "Stalled" },
  done: { dot: "bg-muted-foreground/50", text: "text-muted-foreground", ring: "ring-border", label: "Done" },
  queued: { dot: "bg-muted-foreground/40", text: "text-muted-foreground", ring: "ring-border", label: "Queued" },
};

const PHASE_LABEL: Record<AgentPhase, string> = {
  research: "Research", plan: "Plan", implement: "Implement", verify: "Verify", ship: "Ship",
};

function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function SessionStateBadge({
  state,
  phase,
  updatedAt,
  stalled,
  showPhase = true,
  className,
}: {
  state?: string | null;
  phase?: AgentPhase | null;
  updatedAt?: number | null;
  /** Server-derived stalled; if omitted we derive it from state + age. */
  stalled?: boolean;
  showPhase?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const isWorking = state === "working";
  useEffect(() => {
    if (!isWorking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isWorking]);

  if (!state) return null;
  const age = updatedAt ? now - updatedAt : null;
  const isStalled = stalled ?? (isWorking && age != null && age > STALE_MS);
  const key: Display = isStalled ? "stalled" : (state in STYLE ? (state as Display) : "queued");
  const s = STYLE[key];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        s.ring, s.text, className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {s.live && !isStalled && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", s.dot)} />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", s.dot)} />
      </span>
      {showPhase && phase ? `${PHASE_LABEL[phase]} · ${s.label}` : s.label}
      {age != null && (key === "working" || key === "stalled") && (
        <span className="tabular-nums opacity-60">{relAge(age)}</span>
      )}
    </span>
  );
}
