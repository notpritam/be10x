// ABOUTME: A "Downloads" card listing every captured artifact (screenshot / session / network / DOM / source)
// ABOUTME: with a one-click save. Fetches the short-lived signed URL and downloads it as a Blob (same fetch the
// ABOUTME: replay already relies on); falls back to opening in a new tab. Self-contained — dashboard + public.
import { useState } from "react";
import { Clapperboard, Code2, Download, FileJson, Image as ImageIcon, Loader2, Network } from "lucide-react";
import type { ArtifactSource, BugArtifactKind } from "@/lib/api";
import type { Bug } from "@/lib/types";
import { cn } from "@/lib/utils";

const ITEMS: { kind: BugArtifactKind; label: string; icon: typeof Download; ext: string }[] = [
  { kind: "screenshot", label: "Screenshot", icon: ImageIcon, ext: "png" },
  { kind: "session", label: "Session recording", icon: Clapperboard, ext: "json" },
  { kind: "network", label: "Network log", icon: Network, ext: "json" },
  { kind: "dom", label: "DOM snapshot", icon: Code2, ext: "json" },
  { kind: "source", label: "Page source", icon: FileJson, ext: "json" },
];

const KEY_FIELD: Record<BugArtifactKind, keyof Bug> = {
  screenshot: "screenshotKey",
  session: "sessionKey",
  network: "networkKey",
  dom: "domKey",
  source: "sourceKey",
};

export function ArtifactDownloads({ bug, artifacts }: { bug: Bug; artifacts: ArtifactSource }) {
  const [busy, setBusy] = useState<BugArtifactKind | null>(null);
  const present = ITEMS.filter((it) => !!bug[KEY_FIELD[it.kind]]);
  if (present.length === 0) return null;

  const save = async (kind: BugArtifactKind, ext: string) => {
    setBusy(kind);
    try {
      const { url } = await artifacts.url(kind);
      const filename = `${bug.humanId}-${kind}.${ext}`;
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const obj = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = obj;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(obj), 1000);
      } catch {
        // Cross-origin fetch blocked → still give them the file by opening the signed URL.
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch {
      /* couldn't sign the URL — best-effort affordance */
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Download className="size-4 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Downloads</h2>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {present.map((it) => {
          const Icon = it.icon;
          const isBusy = busy === it.kind;
          return (
            <li key={it.kind}>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void save(it.kind, it.ext)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-left text-[12.5px] transition-colors",
                  "hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{it.label}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/70">{it.ext}</span>
                {isBusy ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Download className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-muted-foreground/70">
        Each opens a short-lived signed link. The network log also exports as HAR from the replay panel.
      </p>
    </section>
  );
}
