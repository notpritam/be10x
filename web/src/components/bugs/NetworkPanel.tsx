// ABOUTME: A DevTools-grade network panel for a bug's captured `network.json`, synced to the replay clock —
// ABOUTME: search + method/status/host filters, a waterfall, per-request headers/bodies (pretty JSON), and WS frames.
import { memo, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Network as NetworkIcon,
  Search,
  X,
} from "lucide-react";
import type { NetEntry, WsFrame } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type StatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "failed";
const STATUS_BUCKETS: StatusBucket[] = ["2xx", "3xx", "4xx", "5xx", "failed"];

/** Map an HTTP status to one of the app's data hues (index.css `--status-*`). 0 = failed/canceled. */
function statusColor(status: number): string {
  if (status === 0) return "var(--muted-foreground)";
  if (status >= 500) return "var(--status-blocked)";
  if (status >= 400) return "var(--status-needs_input)";
  if (status >= 300) return "var(--status-ready_to_work)";
  if (status >= 200) return "var(--status-done)";
  return "var(--muted-foreground)";
}

/** Which filter bucket a status falls in (unknown/1xx fall through to null — only shown when unfiltered). */
function bucketOf(status: number): StatusBucket | null {
  if (status === 0) return "failed";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return null;
}

function statusLabel(e: NetEntry): string {
  if (e.status === 0) return "(failed)";
  return e.statusText ? `${e.status} ${e.statusText}` : String(e.status);
}

/** WS rows show "W" for the verb; everything else its HTTP method. */
function displayMethod(e: NetEntry): string {
  return e.kind === "ws" ? "WS" : e.method.toUpperCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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

/** Relative offset ("+1.2s") of an epoch-ms instant from the recording start, for the timing readouts. */
function formatOffset(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const sign = ms < 0 ? "-" : "+";
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  return `${sign}${(a / 1000).toFixed(2)} s`;
}

/** Pretty-print a body when it parses as JSON; otherwise hand back the raw text unchanged. */
function prettyBody(raw: string): { text: string; json: boolean } {
  const t = raw.trim();
  if (t && (t[0] === "{" || t[0] === "[")) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
    } catch {
      /* not JSON after all */
    }
  }
  return { text: raw, json: false };
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

/** Beyond this the table caps its render (kept fast without a virtualization dep) and nudges the user to filter. */
const RENDER_CAP = 300;

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
  const [query, setQuery] = useState("");
  const [methodSel, setMethodSel] = useState<Set<string>>(new Set());
  const [statusSel, setStatusSel] = useState<Set<StatusBucket>>(new Set());
  const [hostSel, setHostSel] = useState<Set<string>>(new Set());

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

  // Available facets, derived from the captured set (only offer filters that can actually match something).
  const methods = useMemo(
    () => Array.from(new Set(entries.map(displayMethod))).sort(),
    [entries],
  );
  const hosts = useMemo(
    () => Array.from(new Set(entries.map((e) => hostOf(e.url)).filter(Boolean))).sort(),
    [entries],
  );
  const buckets = useMemo(() => {
    const present = new Set(entries.map((e) => bucketOf(e.status)));
    return STATUS_BUCKETS.filter((b) => present.has(b));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !`${e.url} ${e.method}`.toLowerCase().includes(q)) return false;
      if (methodSel.size && !methodSel.has(displayMethod(e))) return false;
      if (statusSel.size) {
        const b = bucketOf(e.status);
        if (!b || !statusSel.has(b)) return false;
      }
      if (hostSel.size && !hostSel.has(hostOf(e.url))) return false;
      return true;
    });
  }, [entries, query, methodSel, statusSel, hostSel]);

  const failedCount = useMemo(
    () => entries.filter((e) => e.status === 0 || e.status >= 400).length,
    [entries],
  );

  const anyFilter = query.trim() !== "" || methodSel.size > 0 || statusSel.size > 0 || hostSel.size > 0;
  const clearAll = () => {
    setQuery("");
    setMethodSel(new Set());
    setStatusSel(new Set());
    setHostSel(new Set());
  };
  const shown = filtered.slice(0, RENDER_CAP);

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
        <>
          {/* Toolbar: substring search + method / status / host chips. */}
          <div className="mb-2 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name or URL…"
                className="h-8 pl-8 pr-8 text-[12.5px]"
                aria-label="Filter requests"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {methods.map((m) => (
                <Chip key={`m-${m}`} active={methodSel.has(m)} onClick={() => setMethodSel(toggle(methodSel, m))}>
                  {m}
                </Chip>
              ))}
              {(methods.length > 0 && buckets.length > 0) && <ChipDivider />}
              {buckets.map((b) => (
                <Chip
                  key={`s-${b}`}
                  active={statusSel.has(b)}
                  onClick={() => setStatusSel(toggle(statusSel, b))}
                  dotColor={b === "failed" ? "var(--status-blocked)" : statusColor(Number(b[0]) * 100)}
                >
                  {b}
                </Chip>
              ))}
              {(hosts.length > 1 && (methods.length > 0 || buckets.length > 0)) && <ChipDivider />}
              {hosts.length > 1 &&
                hosts.map((h) => (
                  <Chip key={`h-${h}`} active={hostSel.has(h)} onClick={() => setHostSel(toggle(hostSel, h))}>
                    {h}
                  </Chip>
                ))}
              {anyFilter && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="ml-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" /> Clear
                </button>
              )}
            </div>
            {anyFilter && (
              <p className="text-[11px] text-muted-foreground">
                Showing {filtered.length} of {entries.length}
                {filtered.length > RENDER_CAP && ` · first ${RENDER_CAP} rendered`}
              </p>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
            {/* Column header */}
            <div className="grid grid-cols-[64px_minmax(0,1fr)_92px_72px_140px] items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              <span>Method</span>
              <span>Name</span>
              <span>Status</span>
              <span className="text-right">Time</span>
              <span>Waterfall</span>
            </div>
            {shown.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12.5px] text-muted-foreground/70">
                No requests match these filters.
              </div>
            ) : (
              <div className="max-h-[440px] overflow-y-auto scroll-thin">
                {shown.map((e) => {
                  const active =
                    currentTime !== null && currentTime >= e.startedAt && currentTime <= e.endedAt;
                  return (
                    <NetworkRow
                      key={e.id}
                      entry={e}
                      geometry={geometry.get(e.id)}
                      spanStart={span?.start ?? e.startedAt}
                      active={active}
                      isOpen={expanded === e.id}
                      onToggle={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
                      onSeek={onSeek}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function ChipDivider() {
  return <span className="mx-0.5 h-4 w-px self-center bg-border/70" aria-hidden />;
}

function Chip({
  active,
  onClick,
  dotColor,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dotColor?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/30 bg-primary/10 text-foreground"
          : "border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {dotColor && <span className="size-1.5 rounded-full" style={{ backgroundColor: dotColor }} />}
      {children}
    </button>
  );
}

interface NetworkRowProps {
  entry: NetEntry;
  geometry: RowGeometry | undefined;
  spanStart: number;
  active: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onSeek?: (epochMs: number) => void;
}

const NetworkRow = memo(function NetworkRow({
  entry,
  geometry,
  spanStart,
  active,
  isOpen,
  onToggle,
  onSeek,
}: NetworkRowProps) {
  const isWs = entry.kind === "ws";
  const color = isWs ? "var(--status-in_progress)" : statusColor(entry.status);
  const { name, host } = shortName(entry.url);
  const frameCount = entry.frames?.length ?? 0;

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
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")} />
          {displayMethod(entry)}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground" title={entry.url}>
            {name}
          </span>
          {host && <span className="block truncate text-[10.5px] text-muted-foreground">{host}</span>}
        </span>
        {isWs ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate">{frameCount} msg</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate">{statusLabel(entry)}</span>
          </span>
        )}
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
        <div className="border-t border-border/40 bg-muted/20 px-3 py-3">
          <TimingRow entry={entry} spanStart={spanStart} geometry={geometry} color={color} />
          {isWs ? (
            <WsDetail entry={entry} spanStart={spanStart} />
          ) : (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <HeaderBlock
                title="Request"
                headers={entry.requestHeaders}
                body={entry.requestBody}
                truncated={entry.requestBodyTruncated}
              />
              <HeaderBlock
                title="Response"
                headers={entry.responseHeaders}
                body={entry.responseBody}
                truncated={entry.responseBodyTruncated}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function TimingRow({
  entry,
  spanStart,
  geometry,
  color,
}: {
  entry: NetEntry;
  spanStart: number;
  geometry: RowGeometry | undefined;
  color: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="font-mono">
        Started <span className="text-foreground">{formatOffset(entry.startedAt - spanStart)}</span>
      </span>
      <span className="font-mono">
        Duration <span className="text-foreground">{formatDuration(entry.durationMs)}</span>
      </span>
      <span className="relative h-2 min-w-[120px] flex-1 overflow-hidden rounded-full bg-muted">
        {geometry && (
          <span
            className="absolute inset-y-0 rounded-full"
            style={{ left: `${geometry.leftPct}%`, width: `${geometry.widthPct}%`, backgroundColor: color }}
          />
        )}
      </span>
    </div>
  );
}

function HeaderBlock({
  title,
  headers,
  body,
  truncated,
}: {
  title: string;
  headers: Record<string, string> | undefined;
  body: string | null;
  truncated?: boolean;
}) {
  const headerEntries = headers ? Object.entries(headers) : [];
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">{title}</p>
      <Disclosure label="Headers" count={headerEntries.length} defaultOpen>
        {headerEntries.length > 0 ? (
          <dl className="space-y-0.5">
            {headerEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[11px]">
                <dt className="shrink-0 font-mono font-medium text-muted-foreground">{k}:</dt>
                <dd className="min-w-0 break-all font-mono text-foreground/80">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[11px] italic text-muted-foreground/60">No headers captured.</p>
        )}
      </Disclosure>
      <Disclosure
        label="Body"
        badge={truncated ? <TruncatedBadge /> : undefined}
        defaultOpen={!!body}
      >
        {body ? <BodyView body={body} /> : <p className="text-[11px] italic text-muted-foreground/60">No body captured.</p>}
      </Disclosure>
    </div>
  );
}

function BodyView({ body }: { body: string }) {
  const { text, json } = useMemo(() => prettyBody(body), [body]);
  return (
    <div className="relative">
      <CopyButton text={text} />
      <pre
        className={cn(
          "max-h-56 overflow-auto scroll-thin rounded-md border border-border/60 bg-background p-2 pr-8 text-[11px] leading-relaxed text-foreground/85",
          json && "whitespace-pre",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function TruncatedBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: "color-mix(in oklch, var(--status-needs_input) 18%, transparent)", color: "var(--status-needs_input)" }}
      title="The recorder clipped this body at its capture cap."
    >
      truncated
    </span>
  );
}

function Disclosure({
  label,
  count,
  badge,
  defaultOpen,
  children,
}: {
  label: string;
  count?: number;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80 outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
        {typeof count === "number" && <span className="font-normal normal-case text-muted-foreground/60">{count}</span>}
        {badge}
      </button>
      {open && <div className="mt-1 pl-4">{children}</div>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1200);
          },
          () => {
            /* clipboard unavailable — ignore */
          },
        );
      }}
      aria-label="Copy body"
      title="Copy"
      className="absolute right-1 top-1 z-10 grid size-6 place-items-center rounded-md bg-background/80 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground"
    >
      {done ? <Check className="size-3.5" style={{ color: "var(--status-done)" }} /> : <Copy className="size-3.5" />}
    </button>
  );
}

function WsDetail({ entry, spanStart }: { entry: NetEntry; spanStart: number }) {
  const frames = entry.frames ?? [];
  const shown = frames.slice(0, RENDER_CAP);
  const headerEntries = entry.requestHeaders ? Object.entries(entry.requestHeaders) : [];
  return (
    <div className="mt-3 space-y-2">
      <div className="break-all font-mono text-[11px] text-muted-foreground">{entry.url}</div>
      {headerEntries.length > 0 && (
        <Disclosure label="Handshake headers" count={headerEntries.length}>
          <dl className="space-y-0.5">
            {headerEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[11px]">
                <dt className="shrink-0 font-mono font-medium text-muted-foreground">{k}:</dt>
                <dd className="min-w-0 break-all font-mono text-foreground/80">{v}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
      <div>
        <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Frames <span className="font-normal normal-case text-muted-foreground/60">{frames.length}</span>
        </p>
        {frames.length === 0 ? (
          <p className="text-[11px] italic text-muted-foreground/60">No frames captured.</p>
        ) : (
          <ul className="divide-y divide-border/40 rounded-md border border-border/60 bg-background">
            {shown.map((f, i) => (
              <FrameRow key={i} frame={f} spanStart={spanStart} />
            ))}
            {frames.length > RENDER_CAP && (
              <li className="px-2 py-1.5 text-center text-[10.5px] text-muted-foreground/70">
                First {RENDER_CAP} of {frames.length} frames shown.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

const FrameRow = memo(function FrameRow({ frame, spanStart }: { frame: WsFrame; spanStart: number }) {
  const [open, setOpen] = useState(false);
  const send = frame.dir === "send";
  const color = send ? "var(--status-in_progress)" : "var(--status-done)";
  const { text, json } = open ? prettyBody(frame.data) : { text: frame.data, json: false };
  return (
    <li className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/50"
      >
        {send ? (
          <ArrowUp className="size-3 shrink-0" style={{ color }} />
        ) : (
          <ArrowDown className="size-3 shrink-0" style={{ color }} />
        )}
        <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatOffset(frame.t - spanStart)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={frame.data}>
          {frame.data}
        </span>
      </button>
      {open && (
        <pre
          className={cn(
            "mx-2 mb-2 max-h-56 overflow-auto scroll-thin rounded-md border border-border/60 bg-background p-2 text-[10.5px] leading-relaxed text-foreground/85",
            json && "whitespace-pre",
          )}
        >
          {text}
        </pre>
      )}
    </li>
  );
});
