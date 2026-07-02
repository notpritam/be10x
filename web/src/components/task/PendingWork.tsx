// ABOUTME: The "queued work" indicator — shows wakes that are enqueued but not yet claimed, so the human
// can SEE what the agent will pick up next (and that a message they posted is waiting). Nothing stalls:
// the runner works one session per task and claims the next wake when the current run ends. This makes
// that queue visible instead of leaving it buried in the debug panel.
import { useEffect, useState } from "react";
import { ArrowRightToLine, Clock3, MessageSquareText } from "lucide-react";
import type { WakeEntry } from "@/lib/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// Human-readable name for each wake reason (the executor's mode vocabulary).
const REASON_LABEL: Record<string, string> = {
  plan: "Plan",
  revise: "Revise plan",
  execute: "Implement",
  verify: "Verify",
  pick_up_now: "Pick up now",
  input_answer: "Your answer",
  follow_up: "Follow-up",
  chat: "Reply",
};

function ctxComment(w: WakeEntry): string | null {
  const c = (w.context as { comment?: unknown } | null)?.comment;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

function label(w: WakeEntry): string {
  return ctxComment(w) ? "Your message" : REASON_LABEL[w.reason] ?? w.reason;
}

// Poll the pending wakes for a task. Prefers the lightweight /wakes endpoint; falls back to deriving them
// from the debug snapshot so the indicator works even before a server restart exposes /wakes. One fetch,
// shared by the full + compact renders via the caller.
export function useTaskWakes(taskId: string | null): WakeEntry[] {
  const [wakes, setWakes] = useState<WakeEntry[]>([]);
  useEffect(() => {
    if (!taskId) {
      setWakes([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await api.wakes(taskId);
        if (alive) setWakes(r.wakes);
      } catch {
        try {
          const d = await api.taskDebug(taskId);
          if (alive) setWakes(d.wakes.filter((w) => w.pending));
        } catch {
          /* transient — keep the last good value */
        }
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [taskId]);
  return wakes;
}

export function PendingWork({
  wakes,
  agentActive,
  compact = false,
}: {
  wakes?: WakeEntry[];
  /** Whether a run is in flight — decides "runs after the current step" vs "starting now…". */
  agentActive?: boolean;
  compact?: boolean;
}) {
  const pending = (wakes ?? []).filter((w) => w.pending !== false);
  if (pending.length === 0) return null;
  const when = agentActive ? "runs when the current step finishes" : "starting now…";

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11.5px] text-amber-700">
        <PingDot />
        <span className="shrink-0 font-semibold">
          {pending.length} queued
        </span>
        <span className="min-w-0 flex-1 truncate text-amber-700/80">
          · {pending.map(label).join(", ")} — {when}
        </span>
      </div>
    );
  }

  return (
    <section className="rounded-[10px] border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <PingDot />
        <h3 className="text-[12.5px] font-semibold text-amber-800">
          {pending.length} {pending.length > 1 ? "actions" : "action"} queued
        </h3>
        <span className="ml-auto text-[11px] text-amber-700/70">{when}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {pending.map((w, i) => {
          const comment = ctxComment(w);
          const Icon = comment ? MessageSquareText : ArrowRightToLine;
          return (
            <li key={w.id ?? i} className="flex items-center gap-2 text-[12px] text-amber-900/90">
              <Icon className="size-3.5 shrink-0 text-amber-600" />
              <span className="shrink-0 font-medium">{label(w)}</span>
              {comment && <span className="min-w-0 truncate text-amber-700/70">— “{comment}”</span>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-700/70">
        <Clock3 className="size-3" />
        Queued work is durable — it runs in order, even across a restart.
      </p>
    </section>
  );
}

// A small amber "live queue" dot with a ping halo.
function PingDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className={cn("absolute inline-flex size-full rounded-full bg-amber-500/60", "animate-ping")} />
      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
    </span>
  );
}
