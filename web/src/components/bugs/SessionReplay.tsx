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
} from "react";
import { Replayer } from "rrweb";
import { AlertTriangle, Flag, Pause, Play } from "lucide-react";
import type { BugMarker } from "@/lib/types";

/** The replay clock, in epoch ms + total duration — everything else (markers, network) maps onto this. */
export interface ReplayClock {
  start: number;
  end: number;
  total: number;
}

/** Imperative handle so parents (marker list, visits rail, network rows) can seek the player by wall time. */
export interface SessionReplayHandle {
  seekToEpoch: (epochMs: number) => void;
}

interface SessionReplayProps {
  events: unknown[];
  markers: BugMarker[];
  /** The recorded viewport — used to scale the fixed-size replay iframe to fit our container. */
  viewport?: { w: number; h: number };
  onClockReady: (clock: ReplayClock) => void;
  /** Playhead position in epoch ms — throttled to ~20 Hz so downstream (network highlight) stays cheap. */
  onTimeUpdate: (epochMs: number) => void;
}

function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const SessionReplay = forwardRef<SessionReplayHandle, SessionReplayProps>(
  function SessionReplay({ events, markers, viewport, onClockReady, onTimeUpdate }, ref) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const replayerRef = useRef<Replayer | null>(null);
    const clockRef = useRef<ReplayClock | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastEmitRef = useRef(0);

    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [error, setError] = useState(false);

    const onClockReadyRef = useRef(onClockReady);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    useEffect(() => {
      onClockReadyRef.current = onClockReady;
      onTimeUpdateRef.current = onTimeUpdate;
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

        // The replay iframe renders at the recorded viewport size; scale the wrapper to fit our column.
        const fit = () => {
          const wrapper = target.querySelector<HTMLElement>(".replayer-wrapper");
          const iframe = target.querySelector<HTMLIFrameElement>("iframe");
          if (!wrapper || !iframe) return;
          iframe.style.border = "0";
          const w = viewport && viewport.w > 0 ? viewport.w : Number(iframe.getAttribute("width")) || 1280;
          const h = viewport && viewport.h > 0 ? viewport.h : Number(iframe.getAttribute("height")) || 800;
          const scale = target.clientWidth > 0 ? target.clientWidth / w : 1;
          wrapper.style.transform = `scale(${scale})`;
          wrapper.style.transformOrigin = "top left";
          target.style.height = `${Math.round(h * scale)}px`;
        };
        fit();
        ro = new ResizeObserver(fit);
        ro.observe(target);

        replayer.on("finish", () => {
          setPlaying(false);
          stopRaf();
        });
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
    }, [events, viewport, stopRaf]);

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

    const seekOffset = useCallback(
      (off: number) => {
        const r = replayerRef.current;
        const clock = clockRef.current;
        if (!r || !clock) return;
        const clamped = Math.max(0, Math.min(clock.total, off));
        try {
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
      <div className="flex flex-col gap-3">
        {/* rrweb's Replayer mounts its own iframe here; never React-managed children. */}
        <div className="be10x-rrweb overflow-hidden rounded-lg border border-border/60 bg-white">
          <div ref={mountRef} />
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
    );
  },
);
