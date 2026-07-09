// ABOUTME: Mounts rrweb-player for a bug's captured session and draws a self-owned marker/playhead track
// ABOUTME: beneath it (clickable pins seek the player). Exposes an imperative seekToEpoch for markers/visits.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import { AlertTriangle, Flag } from "lucide-react";
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

/** rrweb-player is a compiled Svelte component; its instance carries $set/$destroy from the Svelte base
 *  (not surfaced on the exported prop types), so we widen the constructed instance to reach them safely. */
type PlayerInstance = InstanceType<typeof rrwebPlayer> & {
  $set?: (props: Record<string, unknown>) => void;
  $destroy?: () => void;
};

interface SessionReplayProps {
  events: unknown[];
  markers: BugMarker[];
  /** The recorded viewport, used to keep the player's aspect ratio faithful when it's absent we assume 16:10. */
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
    const playerRef = useRef<PlayerInstance | null>(null);
    const clockRef = useRef<ReplayClock | null>(null);
    const lastEmitRef = useRef(0);

    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState(false);

    // Keep the latest callbacks in refs so the (heavy) player-construction effect can stay events-only and
    // never tears the Svelte component down just because a parent re-rendered with new closure identities.
    const onClockReadyRef = useRef(onClockReady);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    useEffect(() => {
      onClockReadyRef.current = onClockReady;
      onTimeUpdateRef.current = onTimeUpdate;
    });

    useEffect(() => {
      const target = mountRef.current;
      if (!target || !events || events.length === 0) return;

      let player: PlayerInstance | null = null;
      try {
        const width = target.clientWidth || 720;
        const aspect = viewport && viewport.w > 0 ? viewport.h / viewport.w : 0.62;
        const height = Math.round(Math.min(Math.max(width * aspect, 320), 560));
        player = new rrwebPlayer({
          target,
          props: {
            events: events as ConstructorParameters<typeof rrwebPlayer>[0]["props"]["events"],
            showController: true,
            autoPlay: false,
            mouseTail: false,
            width,
            height,
          },
        }) as PlayerInstance;

        const meta = player.getMetaData();
        const clock: ReplayClock = {
          start: meta.startTime,
          end: meta.endTime,
          total: meta.totalTime,
        };
        clockRef.current = clock;
        setTotal(clock.total);
        onClockReadyRef.current(clock);

        player.addEventListener("ui-update-current-time", (payload) => {
          const off = (payload as { payload: number }).payload;
          setOffset(off);
          const now = performance.now();
          if (now - lastEmitRef.current >= 50) {
            lastEmitRef.current = now;
            onTimeUpdateRef.current(clock.start + off);
          }
        });
      } catch {
        setError(true);
      }
      playerRef.current = player;

      // Keep the player fitted to its container as the panel resizes (real responsiveness, not just at mount).
      const ro = new ResizeObserver(() => {
        const p = playerRef.current;
        if (!p || !target.clientWidth) return;
        const w = target.clientWidth;
        const aspect = viewport && viewport.w > 0 ? viewport.h / viewport.w : 0.62;
        const h = Math.round(Math.min(Math.max(w * aspect, 320), 560));
        try {
          p.$set?.({ width: w, height: h });
          p.triggerResize();
        } catch {
          /* fitting is best-effort — never throw into the host view */
        }
      });
      ro.observe(target);

      return () => {
        ro.disconnect();
        try {
          playerRef.current?.$destroy?.();
        } catch {
          /* teardown is best-effort */
        }
        playerRef.current = null;
        clockRef.current = null;
        // The Svelte component removes its own nodes, but clear the mount defensively for HMR / remounts.
        if (target) target.innerHTML = "";
      };
    }, [events, viewport]);

    const seekOffset = (off: number) => {
      const clock = clockRef.current;
      const player = playerRef.current;
      if (!clock || !player) return;
      const clamped = Math.max(0, Math.min(clock.total, off));
      try {
        player.goto(clamped);
        setOffset(clamped);
        onTimeUpdateRef.current(clock.start + clamped);
      } catch {
        /* seek is best-effort */
      }
    };

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
        {/* rrweb-player mounts here; it owns its own DOM (never React-managed children). */}
        <div className="be10x-rrweb overflow-hidden rounded-lg border border-border/60 bg-card">
          <div ref={mountRef} />
        </div>

        {/* Self-owned marker + playhead track, synced to the player and robust to its internal DOM. */}
        <div className="select-none">
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span className="font-mono">
              {formatOffset(offset)} <span className="text-muted-foreground/50">/ {formatOffset(total)}</span>
            </span>
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
