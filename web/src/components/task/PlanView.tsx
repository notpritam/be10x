// ABOUTME: Renders an agent-authored plan as a real, rich artifact — sandboxed HTML the agent wrote
// directly, markdown, numbered steps, diagrams, code — instead of a JSON dump. The agent chooses the
// shape per task; this dispatches on it. HTML runs in a sandboxed iframe (scripts, no same-origin) so
// agent output can visualize/animate without touching the app. Extensible: add a block type = one case.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitBranch, ListChecks } from "lucide-react";

type Block = Record<string, unknown> & { type?: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function firstStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return null;
}
function looksLikeHtml(s: string): boolean {
  return /<([a-z]+)(\s[^>]*)?>/i.test(s) && /<\/[a-z]+>|\/>/i.test(s);
}

// Agent HTML in a sandboxed iframe. `allow-scripts` (no `allow-same-origin`) => scripts run but can't
// reach the parent DOM/cookies. The injected reporter posts the content height back for auto-sizing.
function HtmlBlock({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data;
      if (d && typeof d === "object" && "__be10xHeight" in d && ref.current && e.source === ref.current.contentWindow) {
        setHeight(Math.min(2400, Math.max(60, Number((d as { __be10xHeight: number }).__be10xHeight) + 8)));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const reporter =
    "function r(){parent.postMessage({__be10xHeight:document.documentElement.scrollHeight},'*')}" +
    "addEventListener('load',r);setTimeout(r,50);setTimeout(r,400);" +
    "try{new ResizeObserver(r).observe(document.body)}catch(e){}";
  const doc =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<style>:root{color-scheme:light}body{margin:0;padding:14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1c1917;background:transparent}" +
    "*{box-sizing:border-box}img,svg,canvas,table{max-width:100%}pre{overflow:auto}</style></head><body>" +
    html +
    "<" + "script>" + reporter + "<" + "/script></body></html>";

  return (
    <iframe
      ref={ref}
      title="agent-rendered plan"
      srcDoc={doc}
      sandbox="allow-scripts"
      className="w-full rounded-lg border border-border/60 bg-card"
      style={{ height }}
    />
  );
}

// Deliberately-basic markdown (headings, bullets, fenced code, inline bold/italic/code) — enough to read
// a plan; the agent reaches for an html block when it wants real richness.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<b key={k} className="font-semibold text-foreground">{tok.slice(2, -2)}</b>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{tok.slice(1, -1)}</code>);
    else out.push(<i key={k}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      nodes.push(
        <pre key={key++} className="scroll-thin overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">{buf.join("\n")}</pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const size = h[1].length === 1 ? "text-[15px]" : h[1].length === 2 ? "text-[13.5px]" : "text-[12.5px]";
      nodes.push(<p key={key++} className={`font-semibold text-foreground ${size}`}>{inline(h[2], `h${key}`)}</p>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      nodes.push(
        <ul key={key++} className="list-disc space-y-1 pl-5 text-[13px] leading-snug text-foreground/90">
          {items.map((it, j) => <li key={j}>{inline(it, `li${key}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```") && !/^\s*[-*]\s+/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i]))
      para.push(lines[i++]);
    nodes.push(<p key={key++} className="whitespace-pre-wrap text-[13px] leading-snug text-foreground/90">{inline(para.join(" "), `p${key}`)}</p>);
  }
  return <div className="space-y-2.5">{nodes}</div>;
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <ListChecks className="size-3.5" /> Steps
      </p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{i + 1}</span>
            <span className="whitespace-pre-wrap text-[13px] leading-snug text-foreground/90">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Mono({ label, icon, content }: { label: string; icon: ReactNode; content: string }) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{icon} {label}</p>
      <pre className="scroll-thin overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">{content}</pre>
    </div>
  );
}

function toSteps(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
}

function renderBlock(block: Block, key: number): ReactNode {
  const t = (block.type ?? "").toLowerCase();
  const body = firstStr(block, ["html", "markdown", "md", "text", "content", "code", "diagram"]);
  if (t === "html" || (!block.type && str(block.html))) {
    const html = str(block.html) ?? body;
    return html ? <HtmlBlock key={key} html={html} /> : null;
  }
  if (t === "steps") { const s = toSteps(block.steps); return s ? <Steps key={key} steps={s} /> : null; }
  if (t === "diagram") return body ? <Mono key={key} label="Diagram" icon={<GitBranch className="size-3.5" />} content={body} /> : null;
  if (t === "code") return body ? <Mono key={key} label="Code" icon={<ListChecks className="size-3.5" />} content={body} /> : null;
  if (t === "markdown" || t === "md") return body ? <Markdown key={key} text={body} /> : null;
  // default: markdown-ish text (or HTML if it clearly is)
  if (body) return looksLikeHtml(body) ? <HtmlBlock key={key} html={body} /> : <Markdown key={key} text={body} />;
  return null;
}

export function PlanView({ plan }: { plan: unknown }) {
  if (plan == null) return null;

  // A bare string: HTML if it looks like it, else markdown.
  if (typeof plan === "string") {
    return looksLikeHtml(plan) ? <HtmlBlock html={plan} /> : <Markdown text={plan} />;
  }

  const obj = typeof plan === "object" && !Array.isArray(plan) ? (plan as Record<string, unknown>) : null;

  // A mixed block list — the fully generative form.
  if (obj && Array.isArray(obj.blocks)) {
    return <div className="space-y-4">{(obj.blocks as Block[]).map((b, i) => renderBlock(b ?? {}, i))}</div>;
  }

  const html = obj && str(obj.html);
  const markdown = obj && firstStr(obj, ["markdown", "md"]);
  const steps = toSteps(obj?.steps) ?? toSteps(plan);
  const diagram = obj && firstStr(obj, ["diagram"]);
  const rest = obj
    ? Object.entries(obj).filter(([k, v]) => !["html", "markdown", "md", "steps", "diagram", "blocks"].includes(k) && v != null && v !== "")
    : [];

  if (!html && !markdown && !steps && !diagram) {
    return (
      <pre className="scroll-thin overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {JSON.stringify(plan, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-4">
      {html && <HtmlBlock html={html} />}
      {markdown && <Markdown text={markdown} />}
      {steps && steps.length > 0 && <Steps steps={steps} />}
      {diagram && <Mono label="Diagram" icon={<GitBranch className="size-3.5" />} content={diagram} />}
      {rest.length > 0 && (
        <div className="space-y-1.5 border-t border-border/50 pt-3">
          {rest.map(([k, v]) => (
            <div key={k} className="text-[12.5px] leading-snug">
              <span className="font-medium capitalize text-foreground/80">{k.replace(/_/g, " ")}: </span>
              <span className="whitespace-pre-wrap text-muted-foreground">{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
