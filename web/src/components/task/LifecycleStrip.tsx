// ABOUTME: The lifecycle flow strip — the happy-path lane with the current state highlighted.
// Side states (needs_input / blocked / closed) anchor to the nearest lane step and show a chip.
import { LIFECYCLE_LANE, STATUS_META } from "@/lib/lifecycle";
import type { Status } from "@/lib/types";
import { cn } from "@/lib/utils";

const LANE_LABEL: Partial<Record<Status, string>> = {
  backlog: "Backlog",
  researching: "Research",
  plan_review: "Plan",
  ready_to_work: "Ready",
  in_progress: "Progress",
  verifying: "Verify",
  done: "Done",
};

function sideChip(status: Status): { label: string; className: string } | null {
  switch (status) {
    case "needs_input":
      return { label: "Paused, waiting on your input", className: "bg-[#fdf0da] text-[#b16207]" };
    case "blocked":
      return { label: "Blocked", className: "bg-[#fde8e8] text-[#c0392b]" };
    case "not_a_bug":
      return { label: "Closed, not a bug", className: "bg-muted text-muted-foreground" };
    case "wont_fix":
      return { label: "Closed, won't fix", className: "bg-muted text-muted-foreground" };
    default:
      return null;
  }
}

export function LifecycleStrip({ status }: { status: Status }) {
  const laneIdx = LIFECYCLE_LANE.indexOf(status);
  const anchorIdx = status === "needs_input" ? LIFECYCLE_LANE.indexOf("in_progress") : laneIdx;
  const chip = sideChip(status);

  return (
    <div className="rounded-xl border border-border/70 bg-card p-3.5">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${LIFECYCLE_LANE.length}, minmax(0, 1fr))` }}>
        {LIFECYCLE_LANE.map((s, i) => {
          const done = anchorIdx >= 0 && i < anchorIdx;
          const current = anchorIdx >= 0 && i === anchorIdx;
          const color = STATUS_META[s].color;
          const connectorDone = anchorIdx >= 0 && i <= anchorIdx;
          return (
            <div key={s} className="relative flex flex-col items-center gap-2">
              {i > 0 && (
                <span
                  className="absolute right-1/2 top-[6px] h-[2px] w-full"
                  style={{ background: connectorDone ? color : "var(--border)", opacity: connectorDone ? 0.5 : 1 }}
                />
              )}
              <span
                className={cn(
                  "relative z-10 rounded-full transition-all",
                  current ? "size-3.5" : "size-3",
                )}
                style={
                  done || current
                    ? { background: color, boxShadow: current ? `0 0 0 4px color-mix(in oklab, ${color} 22%, transparent)` : undefined }
                    : { background: "var(--card)", border: "2px solid var(--border)" }
                }
              />
              <span
                className={cn(
                  "text-[9.5px] leading-none",
                  current
                    ? "font-bold text-foreground"
                    : done
                      ? "font-medium text-muted-foreground"
                      : "text-muted-foreground/45",
                )}
              >
                {LANE_LABEL[s]}
              </span>
            </div>
          );
        })}
      </div>

      {chip && (
        <div className="mt-3 flex justify-center">
          <span className={cn("rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", chip.className)}>
            {chip.label}
          </span>
        </div>
      )}
    </div>
  );
}
