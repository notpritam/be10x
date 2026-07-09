// ABOUTME: A DevTools-style network panel for a bug's captured `network.json`, synced to the replay clock —
// ABOUTME: rows in flight at the playhead are highlighted, each expands to headers + bodies, with a waterfall.
import { memo, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, Network as NetworkIcon } from "lucide-react";
import type { NetEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Map an HTTP status to one of the app's data hues (index.css `--status-*`). 0 = failed/canceled. */
function statusColor(status: number): string {
  if (status === 0) return "var(--muted-foreground)";
  if (status >= 500) return "var(--status-blocked)";
  if (status >= 400) return "var(--status-needs_input)";
  if (status >= 300) return "var(--status-ready_to_work)";
  if (status >= 200) return "var(--status-done)";
  return "var(--muted-foreground)";
}

function statusLabel(e: NetEntry): string {
  if (e.status === 0) return "(failed)";
  return e.statusText ? `${e.status} ${e.statusText}` : String(e.status);
}

/** The path + last query of a URL, for the compact Name column (host shown as a subtitle). */
function shortName(url: string): { name: string; host: string } {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).pop() || u.pathname || "/";
    return { name: tail + (u.search ? u.search : ""), host: u.host };
  } catch {
    return { name: url, host: "" };
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

interface RowGeometry {
  /** Left offset of the waterfall bar, as a % of the recording span. */
  leftPct: number;
  /** Width of the waterfall bar, as a % of the recording span (min 1% so instant calls stay visible). */
  widthPct: number;
}

export interface NetworkPanelProps {
  entries: NetEntry[];
  /** Playhead position in epoch ms (from the player), or null in snapshot mode / before the player is ready. */
  currentTime: number | null;
  /** The recording window for the waterfall scale. Falls back to the min/max of the entries when absent. */
  clock: { start: number; end: number } | null;
  /** Seek the player to a request's start (clicking the timing cell). Absent when there's no session replay. */
  onSeek?: (epochMs: number) => void;
  /** Open the raw network.json in a new tab (secondary affordance). */
  onOpenRaw?: () => void;
  loading?: boolean;
  error?: string | null;
}

export function NetworkPanel({
  entries,
  currentTime,
  clock,
  onSeek,
  onOpenRaw,
  loading,
  error,
}: NetworkPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const span = useMemo(() => {
    if (clock && clock.end > clock.start) return clock;
    if (entries.length === 0) return null;
    let start = Infinity;
    let end = -Infinity;
    for (const e of entries) {
      if (e.startedAt < start) start = e.startedAt;
      if (e.endedAt > end) end = e.endedAt;
    }
    return Number.isFinite(start) && end > start ? { start, end } : null;
  }, [clock, entries]);

  const geometry = useMemo(() => {
    const map = new Map<string, RowGeometry>();
    if (!span) return map;
    const total = Math.max(1, span.end - span.start);
    for (const e of entries) {
      const leftPct = Math.max(0, Math.min(100, ((e.startedAt - span.start) / total) * 100));
      const rawWidth = ((e.endedAt - e.startedAt) / total) * 100;
      const widthPct = Math.max(1, Math.min(100 - leftPct, rawWidth));
      map.set(e.id, { leftPct, widthPct });
    }
    return map;
  }, [entries, span]);

  const failedCount = useMemo(
    () => entries.filter((e) => e.status === 0 || e.status >= 400).length,
    [entries],
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <NetworkIcon className="size-4 text-muted-foreground" />
          <h3 className="text-[13px] font-semibold text-foreground">Network</h3>
          {entries.length > 0 && (
            <span className="text-[11.5px] text-muted-foreground">
              {entries.length} {entries.length === 1 ? "request" : "requests"}
              {failedCount > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "var(--status-blocked)" }}>{failedCount} failed</span>
                </>
              )}
            </span>
          )}
        </div>
        {onOpenRaw && entries.length > 0 && (
          <button
            type="button"
            onClick={onOpenRaw}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3" /> Raw JSON
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading network activity…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-6 text-center text-[12.5px] text-destructive">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-3 py-8 text-center text-[12.5px] text-muted-foreground/70">
          No network requests were captured for this session.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
          {/* Column header */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)_92px_72px_140px] items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <span>Method</span>
            <span>Name</span>
            <span>Status</span>
            <span className="text-right">Time</span>
            <span>Waterfall</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto scroll-thin">
            {entries.map((e) => {
              const active =
                currentTime !== null && currentTime >= e.startedAt && currentTime <= e.endedAt;
              return (
                <NetworkRow
                  key={e.id}
                  entry={e}
                  geometry={geometry.get(e.id)}
                  active={active}
                  isOpen={expanded === e.id}
                  onToggle={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
                  onSeek={onSeek}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface NetworkRowProps {
  entry: NetEntry;
  geometry: RowGeometry | undefined;
  active: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onSeek?: (epochMs: number) => void;
}

const NetworkRow = memo(function NetworkRow({
  entry,
  geometry,
  active,
  isOpen,
  onToggle,
  onSeek,
}: NetworkRowProps) {
  const color = statusColor(entry.status);
  const { name, host } = shortName(entry.url);

  return (
    <div
      className={cn(
        "border-b border-border/40 text-[12px] transition-colors last:border-b-0",
        active ? "bg-primary/[0.06]" : "hover:bg-accent/40",
      )}
      data-active={active || undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="grid w-full grid-cols-[64px_minmax(0,1fr)_92px_72px_140px] items-center gap-2 px-3 py-2 text-left outline-none focus-visible:bg-accent/50"
      >
        <span className="flex items-center gap-1 font-mono text-[10.5px] font-semibold text-muted-foreground">
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")}
          />
          {entry.method.toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground" title={entry.url}>
            {name}
          </span>
          {host && <span className="block truncate text-[10.5px] text-muted-foreground">{host}</span>}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="truncate">{statusLabel(entry)}</span>
        </span>
        <span
          className={cn(
            "text-right font-mono text-[11px] text-muted-foreground",
            onSeek && "hover:text-foreground",
          )}
          onClick={
            onSeek
              ? (ev) => {
                  ev.stopPropagation();
                  onSeek(entry.startedAt);
                }
              : undefined
          }
          title={onSeek ? "Jump the replay to this request" : undefined}
          role={onSeek ? "button" : undefined}
        >
          {formatDuration(entry.durationMs)}
        </span>
        <span className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
          {geometry && (
            <span
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${geometry.leftPct}%`,
                width: `${geometry.widthPct}%`,
                backgroundColor: color,
                opacity: active ? 1 : 0.65,
              }}
            />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="grid gap-3 border-t border-border/40 bg-muted/20 px-3 py-3 md:grid-cols-2">
          <HeaderBlock title="Request" headers={entry.requestHeaders} body={entry.requestBody} />
          <HeaderBlock title="Response" headers={entry.responseHeaders} body={entry.responseBody} />
        </div>
      )}
    </div>
  );
});

function HeaderBlock({
  title,
  headers,
  body,
}: {
  title: string;
  headers: Record<string, string> | undefined;
  body: string | null;
}) {
  const entries = headers ? Object.entries(headers) : [];
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        {title}
      </p>
      {entries.length > 0 ? (
        <dl className="mb-2 space-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <dt className="shrink-0 font-mono font-medium text-muted-foreground">{k}:</dt>
              <dd className="min-w-0 break-all font-mono text-foreground/80">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mb-2 text-[11px] italic text-muted-foreground/60">No headers captured.</p>
      )}
      {body ? (
        <pre className="max-h-40 overflow-auto scroll-thin rounded-md border border-border/60 bg-background p-2 text-[11px] leading-relaxed text-foreground/85">
          {body}
        </pre>
      ) : (
        <p className="text-[11px] italic text-muted-foreground/60">No body captured.</p>
      )}
    </div>
  );
}
