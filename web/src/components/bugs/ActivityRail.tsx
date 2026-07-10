// ABOUTME: The fullscreen replay's right-side activity rail — network requests + console lines merged in time
// ABOUTME: order, auto-highlighting/scrolling the entry at the playhead and seeking the player on click.
import { useEffect, useMemo, useRef } from "react";
import { Activity } from "lucide-react";
import type { ConsoleEntry, NetEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Map an HTTP status to one of the app's data hues (index.css `--status-*`). 0 = failed/canceled. Mirrors
 *  NetworkPanel's statusColor so the rail's badges read the same as the panel below the player. */
function statusColor(status: number): string {
  if (status === 0) return "var(--muted-foreground)";
  if (status >= 500) return "var(--status-blocked)";
  if (status >= 400) return "var(--status-needs_input)";
  if (status >= 300) return "var(--status-ready_to_work)";
  if (status >= 200) return "var(--status-done)";
  return "var(--muted-foreground)";
}

/** A console level's hue — error/warn stand out; info/log/debug stay quiet. */
function levelColor(level: ConsoleEntry["level"]): string {
  switch (level) {
    case "error":
      return "var(--status-blocked)";
    case "warn":
      return "var(--status-needs_input)";
    case "info":
      return "var(--status-ready_to_work)";
    default:
      return "var(--muted-foreground)";
  }
}

/** WS rows show "WS"; everything else its HTTP method. Tolerates older captures with a missing method. */
function displayMethod(e: NetEntry): string {
  return e.kind === "ws" ? "WS" : (e.method || "").toUpperCase() || "GET";
}

/** The compact last-segment name of a URL for the rail's middle column. */
function shortName(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname.split("/").filter(Boolean).pop() || u.pathname || "/") + (u.search || "");
  } catch {
    return url;
  }
}

/** "m:ss" offset from the recording start, matching the marker/visit rails. */
function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A network request or a console line, tagged with the timeline instant (epoch ms) it sits at. */
type RailItem =
  | { key: string; kind: "net"; ts: number; end: number; entry: NetEntry }
  | { key: string; kind: "console"; ts: number; entry: ConsoleEntry };

export interface ActivityRailProps {
  network: NetEntry[];
  /** `meta.console` — may be undefined/empty for bugs filed before console capture. */
  consoleEntries: ConsoleEntry[];
  /** The recording window, for the per-entry offset labels. Falls back to the first entry's time when absent. */
  clock: { start: number; end: number } | null;
  /** Playhead position in epoch ms, or null before the player emits a time. */
  currentTime: number | null;
  /** Seek the player to an entry's instant (same plumbing as the network panel). */
  onSeek?: (epochMs: number) => void;
}

/** Beyond this the rail caps its render (kept cheap without a virtualization dep). */
const RENDER_CAP = 500;

/** A time-ordered, playhead-synced list of the session's network + console activity. Mounted only when the
 *  replay is expanded to fullscreen; the inline NetworkPanel below the player is unaffected. */
export function ActivityRail({ network, consoleEntries, clock, currentTime, onSeek }: ActivityRailProps) {
  const items = useMemo<RailItem[]>(() => {
    const list: RailItem[] = [];
    for (const e of network) {
      if (!Number.isFinite(e.startedAt)) continue;
      const end = Number.isFinite(e.endedAt) && e.endedAt >= e.startedAt ? e.endedAt : e.startedAt;
      list.push({ key: `net-${e.id}`, kind: "net", ts: e.startedAt, end, entry: e });
    }
    consoleEntries.forEach((c, i) => {
      if (!Number.isFinite(c.ts)) return;
      list.push({ key: `con-${i}-${c.ts}`, kind: "console", ts: c.ts, entry: c });
    });
    list.sort((a, b) => a.ts - b.ts);
    return list.slice(0, RENDER_CAP);
  }, [network, consoleEntries]);

  // The "current" entry: the last one at or before the playhead. Drives the highlight + the auto-scroll target.
  const activeIndex = useMemo(() => {
    if (currentTime == null) return -1;
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].ts <= currentTime) idx = i;
      else break;
    }
    return idx;
  }, [items, currentTime]);

  const activeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const start = clock?.start ?? items[0]?.ts ?? 0;
  const netCount = items.filter((it) => it.kind === "net").length;
  const conCount = items.length - netCount;

  return (
    <div className="flex max-h-[calc(100vh-9rem)] min-h-0 flex-col rounded-lg border border-border/60 bg-background">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <Activity className="size-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold text-foreground">Activity</h3>
        <span className="text-[11px] text-muted-foreground">
          {netCount} net · {conCount} console
        </span>
      </div>

      {items.length === 0 ? (
        <p className="px-3 py-8 text-center text-[11.5px] text-muted-foreground/70">
          No network or console activity was captured for this session.
        </p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto scroll-thin p-1.5">
          {items.map((it, i) => {
            const active = i === activeIndex;
            const offset = it.ts - start;
            const seekTo = it.ts;

            if (it.kind === "net") {
              const e = it.entry;
              const inFlight = currentTime != null && e.startedAt <= currentTime && currentTime <= it.end;
              const hot = active || inFlight;
              const color = e.kind === "ws" ? "var(--status-in_progress)" : statusColor(e.status);
              const statusText =
                e.kind === "ws" ? `${e.frames?.length ?? 0}` : e.status === 0 ? "×" : String(e.status);
              return (
                <li key={it.key} ref={active ? activeRef : undefined}>
                  <button
                    type="button"
                    disabled={!onSeek}
                    onClick={() => onSeek?.(seekTo)}
                    title={e.url}
                    className={cn(
                      "grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      hot ? "bg-primary/[0.07]" : "hover:bg-accent/50",
                      active && "ring-1 ring-inset ring-primary/40",
                      onSeek ? "cursor-pointer" : "cursor-default",
                    )}
                  >
                    <span className="font-mono text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {displayMethod(e)}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
                          {shortName(e.url)}
                        </span>
                        <span className="shrink-0 font-mono text-[10px]" style={{ color }}>
                          {statusText}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatOffset(offset)}
                    </span>
                  </button>
                </li>
              );
            }

            const c = it.entry;
            const color = levelColor(c.level);
            return (
              <li key={it.key} ref={active ? activeRef : undefined}>
                <button
                  type="button"
                  disabled={!onSeek}
                  onClick={() => onSeek?.(seekTo)}
                  title={c.text}
                  className={cn(
                    "grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    active ? "bg-primary/[0.07] ring-1 ring-inset ring-primary/40" : "hover:bg-accent/50",
                    onSeek ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span
                    className="inline-flex items-center justify-center rounded px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide"
                    style={{ color, backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}
                  >
                    {c.level}
                  </span>
                  <span className="min-w-0 truncate text-[11.5px] text-foreground/85">{c.text}</span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {formatOffset(offset)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
