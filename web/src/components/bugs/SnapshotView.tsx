// ABOUTME: The static marked-moment view — rebuilds the bug's rrweb DOM snapshot (domKey) into a sandboxed
// ABOUTME: iframe (no scripts run). Falls back to the cover screenshot when the snapshot is absent or unusable.
import { useEffect, useRef, useState } from "react";
import { createCache, Mirror, rebuildIntoSandboxedIframe } from "rrweb-snapshot";
import { Camera, ImageOff, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

type SnapshotState =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "fallback"; reason: string };

/** Unwrap the serialized rrweb node from whatever the recorder uploaded as dom.json (the bare node, or a
 *  `{ node }` / `{ snapshot }` wrapper). rebuild throws on anything invalid, which we catch into a fallback. */
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
}: {
  bugId: string;
  domKey: string | null;
  screenshotUrl: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<SnapshotState>(
    domKey ? { state: "loading" } : { state: "fallback", reason: "no-snapshot" },
  );

  useEffect(() => {
    if (!domKey) {
      setStatus({ state: "fallback", reason: "no-snapshot" });
      return;
    }
    let cancelled = false;
    const host = hostRef.current;
    setStatus({ state: "loading" });

    api
      .loadBugArtifactJson<unknown>(bugId, "dom")
      .then((raw) => {
        if (cancelled || !host) return;
        host.innerHTML = "";
        const { iframe } = rebuildIntoSandboxedIframe(
          unwrapNode(raw) as Parameters<typeof rebuildIntoSandboxedIframe>[0],
          { root: host, cache: createCache(), mirror: new Mirror() },
        );
        iframe.setAttribute("title", "Captured DOM snapshot");
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "0";
        iframe.style.display = "block";
        setStatus({ state: "ready" });
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: "fallback", reason: "rebuild-failed" });
      });

    return () => {
      cancelled = true;
      if (host) host.innerHTML = "";
    };
  }, [bugId, domKey]);

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
    <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card">
      {status.state === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center gap-2 bg-card/80 px-4 py-8 text-[13px] text-muted-foreground backdrop-blur-sm">
          <Loader2 className="size-4 animate-spin" /> Rebuilding the captured DOM…
        </div>
      )}
      {/* rebuildIntoSandboxedIframe appends a sandbox="allow-same-origin" iframe (scripts never run) here. */}
      <div ref={hostRef} className="h-[560px] w-full" />
    </div>
  );
}
