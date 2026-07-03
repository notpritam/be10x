// ABOUTME: Renders an agent-authored plan/artifact as a real, rich artifact — sandboxed HTML, markdown,
// numbered steps, diagrams, code — instead of a JSON dump. The agent chooses the shape per task; this
// dispatches on it. Markdown/HTML rendering lives in ./rich-content (shared with comments, output, details,
// every DataValue string). Extensible: add a block type = one case.
import type { ReactNode } from "react";
import { ListChecks } from "lucide-react";
import { HtmlBlock, Markdown, looksLikeHtml } from "./rich-content";
import { MermaidDiagram } from "./MermaidDiagram";

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
  if (t === "diagram") return body ? <MermaidDiagram key={key} code={body} /> : null;
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
      {diagram && <MermaidDiagram code={diagram} />}
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
