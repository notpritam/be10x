// ABOUTME: Shared presentational atoms for the task views — the meta bits, move buttons, content
// renderer, agent block and the header icon button. Extracted from DetailPanel so the slide-over and
// the full-screen deep-dive render byte-for-byte identical, on-brand pieces.
import { useState, type ReactNode } from "react";
import { Bot, CheckCircle2, ChevronDown, Circle, Loader2, XCircle } from "lucide-react";
import { legalMoves, STATUS_META } from "@/lib/lifecycle";
import type { Status, Task } from "@/lib/types";
import { cn, humanizeKey, isRecord } from "@/lib/utils";
import { HtmlBlock, Markdown, looksLikeHtml, parseStructured } from "./rich-content";

export function ownerName(
  task: Task,
  userId: string,
  displayName: string,
  resolveActor: (id: string) => string,
): string {
  const id = task.assigneeId ?? task.ownerId;
  return id === userId ? displayName : resolveActor(id);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-muted-foreground/80">{title}</h3>
      {children}
    </section>
  );
}

// A Section whose body folds away, so a long section (Details, Work/changes, Research) can be collapsed to
// make room for the rest of the page. The open/closed state is remembered per `storageKey` across visits.
export function CollapsibleSection({
  title,
  children,
  count,
  defaultOpen = true,
  storageKey,
}: {
  title: string;
  children: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  storageKey?: string;
}) {
  const [open, setOpen] = useState(() => {
    if (storageKey && typeof window !== "undefined") {
      const v = localStorage.getItem(storageKey);
      if (v === "0") return false;
      if (v === "1") return true;
    }
    return defaultOpen;
  });
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, next ? "1" : "0");
        } catch {
          /* private mode / quota — non-fatal, just don't persist */
        }
      }
      return next;
    });
  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        className="group mb-2 flex w-full items-center gap-1.5 text-left"
      >
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <h3 className="text-[12px] font-semibold text-muted-foreground/80 transition-colors group-hover:text-foreground">{title}</h3>
        {count != null && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>
        )}
        {!open && <span className="text-[11.5px] text-muted-foreground/60">· hidden</span>}
      </button>
      {open && children}
    </section>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[12px] font-semibold text-foreground">
      <span className="size-2 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function MoveButtons({ status, onMove }: { status: Status; onMove: (to: Status) => void }) {
  const moves = legalMoves(status);
  if (moves.length === 0) {
    return (
      <div className="rounded-xl border border-border/70 bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
        This task is closed. No further moves.
      </div>
    );
  }
  return (
    <Section title="Move to">
      <div className="flex flex-wrap gap-2">
        {moves.map((to) => (
          <button
            key={to}
            type="button"
            onClick={() => onMove(to)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="size-2 rounded-full" style={{ background: STATUS_META[to].color }} />
            {STATUS_META[to].moveVerb}
          </button>
        ))}
      </div>
    </Section>
  );
}

export function TaskContent({ task }: { task: Task }) {
  const content = task.content ?? {};
  const primaryKey = task.type === "code-issue" ? "symptom" : "summary";
  const entries = Object.entries(content).filter(([, v]) => v != null && v !== "");
  const primary = entries.find(([k]) => k === primaryKey);
  const rest = entries.filter(([k]) => k !== primaryKey);

  if (entries.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No details yet.</p>;
  }

  return (
    <div className="space-y-3.5">
      {primary && (
        <div className="text-[14px] leading-relaxed text-foreground/90">
          <Markdown text={String(primary[1])} />
        </div>
      )}
      {rest.map(([k, v]) => (
        <div key={k}>
          <p className="mb-1 text-[11.5px] font-medium text-muted-foreground">{humanizeKey(k)}</p>
          <DataValue value={v} />
        </div>
      ))}
    </div>
  );
}

const URL_RE = /^https?:\/\//;
const DONE_STATUS = new Set(["done", "completed", "complete", "closed", "passed", "pass", "ok", "verified"]);
const ACTIVE_STATUS = new Set(["in_progress", "in-progress", "working", "active", "doing", "started"]);

// An array of { text|title, status } items — render it as a checklist rather than bullets.
function isChecklist(arr: unknown[]): boolean {
  return (
    arr.length > 0 &&
    arr.every((x) => isRecord(x) && (typeof (x as { text?: unknown }).text === "string" || typeof (x as { title?: unknown }).title === "string"))
  );
}

// A general renderer for the agent's free-form values (research, output fields, extra content) that shows
// INDICATORS instead of raw JSON: booleans as ✓/✗, {text,status} arrays as checklists, URLs as links,
// other arrays as bullets, and nested objects as labelled, recursed sections.
export function DataValue({ value }: { value: unknown }): ReactNode {
  if (value == null) return null;
  if (typeof value === "boolean") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[13px] font-medium", value ? "text-emerald-600" : "text-red-600")}>
        {value ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
        {value ? "Yes" : "No"}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-[13.5px] tabular-nums text-foreground/90">{value}</span>;
  }
  if (typeof value === "string") {
    // A string that's really JSON → render it as structure, not braces.
    const structured = parseStructured(value);
    if (structured != null) return <DataValue value={structured} />;
    const trimmed = value.trim();
    // A bare URL → a link; a URL inside prose is autolinked by the markdown renderer instead.
    if (URL_RE.test(trimmed) && !/\s/.test(trimmed)) {
      return (
        <a href={trimmed} target="_blank" rel="noreferrer" className="break-all text-primary underline underline-offset-2">
          {trimmed}
        </a>
      );
    }
    // Agent HTML runs sandboxed; everything else renders as markdown.
    if (looksLikeHtml(value)) return <HtmlBlock html={value} />;
    return <Markdown text={value} />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-[13px] text-muted-foreground/70">None</p>;
    if (isChecklist(value)) {
      return (
        <ul className="space-y-1">
          {value.map((it, i) => {
            const o = it as Record<string, unknown>;
            const text = String(o.text ?? o.title ?? "");
            const s = String(o.status ?? "").toLowerCase();
            const done = DONE_STATUS.has(s);
            const active = ACTIVE_STATUS.has(s);
            return (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="mt-0.5 shrink-0">
                  {done ? (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  ) : active ? (
                    <Loader2 className="size-4 animate-spin text-primary" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground/40" />
                  )}
                </span>
                <span className={cn("min-w-0 leading-snug", done ? "text-muted-foreground line-through" : "text-foreground/90")}>
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      );
    }
    return (
      <ul className="ml-4 list-disc space-y-1 text-[13.5px] leading-relaxed text-foreground/90 marker:text-muted-foreground/50">
        {value.map((v, i) => (
          <li key={i}>
            <DataValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <div className="space-y-2">
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <p className="mb-0.5 text-[11.5px] font-medium text-muted-foreground">{humanizeKey(k)}</p>
            <DataValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  return null;
}

export function AgentStatusBlock({ task }: { task: Task }) {
  const agent = task.agent;
  if (!agent) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Bot className="size-4" />
        </span>
        <div className="text-[12.5px] leading-snug">
          <p className="font-medium text-foreground">No agent assigned yet</p>
          <p className="text-muted-foreground">
            {task.type === "code-issue"
              ? "An agent can pick this up once the plan is approved."
              : "This type runs with a human in the loop."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 text-[12.5px] leading-snug">
        <p className="font-semibold text-foreground">{agent.name ?? "Agent"}</p>
        <p className="text-muted-foreground">
          {[agent.state, agent.model].filter(Boolean).join(" · ") || "Working"}
        </p>
      </div>
      {task.retryCount > 0 && (
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {task.retryCount} {task.retryCount === 1 ? "retry" : "retries"}
        </span>
      )}
    </div>
  );
}

export function RefreshingHint() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> Refreshing…
    </div>
  );
}

export function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Quiet ghost icon button used in the panel headers (expand / collapse / close). */
export function HeaderIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}
