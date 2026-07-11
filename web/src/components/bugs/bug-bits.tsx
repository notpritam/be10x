// ABOUTME: Shared presentational atoms for the Bugs dashboard — a soft status badge (colored dot + label),
// ABOUTME: a severity pill (with `critical`), tag chips, and the reporter's test-credentials card.
import { useState } from "react";
import { Copy, Cpu, Eye, EyeOff, Gauge, Globe, KeyRound, Lightbulb, Loader2, Monitor, Smartphone, Sparkles, Wifi } from "lucide-react";
import { toast } from "sonner";
import type { BugAnalysis, BugEnvironment, BugSeverity, BugStatus, LlmAnalysis, TestCredentials } from "@/lib/types";
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

/** The heuristic root-cause summary — the "start here" card. Server-derived (analyzeBug), so it's the same on
 *  the dashboard and public share page. Renders nothing when the bug has no analyzable signal. */
export function RootCauseCard({
  analysis,
  llm,
  canAnalyze = false,
  analyzing = false,
  onAnalyze,
}: {
  analysis: BugAnalysis;
  /** A cached LLM analysis to render, when present. */
  llm?: LlmAnalysis | null;
  /** Whether the viewer can trigger AI analysis (board has a key + it's the authed dashboard). */
  canAnalyze?: boolean;
  analyzing?: boolean;
  onAnalyze?: () => void;
}) {
  const meaningful = analysis.evidence.length > 0 || !!analysis.suspectedComponent || analysis.errorCount > 0;
  if (!meaningful && !llm && !canAnalyze) return null;
  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Lightbulb className="size-4 text-primary" />
        <h2 className="text-[13px] font-semibold text-foreground">Likely root cause</h2>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-medium capitalize",
            analysis.confidence === "high" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {analysis.confidence} confidence
        </span>
      </div>
      <p className="text-[13.5px] font-medium leading-relaxed text-foreground">{analysis.suspectedCause}</p>
      {(analysis.suspectedComponent || analysis.suspectedSource) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          {analysis.suspectedComponent && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">{`<${analysis.suspectedComponent}>`}</span>
          )}
          {analysis.suspectedSource && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground" title={analysis.suspectedSource}>
              {analysis.suspectedSource}
            </span>
          )}
        </div>
      )}
      {analysis.evidence.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Evidence</p>
          <ul className="space-y-1">
            {analysis.evidence.map((e, i) => (
              <li key={i} className="flex gap-1.5 text-[12.5px] text-foreground/85">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="min-w-0">{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {analysis.reproSteps.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Suggested repro</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-[12.5px] text-foreground/85 marker:text-muted-foreground/60">
            {analysis.reproSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Optional LLM analysis: the cached result, or a trigger button when the board has a key configured. */}
      {llm ? (
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-primary" />
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-primary/80">AI analysis</span>
            {onAnalyze && (
              <button
                type="button"
                onClick={onAnalyze}
                disabled={analyzing}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {analyzing ? <Loader2 className="size-3 animate-spin" /> : null}
                Re-run
              </button>
            )}
          </div>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">{llm.text}</p>
          <p className="mt-1.5 text-[10px] text-muted-foreground/60">Generated by {llm.model}</p>
        </div>
      ) : canAnalyze && onAnalyze ? (
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-primary transition-colors hover:bg-primary/[0.1] disabled:opacity-60"
        >
          {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {analyzing ? "Analyzing…" : "Analyze with AI"}
        </button>
      ) : null}
    </section>
  );
}

/** Best-effort browser label — prefers the structured `brands` (Chromium UA-CH), else parses `userAgent`. */
function browserLabel(env: BugEnvironment): string | undefined {
  const brands = env.brands?.filter((b) => !/not.?a.?brand/i.test(b));
  if (brands && brands.length > 0) {
    return brands.find((b) => /chrome|edge|opera|brave|arc/i.test(b)) || brands.find((b) => !/chromium/i.test(b)) || brands[0];
  }
  const ua = env.userAgent ?? "";
  const m =
    ua.match(/Edg\/(\d+)/) ??
    ua.match(/OPR\/(\d+)/) ??
    ua.match(/Firefox\/(\d+)/) ??
    ua.match(/Chrome\/(\d+)/) ??
    (/Safari/.test(ua) ? ua.match(/Version\/(\d+)/) : null);
  if (!m) return undefined;
  const name = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : "Safari";
  return `${name} ${m[1]}`;
}

/** Best-effort OS label from the userAgent. */
function osLabel(env: BugEnvironment): string | undefined {
  const ua = env.userAgent ?? "";
  if (env.platform && /win|mac|linux|android|ios/i.test(env.platform)) {
    if (/win/i.test(env.platform)) return "Windows";
    if (/mac/i.test(env.platform)) return "macOS";
    if (/android/i.test(env.platform)) return "Android";
    if (/ios|iphone|ipad/i.test(env.platform)) return "iOS";
    if (/linux/i.test(env.platform)) return "Linux";
  }
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iOS/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

function fmtMs(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** The reporter's device / browser / page-load environment — the "what were they on" card. Self-contained so
 *  both the dashboard detail and the public share page drop it in. Renders nothing when no environment was
 *  captured (older bugs). */
export function EnvironmentCard({ env }: { env: BugEnvironment }) {
  const browser = browserLabel(env);
  const os = osLabel(env);
  const facts: { icon: typeof Monitor; label: string; value: string }[] = [];
  if (env.screen) {
    const s = env.screen;
    facts.push({
      icon: Monitor,
      label: "Screen",
      value: `${s.w}×${s.h}${s.dpr ? ` @${s.dpr}×` : ""}${s.colorDepth ? ` · ${s.colorDepth}-bit` : ""}`,
    });
  }
  if (env.timezone) facts.push({ icon: Globe, label: "Timezone", value: env.timezone });
  if (env.language) facts.push({ icon: Globe, label: "Language", value: env.language });
  if (env.cores != null || env.memoryGb != null) {
    facts.push({
      icon: Cpu,
      label: "Hardware",
      value: [env.cores != null ? `${env.cores} cores` : null, env.memoryGb != null ? `${env.memoryGb} GB` : null]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (env.connection) {
    const c = env.connection;
    facts.push({
      icon: Wifi,
      label: "Network",
      value:
        [c.effectiveType, c.downlinkMbps != null ? `${c.downlinkMbps} Mbps` : null, c.rttMs != null ? `${c.rttMs} ms` : null]
          .filter(Boolean)
          .join(" · ") + (c.saveData ? " · Save-Data" : ""),
    });
  }
  const perf = env.performance ?? {};
  const perfChips: { label: string; value: string }[] = [];
  const pushPerf = (label: string, ms?: number) => {
    const v = fmtMs(ms);
    if (v) perfChips.push({ label, value: v });
  };
  pushPerf("TTFB", perf.ttfbMs);
  pushPerf("FCP", perf.fcpMs);
  pushPerf("DOM ready", perf.domContentLoadedMs);
  pushPerf("Load", perf.loadMs);

  if (!browser && !os && facts.length === 0 && perfChips.length === 0) return null;

  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-muted-foreground">{env.mobile ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}</span>
        <h2 className="text-[13px] font-semibold text-foreground">Environment</h2>
      </div>
      {(browser || os) && (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-foreground">
          {browser && <span>{browser}</span>}
          {browser && os && <span className="text-muted-foreground/50">·</span>}
          {os && <span>{os}</span>}
          {env.mobile && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
              <Smartphone className="size-2.5" /> Mobile
            </span>
          )}
          {env.online === false && (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10.5px] font-medium text-destructive">
              Offline
            </span>
          )}
        </p>
      )}
      {facts.length > 0 && (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {facts.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.label} className="flex items-start gap-2">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                <div className="min-w-0">
                  <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground/70">{f.label}</dt>
                  <dd className="truncate text-[12.5px] text-foreground" title={f.value}>
                    {f.value}
                  </dd>
                </div>
              </div>
            );
          })}
        </dl>
      )}
      {perfChips.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
          <Gauge className="size-3.5 text-muted-foreground/70" />
          {perfChips.map((c) => (
            <span
              key={c.label}
              className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground"
            >
              <span className="text-muted-foreground">{c.label}</span>
              <span className="font-mono font-medium">{c.value}</span>
            </span>
          ))}
        </div>
      )}
    </section>
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
