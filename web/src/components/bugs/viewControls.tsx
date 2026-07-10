// ABOUTME: Shared view chrome for the replay + snapshot stages — a Fit/100%/zoom scale control, an
// ABOUTME: expand-to-fullscreen StageShell overlay, and the picked-element highlight box drawn over the stage.
import { useEffect, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, Plus, Scan, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** The stage scale: a base fit mode (fill the column, or render 1:1) with a −/+ zoom multiplier on top. */
export type ScaleBase = "fit" | "actual";
export interface ViewScale {
  base: ScaleBase;
  zoom: number;
}

export const DEFAULT_VIEW_SCALE: ViewScale = { base: "fit", zoom: 1 };

/** Keep the zoom multiplier in a sane, quarter-step range so the stage never collapses or runs away. */
export function clampZoom(z: number): number {
  return Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
}

function SegButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}

/** The compact scale + expand toolbar shown above (and, when expanded, atop) a stage. */
export function ViewControls({
  scale,
  onScale,
  appliedScale,
  expanded,
  onToggleExpand,
  className,
}: {
  scale: ViewScale;
  onScale: (s: ViewScale) => void;
  /** The scale actually applied to the stage (base × zoom, resolved against the container) for the % label. */
  appliedScale: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  className?: string;
}) {
  const pct =
    appliedScale != null && Number.isFinite(appliedScale) ? Math.round(appliedScale * 100) : null;
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}>
      <SegButton
        active={scale.base === "fit" && scale.zoom === 1}
        onClick={() => onScale({ base: "fit", zoom: 1 })}
        title="Fit to width"
      >
        <Scan className="size-3.5" /> Fit
      </SegButton>
      <SegButton
        active={scale.base === "actual" && scale.zoom === 1}
        onClick={() => onScale({ base: "actual", zoom: 1 })}
        title="Actual size (100%)"
      >
        100%
      </SegButton>
      <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden />
      <IconButton onClick={() => onScale({ ...scale, zoom: clampZoom(scale.zoom - 0.25) })} title="Zoom out">
        <Minus className="size-3.5" />
      </IconButton>
      <span className="w-10 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
        {pct != null ? `${pct}%` : "—"}
      </span>
      <IconButton onClick={() => onScale({ ...scale, zoom: clampZoom(scale.zoom + 0.25) })} title="Zoom in">
        <Plus className="size-3.5" />
      </IconButton>
      <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden />
      <IconButton onClick={onToggleExpand} title={expanded ? "Exit fullscreen" : "Expand"}>
        {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </IconButton>
    </div>
  );
}

/** Wraps a stage with its controls bar and, when `expanded`, lifts the whole thing into a fixed full-viewport
 *  overlay. Children stay in the same tree position across the toggle (only the wrapper's classes change), so
 *  an imperatively-mounted rrweb iframe inside is never remounted — playback + snapshot state survive expand. */
export function StageShell({
  expanded,
  onCollapse,
  title,
  controls,
  children,
}: {
  expanded: boolean;
  onCollapse: () => void;
  title?: string;
  controls: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onCollapse]);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2",
        expanded && "fixed inset-0 z-[60] bg-background/98 p-4 backdrop-blur-sm",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {expanded && title ? (
          <span className="truncate text-[13px] font-semibold text-foreground">{title}</span>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex items-center gap-1.5">
          {controls}
          {expanded && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Close fullscreen"
              className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className={cn("min-w-0", expanded && "min-h-0 flex-1 overflow-auto")}>{children}</div>
    </div>
  );
}

/** A page-pixel rect scaled onto the stage — the highlight for a picked element. Absolutely positioned; its
 *  parent must be the same in-flow, content-sized box that holds the rrweb iframe so it scrolls in lockstep. */
export function PickOverlay({
  rect,
  scale,
}: {
  rect: { x: number; y: number; w: number; h: number } | null;
  scale: number | null;
}) {
  if (!rect || scale == null || !Number.isFinite(scale)) return null;
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{
        transform: `translate(${rect.x * scale}px, ${rect.y * scale}px)`,
        width: Math.max(2, rect.w * scale),
        height: Math.max(2, rect.h * scale),
      }}
    >
      <div className="size-full rounded-[2px] border-2 border-primary bg-primary/10 ring-1 ring-background/70" />
    </div>
  );
}
