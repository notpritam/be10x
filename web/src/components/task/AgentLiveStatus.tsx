// ABOUTME: The at-a-glance "is the agent alive right now" pill. Derives liveness from the latest run's
// status and freshness from task.agent.updatedAt (stamped on every progress write), ticking a local
// clock each second so "updated Xs ago" stays live between the 3s detail polls. This is the signal that
// answers "okay, this agent is running currently" without opening a terminal or guessing.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Run, Task } from "@/lib/types";
import { liveAgentState, type LiveState } from "@/lib/agent-state";

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

type Tone = "live" | "quiet" | "failed" | "idle";

const DOT: Record<Tone, string> = {
  live: "bg-emerald-500",
  quiet: "bg-amber-500",
  failed: "bg-red-500",
  idle: "bg-muted-foreground/50",
};
const TEXT: Record<Tone, string> = {
  live: "text-emerald-600",
  quiet: "text-amber-600",
  failed: "text-red-600",
  idle: "text-muted-foreground",
};

// Map the hook-derived live state → how the pill reads. Keeping this next to the tones makes it obvious
// that "Agent starting" only survives until the first hook heartbeat flips us to "working".
const PRESENTATION: Record<LiveState, { tone: Tone; label: string }> = {
  starting: { tone: "live", label: "Agent starting" },
  working: { tone: "live", label: "Agent working" },
  quiet: { tone: "quiet", label: "Agent working · quiet" },
  waiting: { tone: "quiet", label: "Waiting for your input" },
  blocked: { tone: "quiet", label: "Agent blocked" },
  stalled: { tone: "quiet", label: "Agent stalled" },
  failed: { tone: "failed", label: "Agent stopped" },
  done: { tone: "idle", label: "Agent finished" },
  idle: { tone: "idle", label: "Agent idle" },
};

export function AgentLiveStatus({
  task,
  runs,
  compact = false,
}: {
  task: Task;
  runs: Run[];
  /** Header mode: render just the pill on one line (no activity subline). */
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const run = runs.length ? runs[runs.length - 1] : null;
  const agent = task.agent;
  const live = liveAgentState(task, runs, now);
  const active = live.active;

  // Only tick while something is live — no reason to re-render once idle/done.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  if (!run && !agent) return null;

  const updatedAt = live.updatedAt;
  const staleMs = updatedAt ? now - updatedAt : 0;
  const { tone, label } = PRESENTATION[live.state];

  const message = live.message;

  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold",
        tone === "live" && "border-emerald-500/25 bg-emerald-500/10",
        tone === "quiet" && "border-amber-500/25 bg-amber-500/10",
        tone === "failed" && "border-red-500/25 bg-red-500/10",
        tone === "idle" && "border-border/70 bg-card",
        TEXT[tone],
      )}
      title={compact && message ? message : undefined}
    >
      <span className="relative flex size-2">
        {active && (
          <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-75", DOT[tone])} />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
      </span>
      {label}
      {/* Compact (panel header) shows just the dot + label — the model + time would eat the width. */}
      {!compact && run?.model && (
        <span className="rounded bg-background/60 px-1.5 py-px font-mono text-[10px] font-medium opacity-80">
          {run.model}
        </span>
      )}
      {!compact && updatedAt && <span className="font-normal opacity-70">· {ago(staleMs)}</span>}
    </span>
  );

  // Header mode: just the pill, one line. (The full activity line lives in the body's Agent section.)
  if (compact) return pill;

  // Full mode: a readable status CARD — state, model, elapsed, and the current step/message wrapped over
  // a couple of lines (not truncated to an unreadable sliver). This is the "what's it doing right now" card.
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        tone === "live" && "border-emerald-500/25 bg-emerald-500/[0.06]",
        tone === "quiet" && "border-amber-500/25 bg-amber-500/[0.06]",
        tone === "failed" && "border-red-500/25 bg-red-500/[0.06]",
        tone === "idle" && "border-border/70 bg-card",
      )}
    >
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="relative flex size-2 shrink-0">
          {active && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-75", DOT[tone])} />}
          <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
        </span>
        <span className={cn("font-semibold", TEXT[tone])}>{label}</span>
        {run?.model && (
          <span className="rounded bg-background/70 px-1.5 py-px font-mono text-[10px] font-medium text-muted-foreground">
            {run.model}
          </span>
        )}
        {updatedAt && <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground">{ago(staleMs)}</span>}
      </div>
      {message && (
        <p className="mt-1.5 text-[12px] leading-snug text-foreground/80 line-clamp-3">
          {agent?.step ? <b className="font-semibold text-foreground/90">{agent.step}: </b> : null}
          {message}
        </p>
      )}
    </div>
  );
}
