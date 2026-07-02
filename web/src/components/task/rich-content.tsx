// ABOUTME: Shared rich-content rendering for the task views — turns agent/human text into real formatting
// instead of raw characters. Markdown (headings, lists incl. nesting, tables, fenced code, blockquotes,
// links, emphasis) is rendered to styled React nodes (no HTML injection); strings that are actually JSON
// are detected (parseStructured) so callers can render them as structure; and agent-authored HTML runs in
// a sandboxed iframe (HtmlBlock). One renderer, used by the plan view, artifacts, agent output, comments,
// and every DataValue string — so anything the agent writes reads the way it was meant to.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

export function looksLikeHtml(s: string): boolean {
  return /<([a-z]+)(\s[^>]*)?>/i.test(s) && /<\/[a-z]+>|\/>/i.test(s);
}

// If a string is really a JSON object/array, return the parsed value so the caller can render it as
// structure (a checklist, a key/value tree, …) instead of a wall of braces. Anything else → null. We only
// attempt a parse when it plausibly *is* JSON (starts/ends with matching brackets) to avoid mangling prose.
export function parseStructured(text: string): unknown | null {
  const t = text.trim();
  if (t.length < 2) return null;
  const a = t[0];
  const b = t[t.length - 1];
  if (!((a === "{" && b === "}") || (a === "[" && b === "]"))) return null;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// agent HTML — sandboxed iframe (scripts run, but can't reach parent DOM/cookies)
// ---------------------------------------------------------------------------

export function HtmlBlock({ html }: { html: string }) {
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
      title="agent-rendered content"
      srcDoc={doc}
      sandbox="allow-scripts"
      className="w-full rounded-lg border border-border/60 bg-card"
      style={{ height }}
    />
  );
}

// ---------------------------------------------------------------------------
// inline markdown
// ---------------------------------------------------------------------------

// code, **bold**, ~~strike~~, *italic*, [text](url) and bare URLs. Underscore emphasis is deliberately NOT
// supported: snake_case identifiers (in_progress, seen_at, pick_up_now) are everywhere in this domain and
// would be mangled into italics. Everything is built as React nodes, so there is no HTML-injection risk.
type InlineRule = { name: "code" | "bold" | "strike" | "italic" | "link" | "url"; re: RegExp };
const INLINE_RULES: InlineRule[] = [
  { name: "code", re: /`([^`]+)`/ },
  // bold allows any inner content (so *italic* / `code` nested inside **bold** survives, via recursion),
  // stopping lazily at the first closing **.
  { name: "bold", re: /\*\*([\s\S]+?)\*\*/ },
  { name: "strike", re: /~~([^~]+?)~~/ },
  { name: "italic", re: /\*([^*\n]+?)\*/ },
  { name: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { name: "url", re: /\bhttps?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/ },
];

export function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  let guard = 0;
  while (rest.length && guard++ < 5000) {
    let best: RegExpExecArray | null = null;
    let bestRule: InlineRule | null = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = m;
        bestRule = rule;
      }
    }
    if (!best || !bestRule) {
      out.push(rest);
      break;
    }
    if (best.index > 0) out.push(rest.slice(0, best.index));
    const k = `${keyBase}-${n++}`;
    const inner = best[1] ?? "";
    switch (bestRule.name) {
      case "code":
        out.push(
          <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.86em] text-foreground/90">
            {inner}
          </code>,
        );
        break;
      case "bold":
        out.push(
          <b key={k} className="font-semibold text-foreground">
            {inline(inner, k)}
          </b>,
        );
        break;
      case "strike":
        out.push(
          <s key={k} className="text-muted-foreground">
            {inline(inner, k)}
          </s>,
        );
        break;
      case "italic":
        out.push(<i key={k}>{inline(inner, k)}</i>);
        break;
      case "link":
        out.push(
          <a
            key={k}
            href={best[2]}
            target="_blank"
            rel="noreferrer"
            className="break-words text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {inline(inner, k)}
          </a>,
        );
        break;
      case "url": {
        const href = best[0];
        out.push(
          <a
            key={k}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {href}
          </a>,
        );
        break;
      }
    }
    rest = rest.slice(best.index + best[0].length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// block markdown
// ---------------------------------------------------------------------------

const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;

// A GitHub-style table separator row: only |, -, :, spaces, has at least one '-' and at least one '|'.
function isTableSep(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && t.includes("-") && /^\|?[\s:|-]+\|?$/.test(t);
}
function splitCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}
function cellAligns(sep: string): (CSSProperties["textAlign"] | null)[] {
  return splitCells(sep).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

type RawItem = { indent: number; ordered: boolean; content: string };

// Build a (possibly nested) list from a contiguous run of list lines, nesting by indentation.
function consumeList(items: RawItem[], start: number, minIndent: number, keyBase: string): { node: ReactNode; next: number } {
  const ordered = items[start].ordered;
  const lis: ReactNode[] = [];
  let i = start;
  let k = 0;
  while (i < items.length && items[i].indent >= minIndent) {
    if (items[i].indent > minIndent) {
      const sub = consumeList(items, i, items[i].indent, `${keyBase}-${k}o`);
      lis.push(
        <li key={k++} className="list-none">
          {sub.node}
        </li>,
      );
      i = sub.next;
      continue;
    }
    const cur = items[i];
    const kids: ReactNode[] = [<span key="t">{inline(cur.content, `${keyBase}-${k}`)}</span>];
    i++;
    if (i < items.length && items[i].indent > cur.indent) {
      const sub = consumeList(items, i, items[i].indent, `${keyBase}-${k}c`);
      kids.push(
        <div key="c" className="mt-1">
          {sub.node}
        </div>,
      );
      i = sub.next;
    }
    lis.push(<li key={k++}>{kids}</li>);
  }
  const Tag = ordered ? "ol" : "ul";
  const node = (
    <Tag
      key={keyBase}
      className={cn(
        ordered ? "list-decimal" : "list-disc",
        "space-y-1 pl-5 text-[13px] leading-snug text-foreground/90 marker:text-muted-foreground/60",
      )}
    >
      {lis}
    </Tag>
  );
  return { node, next: i };
}

function renderBlocks(text: string, keyBase = "b"): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const kk = () => `${keyBase}-${key++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2];
      const close = new RegExp(`^ {0,3}\\${marker}{3,}\\s*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++; // consume the closing fence
      nodes.push(
        <div key={kk()} className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
          {lang ? (
            <div className="border-b border-border/50 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
              {lang}
            </div>
          ) : null}
          <pre className="scroll-thin overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">
            <code>{buf.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // horizontal rule
    if (HR_RE.test(line)) {
      nodes.push(<hr key={kk()} className="border-border/60" />);
      i++;
      continue;
    }

    // heading
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level <= 1 ? "text-[15px]" : level === 2 ? "text-[13.5px]" : "text-[12.5px]";
      const id = kk();
      nodes.push(
        <p key={id} className={cn("font-semibold text-foreground", size, level <= 2 && "mt-1")}>
          {inline(h[2], id)}
        </p>,
      );
      i++;
      continue;
    }

    // table (header row + separator row + body rows)
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitCells(line);
      const al = cellAligns(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "" && !isTableSep(lines[i])) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      const id = kk();
      const align = (idx: number): CSSProperties => (al[idx] ? { textAlign: al[idx] as CSSProperties["textAlign"] } : {});
      nodes.push(
        <div key={id} className="scroll-thin overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border/70 bg-muted/40">
                {header.map((c, idx) => (
                  <th key={idx} style={align(idx)} className="px-2.5 py-1.5 text-left font-semibold text-foreground">
                    {inline(c, `${id}h${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/40 last:border-0">
                  {header.map((_, ci) => (
                    <td key={ci} style={align(ci)} className="px-2.5 py-1.5 align-top text-foreground/85">
                      {inline(r[ci] ?? "", `${id}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // blockquote
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      const id = kk();
      nodes.push(
        <blockquote key={id} className="space-y-2 border-l-2 border-primary/40 pl-3 text-foreground/80">
          {renderBlocks(buf.join("\n"), id)}
        </blockquote>,
      );
      continue;
    }

    // list (ordered / unordered, with nesting)
    if (LIST_RE.test(line)) {
      const raw: RawItem[] = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = LIST_RE.exec(lines[i]) as RegExpExecArray;
        raw.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), content: m[3] });
        i++;
      }
      nodes.push(consumeList(raw, 0, raw[0].indent, kk()).node);
      continue;
    }

    // paragraph — soft line breaks preserved (whitespace-pre-wrap)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    const id = kk();
    nodes.push(
      <p key={id} className="whitespace-pre-wrap break-words text-[13px] leading-snug text-foreground/90">
        {inline(para.join("\n"), id)}
      </p>,
    );
  }

  return nodes;
}

// A block of markdown → styled React. Safe (no dangerouslySetInnerHTML); the agent reaches for an html
// block only when it wants real richness (charts, animation), which HtmlBlock renders sandboxed.
export function Markdown({ text }: { text: string }) {
  if (!text || !text.trim()) return null;
  return <div className="space-y-2.5 break-words">{renderBlocks(text)}</div>;
}
