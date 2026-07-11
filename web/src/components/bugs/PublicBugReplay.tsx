// ABOUTME: The PUBLIC, token-scoped bug page (/b/<token>). A holder of a share link lands here with no
// ABOUTME: account — a read-only view of the full capture (header, replay/snapshot, network, identity,
// ABOUTME: details). No sidebar, no status control, no comments: exactly what the dashboard shows, view-only.
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Clock, ExternalLink, Loader2, Share2, StickyNote } from "lucide-react";
import { api, publicArtifacts } from "@/lib/api";
import type { Bug, BugAnalysis } from "@/lib/types";
import { cn, formatDateTime, humanizeKey, relativeTime } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
import { BrandTile, Wordmark } from "@/components/common/Brandmark";
import { BugSeverityPill, BugStatusBadge, CredentialsCard, EnvironmentCard, RootCauseCard } from "./bug-bits";
import { SourcePanel } from "./SourcePanel";

/** The replay UI pulls in rrweb (~200 KB); load it as its own chunk only when a shared bug is opened — the
 *  same lazy split the dashboard's BugDetail uses. */
const ReplaySection = lazy(() =>
  import("./ReplaySection").then((m) => ({ default: m.ReplaySection })),
);

/** Meta keys surfaced richly elsewhere (replay section, notes card, picked-element panel, credentials card,
 *  activity rail) — kept out of the generic Details dump so they aren't double-rendered. Mirrors BugDetail. */
const REPLAY_META_KEYS = [
  "markers",
  "visits",
  "recording",
  "notes",
  "pickedElements",
  "drawings",
  "credentials",
  "console",
  "environment",
];

export function PublicBugReplay({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [bug, setBug] = useState<Bug | null>(null);
  const [analysis, setAnalysis] = useState<BugAnalysis | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);

  // Token-scoped artifact source (no cookie). Stable per token so the replay fetch effects don't re-run.
  const artifacts = useMemo(() => publicArtifacts(token), [token]);

  useEffect(() => {
    let active = true;
    setState("loading");
    api
      .getPublicBug(token)
      .then((res) => {
        if (!active) return;
        setBug(res.bug);
        setAnalysis(res.analysis ?? null);
        setState("ready");
        document.title = `${res.bug.humanId} · ${res.bug.title}`;
      })
      .catch(() => active && setState("error"));
    return () => {
      active = false;
    };
  }, [token]);

  // The screenshot's signed URL is short-lived — fetch it lazily once the bug (and its key) are known.
  useEffect(() => {
    if (!bug?.screenshotKey) {
      setShotUrl(null);
      return;
    }
    let active = true;
    artifacts
      .url("screenshot")
      .then(({ url }) => active && setShotUrl(url))
      .catch(() => active && setShotUrl(null));
    return () => {
      active = false;
    };
  }, [bug?.screenshotKey, artifacts]);

  if (state === "loading") {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-muted-foreground">
        <div className="flex items-center gap-2 text-[13px]">
          <Loader2 className="size-4 animate-spin" /> Loading shared bug…
        </div>
      </div>
    );
  }

  if (state === "error" || !bug) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 px-6">
        <div className="max-w-md rounded-[12px] border border-border/60 bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
            <Share2 className="size-5" />
          </div>
          <h1 className="text-[16px] font-semibold text-foreground">This link isn't available</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            The share link is invalid or was revoked. Ask whoever shared it for a fresh link.
          </p>
        </div>
      </div>
    );
  }

  const wide = !!(bug.sessionKey || bug.networkKey);
  const hasCapture = !!(bug.sessionKey || bug.networkKey || bug.domKey || bug.screenshotKey);

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Minimal top bar — brand + a plain "read only" marker. No nav, no account. */}
      <header className="border-b border-border/60 bg-card">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandTile className="size-7" />
            <Wordmark className="text-[15px]" />
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground">
            <Share2 className="size-3.5" /> Shared bug — read only
          </span>
        </div>
      </header>

      <main className={cn("mx-auto w-full space-y-5 px-4 py-6 sm:px-6", wide ? "max-w-5xl" : "max-w-3xl")}>
        {/* Header */}
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] font-medium tracking-wide text-muted-foreground">
              {bug.humanId}
            </span>
            <BugStatusBadge status={bug.status} />
            <BugSeverityPill severity={bug.severity} />
          </div>
          <h1 className="text-[20px] font-bold leading-snug tracking-tight text-foreground">{bug.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <a
              href={bug.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 truncate font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">{bug.pageUrl}</span>
            </a>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" /> Reported {relativeTime(bug.createdAt)}
            </span>
          </div>
        </header>

        {bug.description && (
          <Card title="Description">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
              {bug.description}
            </p>
          </Card>
        )}

        {bug.meta.notes && (
          <Card title="QA notes" icon={<StickyNote className="size-4" />}>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
              {bug.meta.notes}
            </p>
          </Card>
        )}

        {/* Heuristic root-cause summary — same server-derived analysis as the dashboard. */}
        {analysis && <RootCauseCard analysis={analysis} />}

        {/* Session replay ⇄ snapshot + the playhead-synced network panel — token-scoped artifacts. */}
        {hasCapture && (
          <Suspense fallback={<ReplayFallback />}>
            <ReplaySection bug={bug} artifacts={artifacts} screenshotUrl={shotUrl} />
          </Suspense>
        )}

        {/* Captured page source: rendered HTML + inline scripts/styles + the resource manifest. */}
        {bug.sourceKey && <SourcePanel artifacts={artifacts} />}

        {/* Identity */}
        <Card title="Identity">
          <IdentityBody bug={bug} />
        </Card>

        {/* Test credentials the reporter supplied — full raw capture by design on shared links. */}
        {bug.meta.credentials && <CredentialsCard credentials={bug.meta.credentials} />}

        {/* Device / browser / page-load environment the reporter was on. */}
        {bug.meta.environment && <EnvironmentCard env={bug.meta.environment} />}

        {/* Details */}
        <Card title="Details">
          <dl>
            <Field label="Reporter" value={bug.reporterId} />
            <Field label="Page URL" value={bug.pageUrl} />
            <Field label="Reported" value={formatDateTime(bug.createdAt)} />
            <Field label="Last updated" value={formatDateTime(bug.updatedAt)} />
            {Object.entries(bug.meta)
              .filter(([k]) => !REPLAY_META_KEYS.includes(k))
              .map(([k, v]) => (
                <Field key={k} label={humanizeKey(k)} value={stringifyValue(v)} />
              ))}
            {bug.resolution && <Field label="Resolution" value={bug.resolution} />}
          </dl>
        </Card>

        <p className="mb-2 flex items-center justify-center gap-1.5 pt-1 text-center text-[11px] text-muted-foreground/60">
          <Share2 className="size-3" /> Shared via be10x — anyone with this link can view this bug.
        </p>
      </main>
    </div>
  );
}

function IdentityBody({ bug }: { bug: Bug }) {
  const { identity } = bug;
  if (identity.loggedIn === true) {
    return (
      <div className="flex items-center gap-3">
        <UserAvatar name={identity.email || "User"} seed={identity.email || bug.id} size={34} ring={false} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-foreground">
            {identity.email || "Logged in"}
          </p>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {identity.tokenPreview ? `Token ${identity.tokenPreview}` : "Signed in on the captured page"}
          </p>
        </div>
      </div>
    );
  }
  if (identity.loggedIn === false) {
    return (
      <p className="text-[13px] text-muted-foreground">Logged out — no account on the captured page.</p>
    );
  }
  return <p className="text-[13px] text-muted-foreground">Identity wasn't captured for this bug.</p>;
}

function ReplayFallback() {
  return (
    <Card title="Session replay">
      <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading the replay viewer…
      </div>
    </Card>
  );
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function Card({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-[13px] text-foreground">{value}</dd>
    </div>
  );
}
