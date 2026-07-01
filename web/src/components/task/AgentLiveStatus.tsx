// ABOUTME: The at-a-glance "is the agent alive right now" pill. Derives liveness from the latest run's
// status and freshness from task.agent.updatedAt (stamped on every progress write), ticking a local
// clock each second so "updated Xs ago" stays live between the 3s detail polls. This is the signal that
// answers "okay, this agent is running currently" without opening a terminal or guessing.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Run, Task } from "@/lib/types";

// Working but silent for this long → surface it (amber) so a real stall is visible, not mistaken for
// activity. Real agents go quiet for a minute or two while reading code or waiting on the model.
const QUIET_MS = 90_000;

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
  const active = run?.status === "running" || run?.status === "starting";

  // Only tick while something is live — no reason to re-render once idle/done.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const agent = task.agent;
  if (!run && !agent) return null;

  const updatedAt = agent?.updatedAt ?? run?.startedAt ?? run?.createdAt ?? null;
  const staleMs = updatedAt ? now - updatedAt : 0;

  let tone: Tone;
  let label: string;
  if (active) {
    const quiet = staleMs > QUIET_MS;
    tone = quiet ? "quiet" : "live";
    label = run?.status === "starting" ? "Agent starting" : quiet ? "Agent running · quiet" : "Agent running";
  } else if (run?.status === "failed") {
    tone = "failed";
    label = "Agent stopped";
  } else {
    tone = "idle";
    label = "Agent idle";
  }

  const message = typeof agent?.message === "string" ? agent.message : "";

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

  return (
    <div className="inline-flex max-w-full flex-col gap-1">
      {pill}
      {active && message && (
        <span className="max-w-[42ch] truncate pl-1 text-[11.5px] text-muted-foreground" title={message}>
          {agent?.step ? `${agent.step}: ` : ""}
          {message}
        </span>
      )}
    </div>
  );
}
