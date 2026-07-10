// ABOUTME: Shared presentational atoms for the Bugs dashboard — a soft status badge (colored dot + label)
// ABOUTME: and a severity pill that reuses the app's pill-* classes (with the extra `critical` tier).
import type { BugSeverity, BugStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bug status → sentence-case label + a hue. Reuses the board's --status-* custom properties where they
 *  line up; `open` and `resolved` borrow needs_input (amber) and done (green). */
export const BUG_STATUS_META: Record<BugStatus, { label: string; color: string }> = {
  open: { label: "Open", color: "var(--status-needs_input)" },
  in_progress: { label: "In progress", color: "var(--status-in_progress)" },
  resolved: { label: "Resolved", color: "var(--status-done)" },
  not_a_bug: { label: "Not a bug", color: "var(--status-not_a_bug)" },
  wont_fix: { label: "Won't fix", color: "var(--status-wont_fix)" },
};

/** The resolutions a dev can move a bug to, in the order the design lists them. */
export const BUG_STATUS_ORDER: BugStatus[] = ["open", "in_progress", "resolved", "not_a_bug", "wont_fix"];

const BUG_SEVERITY_LABEL: Record<BugSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const BUG_SEVERITY_ORDER: BugSeverity[] = ["low", "medium", "high", "critical"];

export function BugStatusBadge({ status, className }: { status: BugStatus; className?: string }) {
  const meta = BUG_STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-foreground",
        className,
      )}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function BugSeverityPill({ severity }: { severity: BugSeverity }) {
  return (
    <span className={cn("pill-priority", `pill-${severity}`)}>{BUG_SEVERITY_LABEL[severity]}</span>
  );
}

/** A bug's triage tags as small chips — routes it to whoever owns that tag. Renders nothing when empty. */
export function BugTagChips({ tags, className }: { tags: string[]; className?: string }) {
  if (!tags?.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
        >
          {t}
        </span>
      ))}
    </span>
  );
}
