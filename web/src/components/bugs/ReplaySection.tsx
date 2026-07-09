// ABOUTME: Orchestrates a bug's session-replay experience — fetches session.json + network.json, hosts the
// ABOUTME: Replay⇄Snapshot toggle, the rrweb player, marker/visit rails, and the playhead-synced network panel.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Clapperboard,
  Flag,
  Image as ImageIcon,
  Loader2,
  Navigation,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Bug, BugMarker, BugVisit, NetEntry, RrwebSession } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SessionReplay, type ReplayClock, type SessionReplayHandle } from "./SessionReplay";
import { NetworkPanel } from "./NetworkPanel";
import { SnapshotView } from "./SnapshotView";

type Mode = "replay" | "snapshot";
type Fetch<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error" };

function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDurationLong(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The recorder may upload session.json as `{ events, ... }` or (defensively) a bare events array. */
function extractEvents(raw: RrwebSession | unknown[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as RrwebSession).events)) {
    return (raw as RrwebSession).events;
  }
  return [];
}

/** network.json is a NetEntry[]; tolerate a `{ entries }` wrapper too. */
function extractEntries(raw: unknown): NetEntry[] {
  if (Array.isArray(raw)) return raw as NetEntry[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)) {
    return (raw as { entries: NetEntry[] }).entries;
  }
  return [];
}

export function ReplaySection({ bug, screenshotUrl }: { bug: Bug; screenshotUrl: string | null }) {
  const hasReplay = !!bug.sessionKey;
  const hasNetwork = !!bug.networkKey;

  const markers = useMemo<BugMarker[]>(() => bug.meta.markers ?? [], [bug.meta.markers]);
  const visits = useMemo<BugVisit[]>(() => bug.meta.visits ?? [], [bug.meta.visits]);
  const recording = bug.meta.recording;
  const viewport = bug.meta.viewport;

  const [mode, setMode] = useState<Mode>(hasReplay ? "replay" : "snapshot");
  const [snapshotMounted, setSnapshotMounted] = useState(!hasReplay);
  useEffect(() => {
    if (mode === "snapshot") setSnapshotMounted(true);
  }, [mode]);

  const [session, setSession] = useState<Fetch<unknown[]>>({ state: "loading" });
  const [network, setNetwork] = useState<Fetch<NetEntry[]>>({ state: "loading" });

  const [clock, setClock] = useState<ReplayClock | null>(null);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const replayRef = useRef<SessionReplayHandle>(null);

  // Fetch the rrweb session recording (only when present).
  useEffect(() => {
    if (!hasReplay) return;
    let cancelled = false;
    setSession({ state: "loading" });
    api
      .loadBugArtifactJson<RrwebSession | unknown[]>(bug.id, "session")
      .then((raw) => {
        if (cancelled) return;
        const events = extractEvents(raw);
        setSession(events.length > 0 ? { state: "ready", data: events } : { state: "error" });
      })
      .catch(() => !cancelled && setSession({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [bug.id, hasReplay]);

  // Fetch the timestamped network timeline (only when present).
  useEffect(() => {
    if (!hasNetwork) return;
    let cancelled = false;
    setNetwork({ state: "loading" });
    api
      .loadBugArtifactJson<unknown>(bug.id, "network")
      .then((raw) => !cancelled && setNetwork({ state: "ready", data: extractEntries(raw) }))
      .catch(() => !cancelled && setNetwork({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [bug.id, hasNetwork]);

  const handleClockReady = useCallback((c: ReplayClock) => {
    setClock(c);
    // Park the playhead at the recording start so the network panel highlights first-moment requests at
    // rest, before the user scrubs (the player doesn't emit a time event until playback/seek).
    setCurrentTime((cur) => (cur === null ? c.start : cur));
  }, []);
  const handleTimeUpdate = useCallback((epochMs: number) => setCurrentTime(epochMs), []);

  // Seek from a marker / visit / network row — reveal the player if we're on the snapshot tab first.
  const seekToEpoch = useCallback(
    (epochMs: number) => {
      if (!hasReplay) return;
      setMode("replay");
      requestAnimationFrame(() => replayRef.current?.seekToEpoch(epochMs));
    },
    [hasReplay],
  );

  const openRaw = useCallback(
    async (kind: "network" | "dom" | "session") => {
      try {
        const { url } = await api.bugArtifactUrl(bug.id, kind);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        /* best-effort secondary affordance */
      }
    },
    [bug.id],
  );

  const networkEntries = network.state === "ready" ? network.data : [];
  const networkClock = clock
    ? { start: clock.start, end: clock.end }
    : recording
      ? { start: recording.startedAt, end: recording.endedAt }
      : null;

  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      {/* Header: title, recording chip, and (when there's a recording) the Replay ⇄ Snapshot toggle. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clapperboard className="size-4 text-muted-foreground" />
          <h2 className="text-[13px] font-semibold text-foreground">
            {hasReplay ? "Session replay" : "Captured moment"}
          </h2>
          {recording && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {recording.mode === "explicit" ? "Recorded" : "Rolling buffer"} ·{" "}
              {formatDurationLong(recording.durationMs)}
            </span>
          )}
        </div>
        {hasReplay && (
          <ModeToggle mode={mode} onChange={setMode} />
        )}
      </div>

      {/* --- Replay experience (present only when a session was recorded) --- */}
      {hasReplay && (
        <div className={cn(mode !== "replay" && "hidden")}>
          {session.state === "loading" ? (
            <ReplaySkeleton />
          ) : session.state === "error" ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-4 py-12 text-center">
              <AlertTriangle className="size-5 text-destructive" />
              <p className="text-[13px] font-medium text-destructive">
                The session recording couldn't be loaded.
              </p>
              <p className="text-[12px] text-muted-foreground">
                Switch to Snapshot for the static marked moment, or try again later.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                <SessionReplay
                  ref={replayRef}
                  events={session.data}
                  markers={markers}
                  viewport={viewport}
                  onClockReady={handleClockReady}
                  onTimeUpdate={handleTimeUpdate}
                />
                <div className="flex min-w-0 flex-col gap-4">
                  <MarkerList markers={markers} clock={clock} onSeek={seekToEpoch} />
                  <VisitList visits={visits} clock={clock} onSeek={seekToEpoch} />
                </div>
              </div>
              {hasNetwork && (
                <NetworkPanel
                  entries={networkEntries}
                  currentTime={currentTime}
                  clock={networkClock}
                  onSeek={seekToEpoch}
                  onOpenRaw={() => void openRaw("network")}
                  loading={network.state === "loading"}
                  error={network.state === "error" ? "The network timeline couldn't be loaded." : null}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* --- Snapshot / static view (kept mounted once opened so switching back to Replay is instant) --- */}
      {(mode === "snapshot" || snapshotMounted || !hasReplay) && (
        <div className={cn(hasReplay && mode !== "snapshot" && "hidden", "space-y-4")}>
          <SnapshotView bugId={bug.id} domKey={bug.domKey} screenshotUrl={screenshotUrl} />
          {/* Older bugs (no session) still surface their captured network + markers, just un-synced. */}
          {!hasReplay && hasNetwork && (
            <NetworkPanel
              entries={networkEntries}
              currentTime={null}
              clock={networkClock}
              onOpenRaw={() => void openRaw("network")}
              loading={network.state === "loading"}
              error={network.state === "error" ? "The network timeline couldn't be loaded." : null}
            />
          )}
          {!hasReplay && (markers.length > 0 || visits.length > 0) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <MarkerList markers={markers} clock={null} onSeek={null} />
              <VisitList visits={visits} clock={null} onSeek={null} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: { value: Mode; label: string; icon: typeof Clapperboard }[] = [
    { value: "replay", label: "Replay", icon: Clapperboard },
    { value: "snapshot", label: "Snapshot", icon: ImageIcon },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Replay view">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ReplaySkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-3">
        <div className="flex h-[360px] w-full items-center justify-center rounded-lg border border-border/60 bg-muted/50">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
        <div className="h-8 w-full animate-pulse rounded-md bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-32 w-full animate-pulse rounded-lg bg-muted" />
        <div className="h-24 w-full animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}

function RailCard({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background p-3">
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <h3 className="text-[12px] font-semibold text-foreground">{title}</h3>
        <span className="text-[11px] text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}

function MarkerList({
  markers,
  clock,
  onSeek,
}: {
  markers: BugMarker[];
  clock: ReplayClock | null;
  onSeek: ((epochMs: number) => void) | null;
}) {
  return (
    <RailCard
      title="Markers"
      count={markers.length}
      icon={<Flag className="size-3.5" style={{ color: "var(--status-blocked)" }} />}
    >
      {markers.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground/70">No moments were marked.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {markers.map((m, i) => (
            <li key={`${m.t}-${i}`}>
              <button
                type="button"
                disabled={!onSeek}
                onClick={() => onSeek?.(m.t)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                  onSeek ? "hover:bg-accent/60" : "cursor-default",
                )}
              >
                <Flag className="size-3 shrink-0" style={{ color: "var(--status-blocked)" }} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {m.label || "Marked moment"}
                </span>
                {clock && (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {formatOffset(m.t - clock.start)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </RailCard>
  );
}

function VisitList({
  visits,
  clock,
  onSeek,
}: {
  visits: BugVisit[];
  clock: ReplayClock | null;
  onSeek: ((epochMs: number) => void) | null;
}) {
  return (
    <RailCard
      title="Pages visited"
      count={visits.length}
      icon={<Navigation className="size-3.5 text-muted-foreground" />}
    >
      {visits.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground/70">No navigations were captured.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {visits.map((v, i) => {
            let path = v.url;
            try {
              const u = new URL(v.url);
              path = u.pathname + u.search;
            } catch {
              /* keep raw */
            }
            return (
              <li key={`${v.t}-${i}`}>
                <button
                  type="button"
                  disabled={!onSeek}
                  onClick={() => onSeek?.(v.t)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    onSeek ? "hover:bg-accent/60" : "cursor-default",
                  )}
                  title={v.url}
                >
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {v.title || path}
                    </span>
                    {v.title && (
                      <span className="block truncate text-[10.5px] text-muted-foreground">{path}</span>
                    )}
                  </span>
                  {clock && (
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {formatOffset(v.t - clock.start)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </RailCard>
  );
}
