// ABOUTME: Session replay built on rrweb's core Replayer (constructs synchronously — no rrweb-player Svelte
// ABOUTME: onMount race). Owns play/pause + a marker/playhead scrub track; exposes seekToEpoch imperatively.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Replayer } from "rrweb";
import { AlertTriangle, Flag, Pause, Play } from "lucide-react";
import type { BugMarker } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VIEW_SCALE,
  PickOverlay,
  StageShell,
  ViewControls,
  type ViewScale,
} from "./viewControls";

/** The replay clock, in epoch ms + total duration — everything else (markers, network) maps onto this. */
export interface ReplayClock {
  start: number;
  end: number;
  total: number;
}

/** Imperative handle so parents (marker list, visits rail, network rows) can seek the player by wall time. */
export interface SessionReplayHandle {
  seekToEpoch: (epochMs: number) => void;
  /** Best-effort highlight of a picked element inside the live replay DOM: resolves the CSS selector against
   *  the replayer's iframe document, measures its box, and draws an overlay. Pass null to clear. If the node
   *  isn't found (or the iframe isn't ready) the overlay simply clears — the caller degrades to card-only. */
  highlightSelector: (selector: string | null) => void;
}

interface SessionReplayProps {
  events: unknown[];
  markers: BugMarker[];
  /** The recorded viewport — used to scale the fixed-size replay iframe to fit our container. */
  viewport?: { w: number; h: number };
  onClockReady: (clock: ReplayClock) => void;
  /** Playhead position in epoch ms — throttled to ~20 Hz so downstream (network highlight) stays cheap. */
  onTimeUpdate: (epochMs: number) => void;
  /** A picked element's page-pixel rect to highlight over the replay, or null. */
  pickRect?: { x: number; y: number; w: number; h: number } | null;
  /** Extra content rendered as a right-side rail only while the stage is expanded to fullscreen (the
   *  time-synced activity rail). Ignored in the normal inline layout. */
  expandedAside?: ReactNode;
}

function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const SessionReplay = forwardRef<SessionReplayHandle, SessionReplayProps>(
  function SessionReplay(
    { events, markers, viewport, onClockReady, onTimeUpdate, pickRect, expandedAside },
    ref,
  ) {
    const scrollBoxRef = useRef<HTMLDivElement | null>(null);
    const mountRef = useRef<HTMLDivElement | null>(null);
    const replayerRef = useRef<Replayer | null>(null);
    const clockRef = useRef<ReplayClock | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastEmitRef = useRef(0);
    const speedRef = useRef(1);

    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [error, setError] = useState(false);
    const [scale, setScale] = useState<ViewScale>(DEFAULT_VIEW_SCALE);
    const [expanded, setExpanded] = useState(false);
    const [appliedScale, setAppliedScale] = useState<number | null>(null);
    const [speed, setSpeed] = useState(1);
    // A picked element located live inside the replay iframe (its viewport-space box), drawn as a second
    // overlay. Distinct from `pickRect` (the hover highlight from the element's stored page rect).
    const [selectorRect, setSelectorRect] = useState<{ x: number; y: number; w: number; h: number } | null>(
      null,
    );

    const onClockReadyRef = useRef(onClockReady);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    useEffect(() => {
      onClockReadyRef.current = onClockReady;
      onTimeUpdateRef.current = onTimeUpdate;
      speedRef.current = speed;
    });

    const stopRaf = useCallback(() => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }, []);

    // While playing, sample the replayer clock each frame → drive the scrubber + the network highlight.
    const tick = useCallback(() => {
      const r = replayerRef.current;
      const clock = clockRef.current;
      if (!r || !clock) return;
      const cur = Math.min(r.getCurrentTime(), clock.total);
      setOffset(cur);
      const now = performance.now();
      if (now - lastEmitRef.current >= 50) {
        lastEmitRef.current = now;
        onTimeUpdateRef.current(clock.start + cur);
      }
      if (cur >= clock.total) {
        setPlaying(false);
        stopRaf();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    }, [stopRaf]);

    // Scale the fixed-size replay iframe to the container per the active Fit/100%/zoom mode. Measured off the
    // scroll box (not the mount, whose width we set) so zooming past fit yields a scrollable stage, not a
    // ResizeObserver feedback loop. Mirrored in SnapshotView.
    const fit = useCallback(() => {
      const box = scrollBoxRef.current;
      const mount = mountRef.current;
      if (!box || !mount) return;
      const wrapper = mount.querySelector<HTMLElement>(".replayer-wrapper");
      const iframe = mount.querySelector<HTMLIFrameElement>("iframe");
      if (!wrapper || !iframe) return;
      iframe.style.border = "0";
      const w = viewport && viewport.w > 0 ? viewport.w : Number(iframe.getAttribute("width")) || 1280;
      const h = viewport && viewport.h > 0 ? viewport.h : Number(iframe.getAttribute("height")) || 800;
      const boxW = box.clientWidth;
      const base = scale.base === "actual" ? 1 : boxW > 0 ? boxW / w : 1;
      const s = Math.min(8, Math.max(0.05, base * scale.zoom));
      wrapper.style.transform = `scale(${s})`;
      wrapper.style.transformOrigin = "top left";
      mount.style.width = `${Math.round(w * s)}px`;
      mount.style.height = `${Math.round(h * s)}px`;
      setAppliedScale(s);
    }, [viewport, scale]);

    const fitRef = useRef(fit);
    useEffect(() => {
      fitRef.current = fit;
    });

    useEffect(() => {
      const target = mountRef.current;
      if (!target || !events || events.length === 0) return;
      target.innerHTML = "";

      let replayer: Replayer | null = null;
      let ro: ResizeObserver | null = null;
      try {
        replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
          root: target,
          skipInactive: true,
          showWarning: false,
          mouseTail: false,
        });
        // rrweb's Replayer is ready synchronously — getMetaData works right away (this is the whole reason
        // we dropped rrweb-player, whose Svelte onMount created the replayer a tick too late).
        const meta = replayer.getMetaData();
        const clock: ReplayClock = { start: meta.startTime, end: meta.endTime, total: meta.totalTime };
        clockRef.current = clock;
        setTotal(clock.total);
        onClockReadyRef.current(clock);

        // Scale the wrapper to our column (via the shared fit, honoring the current zoom mode), and keep it
        // fitted as the container resizes.
        fitRef.current();
        ro = new ResizeObserver(() => fitRef.current());
        ro.observe(scrollBoxRef.current ?? target);

        replayer.on("finish", () => {
          setPlaying(false);
          stopRaf();
        });

        // Re-apply the selected speed to the fresh replayer (a rebuild, e.g. loading another bug, resets it).
        if (speedRef.current !== 1) replayer.setConfig({ speed: speedRef.current });
      } catch (e) {
        console.error("[be10x] rrweb Replayer failed:", e);
        setError(true);
      }
      replayerRef.current = replayer;

      return () => {
        stopRaf();
        try {
          ro?.disconnect();
        } catch {
          /* ignore */
        }
        try {
          replayerRef.current?.pause();
        } catch {
          /* ignore */
        }
        replayerRef.current = null;
        clockRef.current = null;
        if (target) target.innerHTML = "";
      };
    }, [events, stopRaf]);

    // Re-fit when the scale mode / expand state / viewport changes (without rebuilding the Replayer).
    useEffect(() => {
      fitRef.current();
    }, [scale, expanded, viewport]);

    const play = useCallback(() => {
      const r = replayerRef.current;
      const clock = clockRef.current;
      if (!r || !clock) return;
      const from = offset >= clock.total ? 0 : offset;
      try {
        r.play(from);
      } catch {
        return;
      }
      setSelectorRect(null); // the picked-element box drifts once the DOM starts moving again.
      setPlaying(true);
      stopRaf();
      rafRef.current = requestAnimationFrame(tick);
    }, [offset, stopRaf, tick]);

    const pause = useCallback(() => {
      const r = replayerRef.current;
      if (!r) return;
      try {
        r.pause();
      } catch {
        /* ignore */
      }
      setPlaying(false);
      stopRaf();
    }, [stopRaf]);

    // Playback speed. rrweb's Timer reads its speed live each frame, so setConfig({ speed }) applies
    // seamlessly whether playing or paused (no re-issue of play() needed); play()/seek() read config.speed
    // too, so the choice persists across pause/seek. tick() samples getCurrentTime(), which already tracks
    // the accelerated clock — no math change here.
    const changeSpeed = useCallback((next: number) => {
      setSpeed(next);
      try {
        replayerRef.current?.setConfig({ speed: next });
      } catch {
        /* best-effort */
      }
    }, []);

    // Resolve a picked element's CSS selector against the live replay iframe and measure its box in the
    // iframe's own (unscaled) viewport pixels — PickOverlay multiplies by appliedScale to land it on the stage.
    const measureSelector = useCallback(
      (selector: string): { x: number; y: number; w: number; h: number } | null => {
        try {
          const doc = mountRef.current?.querySelector<HTMLIFrameElement>("iframe")?.contentDocument;
          const node = doc?.querySelector(selector);
          if (!node) return null;
          const r = node.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) return null;
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        } catch {
          // Cross-origin / detached document / malformed selector — degrade to no overlay.
          return null;
        }
      },
      [],
    );

    const seekOffset = useCallback(
      (off: number) => {
        const r = replayerRef.current;
        const clock = clockRef.current;
        if (!r || !clock) return;
        const clamped = Math.max(0, Math.min(clock.total, off));
        try {
          setSelectorRect(null); // a scrub stales the picked-element box; the highlight flow re-measures after.
          if (playing) r.play(clamped);
          else r.pause(clamped);
          setOffset(clamped);
          onTimeUpdateRef.current(clock.start + clamped);
        } catch {
          /* seek is best-effort */
        }
      },
      [playing],
    );

    useImperativeHandle(ref, () => ({
      seekToEpoch: (epochMs: number) => {
        const clock = clockRef.current;
        if (!clock) return;
        seekOffset(epochMs - clock.start);
      },
      highlightSelector: (selector: string | null) => {
        if (!selector) {
          setSelectorRect(null);
          return;
        }
        // Defer one frame so a seek issued immediately before this has applied its DOM mutations.
        requestAnimationFrame(() => setSelectorRect(measureSelector(selector)));
      },
    }));

    // Marker positions as a fraction of the timeline (skip any that fall outside the recording window).
    const pins = useMemo(() => {
      const clock = clockRef.current;
      const t = total;
      if (!clock || t <= 0) return [];
      return markers
        .map((m, i) => ({ marker: m, index: i, frac: (m.t - clock.start) / t }))
        .filter((p) => p.frac >= 0 && p.frac <= 1);
    }, [markers, total]);

    const progress = total > 0 ? Math.max(0, Math.min(1, offset / total)) : 0;

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-4 py-12 text-center">
          <AlertTriangle className="size-5 text-destructive" />
          <p className="text-[13px] font-medium text-destructive">
            This session recording couldn't be played back.
          </p>
          <p className="text-[12px] text-muted-foreground">
            The capture may be from an incompatible recorder version. Try the Snapshot view.
          </p>
        </div>
      );
    }

    return (
      <StageShell
        expanded={expanded}
        onCollapse={() => setExpanded(false)}
        title="Session replay"
        controls={
          <ViewControls
            scale={scale}
            onScale={setScale}
            appliedScale={appliedScale}
            expanded={expanded}
            onToggleExpand={() => setExpanded((e) => !e)}
          />
        }
      >
        <div className={cn("flex min-w-0 gap-3", expanded ? "flex-col lg:flex-row" : "flex-col")}>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* rrweb's Replayer mounts its own iframe here; never React-managed children. */}
          <div
            ref={scrollBoxRef}
            className={cn(
              "be10x-rrweb relative overflow-auto rounded-lg border border-border/60 bg-white",
              expanded && "max-h-[calc(100vh-9rem)]",
            )}
          >
            {/* Content-sized wrapper so the picked-element overlays scroll in lockstep with the iframe. The
                first box is the hover highlight (stored page rect); the second is the click highlight, located
                live inside the iframe by CSS selector. */}
            <div className="relative inline-block align-top">
              <div ref={mountRef} className="block" />
              <PickOverlay rect={pickRect ?? null} scale={appliedScale} />
              <PickOverlay rect={selectorRect} scale={appliedScale} />
            </div>
          </div>

        {/* Controls: play/pause + a self-owned marker/playhead track synced to the replayer. */}
        <div className="select-none">
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => (playing ? pause() : play())}
                className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={playing ? "Pause replay" : "Play replay"}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </button>
              <span className="font-mono">
                {formatOffset(offset)} <span className="text-muted-foreground/50">/ {formatOffset(total)}</span>
              </span>
              <SpeedControl speed={speed} onChange={changeSpeed} />
            </div>
            <span className="inline-flex items-center gap-1">
              <Flag className="size-3" style={{ color: "var(--status-blocked)" }} />
              {pins.length} {pins.length === 1 ? "marker" : "markers"}
            </span>
          </div>
          <div
            className="group relative h-8 w-full cursor-pointer rounded-md border border-border/60 bg-muted"
            role="slider"
            aria-label="Session timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(offset)}
            tabIndex={0}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              seekOffset(((e.clientX - rect.left) / rect.width) * total);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") seekOffset(offset + 1000);
              else if (e.key === "ArrowLeft") seekOffset(offset - 1000);
              else if (e.key === " ") {
                e.preventDefault();
                playing ? pause() : play();
              }
            }}
          >
            <div
              className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-primary/15"
              style={{ width: `${progress * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-primary"
              style={{ left: `${progress * 100}%` }}
            />
            {pins.map((p) => (
              <button
                key={`${p.marker.t}-${p.index}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  seekOffset(p.marker.t - (clockRef.current?.start ?? 0));
                }}
                className="absolute top-0 z-20 flex h-full -translate-x-1/2 items-start outline-none"
                style={{ left: `${p.frac * 100}%` }}
                title={p.marker.label || "Marked moment"}
                aria-label={`Marker: ${p.marker.label || "Marked moment"}`}
              >
                <span
                  className="mt-0.5 grid size-4 place-items-center rounded-full text-white shadow-sm ring-2 ring-background transition-transform hover:scale-110"
                  style={{ backgroundColor: "var(--status-blocked)" }}
                >
                  <Flag className="size-2.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
          </div>
          {expanded && expandedAside ? (
            <aside className="w-full shrink-0 lg:w-[340px]">{expandedAside}</aside>
          ) : null}
        </div>
      </StageShell>
    );
  },
);

const SPEEDS = [0.5, 1, 2, 4, 8];

/** A compact segmented playback-speed control matching the view controls, shown next to Play/Pause. */
function SpeedControl({ speed, onChange }: { speed: number; onChange: (s: number) => void }) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
      role="group"
      aria-label="Playback speed"
    >
      {SPEEDS.map((s) => {
        const active = speed === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            aria-pressed={active}
            title={`${s}× speed`}
            className={cn(
              "rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}×
          </button>
        );
      })}
    </div>
  );
}
