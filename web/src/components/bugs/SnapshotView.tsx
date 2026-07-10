// ABOUTME: The static marked-moment view — renders the bug's rrweb DOM snapshot (domKey) through rrweb's core
// ABOUTME: Replayer as a paused Meta+FullSnapshot stream, with Fit/zoom + expand + pick overlay; falls back to the screenshot.
import { useCallback, useEffect, useRef, useState } from "react";
import { Replayer } from "rrweb";
import { Camera, ImageOff, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VIEW_SCALE,
  PickOverlay,
  StageShell,
  ViewControls,
  type ViewScale,
} from "./viewControls";

type SnapshotState = { state: "loading" } | { state: "ready" } | { state: "fallback"; reason: string };

/** Unwrap the serialized rrweb node from whatever the recorder uploaded as dom.json (the bare node, or a
 *  `{ node }` / `{ snapshot }` wrapper). The Replayer throws on anything invalid, which we catch to fallback. */
function unwrapNode(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.node && typeof obj.node === "object") return obj.node;
    if (obj.snapshot && typeof obj.snapshot === "object") return obj.snapshot;
  }
  return raw;
}

export function SnapshotView({
  bugId,
  domKey,
  screenshotUrl,
  viewport,
  pickRect,
}: {
  bugId: string;
  domKey: string | null;
  screenshotUrl: string | null;
  /** The recorded viewport — sizes the snapshot iframe (falls back to a sensible default when absent). */
  viewport?: { w: number; h: number };
  /** A picked element's page-pixel rect to highlight over the snapshot, or null. */
  pickRect?: { x: number; y: number; w: number; h: number } | null;
}) {
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);

  const [status, setStatus] = useState<SnapshotState>(
    domKey ? { state: "loading" } : { state: "fallback", reason: "no-snapshot" },
  );
  const [scale, setScale] = useState<ViewScale>(DEFAULT_VIEW_SCALE);
  const [expanded, setExpanded] = useState(false);
  const [appliedScale, setAppliedScale] = useState<number | null>(null);

  // Scale the fixed-size snapshot iframe to the container per the active Fit/100%/zoom mode. Mirrors
  // SessionReplay: measure the scroll box, transform the .replayer-wrapper, and size the mount so the box
  // can scroll it when zoomed past fit.
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

  // Build the paused snapshot. rrweb's Replayer renders a FullSnapshot into its own iframe synchronously, so
  // a minimal [Meta, FullSnapshot] stream (never played) shows the captured DOM exactly — styled, unlike the
  // old rebuildIntoSandboxedIframe path. This is the same core the (now-working) SessionReplay uses.
  useEffect(() => {
    if (!domKey) {
      setStatus({ state: "fallback", reason: "no-snapshot" });
      return;
    }
    let cancelled = false;
    const mount = mountRef.current;
    setStatus({ state: "loading" });

    let ro: ResizeObserver | null = null;
    api
      .loadBugArtifactJson<unknown>(bugId, "dom")
      .then((raw) => {
        if (cancelled || !mount) return;
        mount.innerHTML = "";
        const node = unwrapNode(raw);
        const w = viewport && viewport.w > 0 ? viewport.w : 1280;
        const h = viewport && viewport.h > 0 ? viewport.h : 800;
        // type 4 = Meta, type 2 = FullSnapshot (rrweb EventType). Cast the array because our `node` is the
        // untyped uploaded payload; the Replayer validates it and throws into the fallback if malformed.
        const events = [
          { type: 4, data: { href: "", width: w, height: h }, timestamp: 1 },
          { type: 2, data: { node, initialOffset: { left: 0, top: 0 } }, timestamp: 1 },
        ];
        const replayer = new Replayer(
          events as ConstructorParameters<typeof Replayer>[0],
          { root: mount, showWarning: false, mouseTail: false, useVirtualDom: false },
        );
        replayerRef.current = replayer;
        setStatus({ state: "ready" });
        fitRef.current();
        ro = new ResizeObserver(() => fitRef.current());
        ro.observe(scrollBoxRef.current ?? mount);
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: "fallback", reason: "rebuild-failed" });
      });

    return () => {
      cancelled = true;
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
      if (mount) mount.innerHTML = "";
    };
  }, [bugId, domKey, viewport]);

  // Re-fit when the scale mode or expand state changes (without rebuilding the Replayer).
  useEffect(() => {
    fitRef.current();
  }, [scale, expanded]);

  if (status.state === "fallback") {
    return (
      <div>
        {screenshotUrl ? (
          <figure className="space-y-2">
            <img
              src={screenshotUrl}
              alt="Captured screenshot of the marked moment"
              className="w-full rounded-lg border border-border/60"
            />
            {status.reason === "rebuild-failed" && (
              <figcaption className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Camera className="size-3.5" />
                Showing the screenshot — the DOM snapshot couldn't be rebuilt.
              </figcaption>
            )}
          </figure>
        ) : (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border/70 px-4 py-14 text-center text-[12.5px] text-muted-foreground/70">
            <ImageOff className="size-5 opacity-70" />
            No snapshot or screenshot was captured for this bug.
          </div>
        )}
      </div>
    );
  }

  return (
    <StageShell
      expanded={expanded}
      onCollapse={() => setExpanded(false)}
      title="Captured DOM snapshot"
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
      <div
        ref={scrollBoxRef}
        className={cn(
          "relative overflow-auto rounded-lg border border-border/60 bg-white",
          expanded ? "max-h-[calc(100vh-6rem)]" : "max-h-[70vh]",
        )}
      >
        {/* Content-sized wrapper so the overlay scrolls in lockstep with the iframe. */}
        <div className="relative inline-block align-top">
          {/* rrweb's Replayer mounts its own iframe here; never React-managed children. */}
          <div ref={mountRef} className="block" />
          <PickOverlay rect={pickRect ?? null} scale={appliedScale} />
        </div>
        {status.state === "loading" && (
          <div className="absolute inset-0 z-10 flex items-center gap-2 bg-card/80 px-4 py-8 text-[13px] text-muted-foreground backdrop-blur-sm">
            <Loader2 className="size-4 animate-spin" /> Rebuilding the captured DOM…
          </div>
        )}
      </div>
    </StageShell>
  );
}
