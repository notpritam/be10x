// ABOUTME: The "Source & resources" panel — loads the source.json artifact (rendered HTML + inline
// ABOUTME: scripts/styles + the PerformanceResourceTiming manifest) and shows it in collapsible sections, so a
// ABOUTME: developer can read the markup/JS that shipped and see everything the page loaded. Self-contained.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, Code2, FileCode2, Loader2, Network, Palette } from "lucide-react";
import type { ArtifactSource } from "@/lib/api";
import type { BugSource, SourceResource } from "@/lib/types";
import { cn } from "@/lib/utils";

type Fetch<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error" };

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function SourcePanel({ artifacts }: { artifacts: ArtifactSource }) {
  const [src, setSrc] = useState<Fetch<BugSource>>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setSrc({ state: "loading" });
    artifacts
      .loadJson<BugSource>("source")
      .then((data) => !cancelled && setSrc({ state: "ready", data }))
      .catch(() => !cancelled && setSrc({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  return (
    <section className="rounded-[8px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <FileCode2 className="size-4 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Source &amp; resources</h2>
      </div>

      {src.state === "loading" ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading captured source…
        </div>
      ) : src.state === "error" ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-4 text-[12.5px] text-destructive">
          <AlertTriangle className="size-4" /> The source bundle couldn&apos;t be loaded.
        </div>
      ) : (
        <SourceBody source={src.data} />
      )}
    </section>
  );
}

function SourceBody({ source }: { source: BugSource }) {
  const resources = source.resources ?? [];
  const scripts = source.scripts ?? [];
  const styles = source.styles ?? [];
  const totalTransfer = useMemo(() => resources.reduce((a, r) => a + (r.transferBytes || 0), 0), [resources]);

  return (
    <div className="space-y-2.5">
      <Section
        icon={<Network className="size-3.5 text-muted-foreground" />}
        title="Resources"
        count={source.resourceCount ?? resources.length}
        subtitle={totalTransfer > 0 ? `${formatBytes(totalTransfer)} transferred` : undefined}
        defaultOpen
      >
        <ResourceTable resources={resources} truncated={source.resourcesTruncated} />
      </Section>

      <Section icon={<Code2 className="size-3.5 text-muted-foreground" />} title="Inline scripts" count={scripts.length}>
        <CodeList items={scripts.map((s) => ({ label: `${s.type ?? "script"} · ${formatBytes(s.bytes)}${s.truncated ? " · truncated" : ""}`, text: s.text }))} />
      </Section>

      <Section icon={<Palette className="size-3.5 text-muted-foreground" />} title="Inline styles" count={styles.length}>
        <CodeList items={styles.map((s, i) => ({ label: `style #${i + 1} · ${formatBytes(s.bytes)}${s.truncated ? " · truncated" : ""}`, text: s.text }))} />
      </Section>

      {(source.stylesheets?.length || source.externalScripts?.length) && (
        <Section icon={<FileCode2 className="size-3.5 text-muted-foreground" />} title="External references" count={(source.stylesheets?.length ?? 0) + (source.externalScripts?.length ?? 0)}>
          <ul className="space-y-1 py-1">
            {source.externalScripts?.map((s, i) => (
              <li key={`js-${i}`} className="flex items-center gap-2 text-[11.5px]">
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">js</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={s.src}>{s.src}</span>
                {(s.async || s.defer) && <span className="shrink-0 text-[10px] text-muted-foreground">{s.async ? "async" : "defer"}</span>}
              </li>
            ))}
            {source.stylesheets?.map((href, i) => (
              <li key={`css-${i}`} className="flex items-center gap-2 text-[11.5px]">
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">css</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={href}>{href}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {source.html != null && (
        <Section icon={<Code2 className="size-3.5 text-muted-foreground" />} title="Rendered HTML" subtitle={`${formatBytes(source.htmlBytes)}${source.htmlTruncated ? " · truncated" : ""}`}>
          <pre className="max-h-[440px] overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground/90 scroll-thin">
            {source.html}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  subtitle,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = count === 0;
  return (
    <div className="rounded-lg border border-border/60 bg-background">
      <button
        type="button"
        disabled={empty}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          empty ? "cursor-default opacity-60" : "hover:bg-accent/40",
        )}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && !empty && "rotate-90")} />
        {icon}
        <span className="text-[12.5px] font-semibold text-foreground">{title}</span>
        {count != null && <span className="text-[11px] text-muted-foreground">{count}</span>}
        {subtitle && <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">{subtitle}</span>}
      </button>
      {open && !empty && <div className="border-t border-border/50 px-3 pb-2">{children}</div>}
    </div>
  );
}

const SIZE_SORTED = (a: SourceResource, b: SourceResource) => (b.transferBytes || 0) - (a.transferBytes || 0);

function ResourceTable({ resources, truncated }: { resources: SourceResource[]; truncated?: boolean }) {
  const rows = useMemo(() => [...resources].sort(SIZE_SORTED).slice(0, 120), [resources]);
  if (resources.length === 0) return <p className="py-3 text-[11.5px] text-muted-foreground/70">No resource timing captured.</p>;
  return (
    <div className="overflow-x-auto py-1 scroll-thin">
      <table className="w-full text-left text-[11.5px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            <th className="py-1 pr-2 font-medium">Resource</th>
            <th className="py-1 pr-2 font-medium">Type</th>
            <th className="py-1 pr-2 text-right font-medium">Size</th>
            <th className="py-1 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/40">
              <td className="max-w-0 py-1 pr-2">
                <span className="block truncate font-mono text-foreground/85" title={r.url}>{r.url}</span>
              </td>
              <td className="py-1 pr-2">
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{r.type || "—"}</span>
              </td>
              <td className="whitespace-nowrap py-1 pr-2 text-right font-mono text-muted-foreground">{formatBytes(r.transferBytes)}</td>
              <td className="whitespace-nowrap py-1 text-right font-mono text-muted-foreground">{r.durationMs ? `${Math.round(r.durationMs)}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(resources.length > rows.length || truncated) && (
        <p className="pt-1.5 text-[10.5px] text-muted-foreground/70">
          Showing the {rows.length} largest{truncated ? " (capture was capped)" : ` of ${resources.length}`}.
        </p>
      )}
    </div>
  );
}

function CodeList({ items }: { items: { label: string; text: string }[] }) {
  if (items.length === 0) return <p className="py-3 text-[11.5px] text-muted-foreground/70">None captured.</p>;
  return (
    <ul className="space-y-1.5 py-1.5">
      {items.map((it, i) => (
        <CodeItem key={i} label={it.label} text={it.text} />
      ))}
    </ul>
  );
}

function CodeItem({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border/50 bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      </button>
      {open && (
        <pre className="max-h-[320px] overflow-auto border-t border-border/40 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90 scroll-thin">
          {text}
        </pre>
      )}
    </li>
  );
}
