// ABOUTME: Shared presentational atoms for the Bugs dashboard — a soft status badge (colored dot + label),
// ABOUTME: a severity pill (with `critical`), tag chips, and the reporter's test-credentials card.
import { useState } from "react";
import { Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { BugSeverity, BugStatus, TestCredentials } from "@/lib/types";
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

/** The login the reporter was testing with — a copy-friendly card so a developer can reproduce with the same
 *  account. Self-contained (its own section chrome) so both the dashboard detail and the public share page can
 *  drop it in. Password is masked by default (over-the-shoulder safety) with a reveal toggle; every value has a
 *  one-click copy. Captured raw by design — the product exposes full captures on public share links. Renders
 *  nothing when the reporter supplied no credentials. */
export function CredentialsCard({ credentials }: { credentials: TestCredentials }) {
  const [revealed, setRevealed] = useState(false);
  const copy = (label: string, value: string) => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Couldn't copy"),
    );
  };
  const rows: { label: string; value: string; secret?: boolean }[] = [];
  if (credentials.username) rows.push({ label: "Username", value: credentials.username });
  if (credentials.password) rows.push({ label: "Password", value: credentials.password, secret: true });
  if (credentials.notes) rows.push({ label: "Other", value: credentials.notes });
  if (rows.length === 0) return null;

  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-muted-foreground">
          <KeyRound className="size-4" />
        </span>
        <h2 className="text-[13px] font-semibold text-foreground">Test credentials</h2>
      </div>
      <p className="mb-3 text-[11.5px] text-muted-foreground">
        The login the reporter used while reproducing — sign in with the same account to debug.
      </p>
      <dl className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3">
            <dt className="w-20 shrink-0 text-[11.5px] text-muted-foreground">{r.label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1 font-mono text-[12px] text-foreground">
                {r.secret && !revealed
                  ? "•".repeat(Math.min(14, Math.max(6, r.value.length)))
                  : r.value}
              </code>
              {r.secret && (
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={revealed ? "Hide password" : "Show password"}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => copy(r.label, r.value)}
                aria-label={`Copy ${r.label.toLowerCase()}`}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Copy className="size-3.5" />
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
