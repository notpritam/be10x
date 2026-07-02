// ABOUTME: The inline debug panel — a live, raw snapshot of what the board knows about a task (agent
// status, wake queue, run rows, recent events) with Copy JSON + Log to console. Rendered in the task
// page's right rail (no modal); read-only, auto-refreshes while mounted.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ClipboardCopy, RefreshCw, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Run, RunStep, TaskDebug } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function clockOf(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

export function DebugPanelContent({ taskId }: { taskId: string }) {
  const [dbg, setDbg] = useState<TaskDebug | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (silent?: boolean) => {
      if (!silent) setLoading(true);
      try {
        setDbg(await api.taskDebug(taskId));
      } catch {
        if (!silent) toast.error("Couldn't load debug state.");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [taskId],
  );

  // Fetch on mount, then poll silently while the panel stays open.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 3000);
    return () => clearInterval(t);
  }, [load]);

  const run = dbg && dbg.runs.length ? dbg.runs[dbg.runs.length - 1] : null;
  const active = run?.status === "running" || run?.status === "starting";
  const pendingWakes = dbg ? dbg.wakes.filter((w) => w.pending).length : 0;
  const updatedAt = dbg?.agent?.updatedAt ?? null;

  function copyJson() {
    if (!dbg) return;
    void navigator.clipboard
      .writeText(JSON.stringify(dbg, null, 2))
      .then(() => toast.success("Debug JSON copied."))
      .catch(() => toast.error("Copy failed."));
  }
  function logToConsole() {
    if (!dbg) return;
    // eslint-disable-next-line no-console
    console.log(`[be10x debug] ${dbg.task.humanId} (${dbg.task.id})`, dbg);
    toast.success("Logged to console — open DevTools (⌥⌘I).");
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-3 py-3">
      {!dbg ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">Loading raw state…</p>
      ) : (
        <div className="space-y-4">
          {/* Headline — the plain-language "what's going on right now". */}
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold",
                active
                  ? "bg-emerald-500/10 text-emerald-600"
                  : run?.status === "failed"
                    ? "bg-red-500/10 text-red-600"
                    : "bg-muted text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  active ? "bg-emerald-500" : run?.status === "failed" ? "bg-red-500" : "bg-muted-foreground/50",
                )}
              />
              {active ? "Agent running" : run ? `Run ${run.status}` : "No runs"}
            </span>
            {run?.model && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{run.model}</span>}
            {run?.pid != null && <span className="text-muted-foreground">pid {run.pid}</span>}
            {updatedAt && <span className="text-muted-foreground">· updated {agoLabel(dbg.now - updatedAt)}</span>}
            {pendingWakes > 0 && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600">
                {pendingWakes} wake{pendingWakes > 1 ? "s" : ""} pending
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void load()} className="h-7 gap-1 px-2 text-[11.5px]">
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={logToConsole} className="h-7 gap-1 px-2 text-[11.5px]">
              <TerminalSquare className="size-3.5" /> Console
            </Button>
            <Button size="sm" variant="outline" onClick={copyJson} className="h-7 gap-1 px-2 text-[11.5px]">
              <ClipboardCopy className="size-3.5" /> Copy JSON
            </Button>
          </div>

          <DebugSection title={`Recent events (${dbg.events.length})`}>
            {dbg.events.length === 0 ? (
              <Empty>No events yet.</Empty>
            ) : (
              <ul className="space-y-1">
                {dbg.events.map((e) => {
                  const msg = typeof e.payload?.message === "string" ? e.payload.message : "";
                  return (
                    <li key={e.id} className="flex gap-2 font-mono text-[11px] leading-relaxed">
                      <span className="shrink-0 text-muted-foreground/70">{clockOf(e.createdAt)}</span>
                      <span className="shrink-0 text-primary/80">{e.kind}</span>
                      <span className="min-w-0 truncate text-foreground/80" title={msg}>
                        {msg || e.actor}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </DebugSection>

          <DebugSection title={`Wake queue (${dbg.wakes.length})`}>
            {dbg.wakes.length === 0 ? <Empty>No wakes.</Empty> : <Raw value={dbg.wakes} />}
          </DebugSection>

          <DebugSection title={`Runs & trace (${dbg.runs.length})`}>
            {dbg.runs.length === 0 ? (
              <Empty>No runs.</Empty>
            ) : (
              <ul className="space-y-2">
                {[...dbg.runs].reverse().map((r) => (
                  <RunTrace key={r.id} run={r} now={dbg.now} />
                ))}
              </ul>
            )}
          </DebugSection>

          <DebugSection title="Live agent">
            {dbg.agent ? <Raw value={dbg.agent} /> : <Empty>No agent status.</Empty>}
          </DebugSection>
          {dbg.input && (
            <DebugSection title="Open input request">
              <Raw value={dbg.input} />
            </DebugSection>
          )}
        </div>
      )}
    </div>
  );
}

// One run rendered as an expandable execution trace: the context we handed the agent, each command it
// ran (with a one-line summary + drill-down), and the outcome. This is the "see the steps in depth"
// view — deliberately verbose, only when you open it.
function RunTrace({ run, now }: { run: Run; now: number }) {
  const live = run.status === "running" || run.status === "starting";
  const [open, setOpen] = useState(live);
  const steps = run.steps ?? [];
  const prompt = steps.find((s) => s.kind === "prompt");
  const tools = steps.filter((s) => s.kind === "tool");
  const result = steps.find((s) => s.kind === "result");
  const mode = typeof prompt?.detail?.mode === "string" ? (prompt.detail.mode as string) : null;
  const when = run.startedAt ?? run.createdAt;

  return (
    <li className="overflow-hidden rounded-[8px] border border-border/60 bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            live ? "bg-emerald-500" : run.status === "failed" ? "bg-red-500" : "bg-muted-foreground/40",
          )}
        />
        {mode && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{mode}</span>}
        <span className="text-[11.5px] font-medium text-foreground">{live ? "running" : run.status}</span>
        <span className="text-[11px] text-muted-foreground">{tools.length} cmd{tools.length === 1 ? "" : "s"}</span>
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">{agoLabel(now - when)}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border/50 px-2.5 py-2.5">
          {/* What we passed down */}
          {prompt ? (
            <StepDisclosure label="Context handed down" tone="prompt">
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5 text-[10.5px] text-muted-foreground">
                  {mode && <Tag>mode: {mode}</Tag>}
                  <Tag>{prompt.detail?.resumed ? "resumed session" : "fresh session"}</Tag>
                  {typeof prompt.detail?.sessionId === "string" && <Tag>resume {String(prompt.detail.sessionId).slice(0, 8)}</Tag>}
                </div>
                {Array.isArray(prompt.detail?.args) && (
                  <div>
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">command</div>
                    <pre className="overflow-auto scroll-thin rounded border border-border/50 bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
                      {String(prompt.detail?.command ?? "")} {(prompt.detail.args as unknown[]).join(" ")}
                    </pre>
                  </div>
                )}
                {typeof prompt.detail?.prompt === "string" && (
                  <div>
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">prompt / context</div>
                    <pre className="max-h-72 overflow-auto scroll-thin rounded border border-border/50 bg-muted/50 p-2 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/80">
                      {prompt.detail.prompt as string}
                    </pre>
                  </div>
                )}
              </div>
            </StepDisclosure>
          ) : (
            <Empty>No trace for this run (it may predate tracing, or ran under an older server).</Empty>
          )}

          {/* Commands it ran */}
          {tools.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">Commands ({tools.length})</div>
              <ol className="space-y-1">
                {tools.map((s) => (
                  <StepRow key={s.id} step={s} />
                ))}
              </ol>
            </div>
          )}

          {/* Outcome */}
          {result && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground/60">→</span>
              <span className={cn("font-medium", result.detail?.done ? "text-emerald-600" : "text-red-600")}>
                {result.detail?.done ? "completed" : "ended without a result"}
              </span>
              {typeof result.detail?.exitCode === "number" && <span className="text-muted-foreground">exit {String(result.detail.exitCode)}</span>}
              {typeof result.detail?.error === "string" && <span className="truncate text-red-600/80" title={result.detail.error}>{result.detail.error}</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// One command the agent ran: tool name + a readable one-line summary, expandable to the full input JSON.
function StepRow({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(step);
  return (
    <li className="rounded border border-border/40 bg-muted/30">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-1.5 px-2 py-1 text-left">
        <ChevronRight className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
        <code className="shrink-0 font-mono text-[10.5px] font-semibold text-primary/90">{step.tool}</code>
        {summary && <span className="min-w-0 truncate font-mono text-[10.5px] text-foreground/70" title={summary}>{summary}</span>}
      </button>
      {open && step.detail != null && (
        <pre className="max-h-56 overflow-auto scroll-thin border-t border-border/40 p-2 font-mono text-[10px] leading-relaxed text-foreground/75">
          {JSON.stringify((step.detail as { input?: unknown }).input ?? step.detail, null, 2)}
        </pre>
      )}
    </li>
  );
}

function StepDisclosure({ label, tone, children }: { label: string; tone?: "prompt"; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded border", tone === "prompt" ? "border-primary/20 bg-primary/[0.03]" : "border-border/40")}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left">
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
      </button>
      {open && <div className="border-t border-border/40 px-2 py-2">{children}</div>}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</span>;
}

// A readable one-liner for a tool call: the Bash command, the edited file, the search pattern, etc.
function toolSummary(step: RunStep): string {
  const input = (step.detail as { input?: unknown } | null)?.input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const pick = (k: string) => (typeof rec[k] === "string" ? (rec[k] as string) : "");
  return (
    pick("command") ||
    pick("file_path") ||
    pick("path") ||
    pick("pattern") ||
    pick("url") ||
    pick("query") ||
    pick("description") ||
    pick("message") ||
    ""
  );
}

function DebugSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</h4>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-muted-foreground">{children}</p>;
}

function Raw({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto scroll-thin rounded-lg border border-border/60 bg-card p-2.5 font-mono text-[10.5px] leading-relaxed text-foreground/80">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
