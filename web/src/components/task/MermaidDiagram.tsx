// ABOUTME: Renders agent-authored diagram syntax (Mermaid — flowcharts, sequence/class/state/ER
// diagrams, etc.) as a real visual diagram instead of dumping the raw text. mermaid is dynamically
// imported so it never bloats the main bundle for tasks that never show one; the computed SVG is
// handed to HtmlBlock — the same sandboxed-iframe renderer every other agent-authored markup goes
// through — rather than injected into the main DOM directly. Falls back to the raw text (the same
// monospace box the caller used before this existed) whenever the content isn't valid Mermaid
// syntax, so nothing an agent writes is ever silently lost.
import { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { HtmlBlock } from "./rich-content";

async function importMermaid() {
  const mod = await import("mermaid");
  mod.default.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
  return mod.default;
}
let mermaidPromise: ReturnType<typeof importMermaid> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = importMermaid();
  return mermaidPromise;
}

let idSeq = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setSvg(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(`be10x-diagram-${idSeq++}`, code.trim()))
      .then(({ svg: rendered }) => {
        if (mountedRef.current) setSvg(rendered);
      })
      .catch(() => {
        /* not valid Mermaid syntax, or failed to load — stays null, falls back to raw text below */
      });
    return () => {
      mountedRef.current = false;
    };
  }, [code]);

  if (svg) return <HtmlBlock html={svg} />;

  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <GitBranch className="size-3.5" /> Diagram
      </p>
      <pre className="scroll-thin overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {code}
      </pre>
    </div>
  );
}
