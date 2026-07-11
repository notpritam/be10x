// ABOUTME: A single bug's detail — screenshot + identity + captured metadata, a status/resolution control,
// ABOUTME: a comment box, and the event timeline. Artifacts load via short-lived signed UploadThing URLs.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  FolderGit2,
  Loader2,
  MessageSquare,
  Send,
  Share2,
  StickyNote,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { api, dashboardArtifacts, errorMessage } from "@/lib/api";
import type { Bug, BugEvent, BugStatus } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn, formatDateTime, humanizeKey, relativeTime } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BUG_STATUS_META,
  BUG_STATUS_ORDER,
  BugSeverityPill,
  BugStatusBadge,
  BugTagChips,
  CredentialsCard,
  EnvironmentCard,
} from "./bug-bits";
import { BugShareDialog } from "./BugShareDialog";

/** The replay UI pulls in rrweb-player + rrweb-snapshot (~200 KB); load it as its own chunk only when a
 *  bug detail is actually opened, so it never weighs down the rest of the dashboard's initial bundle. */
const ReplaySection = lazy(() =>
  import("./ReplaySection").then((m) => ({ default: m.ReplaySection })),
);

/** Meta keys surfaced richly elsewhere (replay section, notes card, picked-element panel, credentials card,
 *  activity rail) — kept out of the generic Details key/value dump so they aren't double-rendered. */
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

type ShotState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "error" };

export function BugDetail({ bugId, onBack }: { bugId: string; onBack: () => void }) {
  const { user, teams, projects } = useApp();
  const [data, setData] = useState<{ bug: Bug; events: BugEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<ShotState>({ state: "loading" });

  const [pendingStatus, setPendingStatus] = useState<BugStatus>("open");
  const [resolution, setResolution] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  const [comment, setComment] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  const [shareOpen, setShareOpen] = useState(false);
  // Stable per bug so the replay components' fetch effects don't re-run on every render.
  const artifacts = useMemo(() => dashboardArtifacts(bugId), [bugId]);

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setError(null);
      try {
        const res = await api.getBug(bugId);
        if (signal?.cancelled) return;
        setData(res);
        setPendingStatus(res.bug.status);
      } catch (err) {
        if (!signal?.cancelled) setError(errorMessage(err));
      }
    },
    [bugId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const bug = data?.bug ?? null;
  const events = data?.events ?? [];
  const screenshotKey = bug?.screenshotKey ?? null;
  // A session recording or network timeline needs the wider layout for the player + DevTools panel.
  const wide = !!(bug?.sessionKey || bug?.networkKey);

  // The screenshot's signed URL is short-lived, so fetch it lazily once the bug (and its key) are known.
  useEffect(() => {
    if (!bug || !screenshotKey) {
      setShot({ state: "none" });
      return;
    }
    let active = true;
    setShot({ state: "loading" });
    api
      .bugArtifactUrl(bug.id, "screenshot")
      .then(({ url }) => active && setShot({ state: "ready", url }))
      .catch(() => active && setShot({ state: "error" }));
    return () => {
      active = false;
    };
  }, [bug, screenshotKey]);

  async function saveStatus() {
    if (!bug) return;
    setSavingStatus(true);
    try {
      const note = resolution.trim();
      await api.updateBugStatus(bug.id, pendingStatus, note || undefined);
      toast.success(`Bug marked ${BUG_STATUS_META[pendingStatus].label.toLowerCase()}.`);
      setResolution("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingStatus(false);
    }
  }

  async function postComment() {
    if (!bug) return;
    const body = comment.trim();
    if (!body) return;
    setPostingComment(true);
    try {
      await api.addBugComment(bug.id, body);
      setComment("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPostingComment(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background">
      <div className={cn("mx-auto w-full px-8 py-6 space-y-5", wide ? "max-w-none" : "max-w-3xl")}>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" /> All bugs
        </button>

        {error ? (
          <div className="rounded-[8px] border border-destructive/30 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
            {error}
          </div>
        ) : !bug ? (
          <div className="flex items-center gap-2 py-16 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading bug…
          </div>
        ) : (
          <>
            {/* Header */}
            <header className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] font-medium tracking-wide text-muted-foreground">
                  {bug.humanId}
                </span>
                <BugStatusBadge status={bug.status} />
                <BugSeverityPill severity={bug.severity} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShareOpen(true)}
                  className="ml-auto text-[12.5px]"
                >
                  <Share2 className="size-3.5" />
                  Share
                </Button>
              </div>
              <h1 className="text-[20px] font-bold leading-snug tracking-tight text-foreground">
                {bug.title}
              </h1>
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
              {(bug.tags.length > 0 || bug.teamId || bug.projectId) && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {bug.teamId && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      <Users className="size-3" /> {teams.find((t) => t.id === bug.teamId)?.name ?? "Team"}
                    </span>
                  )}
                  {bug.projectId && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      <FolderGit2 className="size-3" /> {projects.find((p) => p.id === bug.projectId)?.name ?? "Project"}
                    </span>
                  )}
                  <BugTagChips tags={bug.tags} />
                </div>
              )}
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

            {/* Session replay ⇄ snapshot + the playhead-synced network panel. Renders gracefully for older
                bugs with only a screenshot (falls back to the static poster). */}
            {(bug.sessionKey || bug.networkKey || bug.domKey || bug.screenshotKey) && (
              <Suspense fallback={<ReplayFallback />}>
                <ReplaySection
                  bug={bug}
                  artifacts={artifacts}
                  screenshotUrl={shot.state === "ready" ? shot.url : null}
                />
              </Suspense>
            )}

            {/* Identity */}
            <Card title="Identity">
              <IdentityBody bug={bug} />
            </Card>

            {/* Test credentials the reporter supplied — the account to sign in with to reproduce. */}
            {bug.meta.credentials && <CredentialsCard credentials={bug.meta.credentials} />}

            {/* Device / browser / page-load environment the reporter was on. */}
            {bug.meta.environment && <EnvironmentCard env={bug.meta.environment} />}

            {/* Metadata */}
            <Card title="Details">
              <dl>
                <Field label="Reporter" value={bug.reporterId === user.id ? "You" : bug.reporterId} />
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

            {/* Status control */}
            <Card title="Update status">
              <div className="flex flex-col gap-3">
                <Select value={pendingStatus} onValueChange={(v) => setPendingStatus(v as BugStatus)}>
                  <SelectTrigger className="h-9 w-full text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUG_STATUS_ORDER.map((s) => (
                      <SelectItem key={s} value={s}>
                        {BUG_STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder="Resolution note (optional) — what was wrong, what fixed it."
                  className="min-h-[72px] text-[13px]"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => void saveStatus()}
                    disabled={
                      savingStatus || (pendingStatus === bug.status && resolution.trim().length === 0)
                    }
                  >
                    {savingStatus ? <Loader2 className="size-4 animate-spin" /> : null}
                    Update status
                  </Button>
                </div>
              </div>
            </Card>

            {/* Comment + timeline */}
            <Card title="Activity" icon={<MessageSquare className="size-4" />}>
              <div className="mb-4 flex flex-col gap-2">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment…"
                  className="min-h-[64px] text-[13px]"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void postComment()}
                    disabled={postingComment || comment.trim().length === 0}
                  >
                    {postingComment ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                    Comment
                  </Button>
                </div>
              </div>

              <ol className="flex flex-col gap-3">
                {events.map((ev) => (
                  <li key={ev.id} className="flex gap-2.5">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] leading-relaxed text-foreground/90">
                        <span className="font-medium text-foreground">
                          {ev.actor === user.id ? "You" : "A teammate"}
                        </span>{" "}
                        {describeEvent(ev)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{relativeTime(ev.createdAt)}</p>
                    </div>
                  </li>
                ))}
                {events.length === 0 && <EmptyNote>No activity yet.</EmptyNote>}
              </ol>
            </Card>

            <BugShareDialog bugId={bug.id} open={shareOpen} onOpenChange={setShareOpen} />
          </>
        )}
      </div>
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

function describeEvent(ev: BugEvent): string {
  switch (ev.kind) {
    case "created":
      return "reported this bug.";
    case "status": {
      const to = typeof ev.payload.to === "string" ? BUG_STATUS_META[ev.payload.to as BugStatus]?.label : null;
      const from =
        typeof ev.payload.from === "string" ? BUG_STATUS_META[ev.payload.from as BugStatus]?.label : null;
      const note = typeof ev.payload.resolution === "string" && ev.payload.resolution ? ` — "${ev.payload.resolution}"` : "";
      return `changed status${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}${note}.`;
    }
    case "comment":
      return typeof ev.payload.body === "string" ? `commented: "${ev.payload.body}"` : "commented.";
    case "assign":
      return "changed the assignee.";
    default:
      return ev.kind;
  }
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

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
      {children}
    </p>
  );
}
