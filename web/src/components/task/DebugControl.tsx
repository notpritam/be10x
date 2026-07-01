// ABOUTME: The debug button + panel. A bug icon in the task header opens a live, raw snapshot of what
// the board knows — is an agent running, the wake queue, run rows, and the recent event stream — plus
// "Copy JSON" and "Log to console" so you can inspect exactly what's happening. Auto-refreshes while
// open; read-only (it never mutates the task).
import { useCallback, useEffect, useState } from "react";
import { Bug, ClipboardCopy, RefreshCw, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { TaskDebug } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HeaderIconButton } from "./detail-parts";

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

export function DebugControl({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
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

  // Fetch on open, then poll silently while it stays open.
  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(true), 3000);
    return () => clearInterval(t);
  }, [open, load]);

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
    <>
      <HeaderIconButton label="Debug — raw agent state" onClick={() => setOpen(true)}>
        <Bug className="size-[17px]" />
      </HeaderIconButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[86vh] gap-0 overflow-hidden p-0 sm:max-w-[760px]">
          <DialogHeader className="border-b border-border/70 px-5 py-3.5">
            <DialogTitle className="flex items-center gap-2 text-[14px]">
              <Bug className="size-4 text-muted-foreground" />
              Debug{dbg ? ` · ${dbg.task.humanId}` : ""}
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[calc(86vh-56px)] overflow-y-auto scroll-thin px-5 py-4">
            {!dbg ? (
              <p className="py-8 text-center text-[13px] text-muted-foreground">Loading raw state…</p>
            ) : (
              <div className="space-y-4">
                {/* Headline — the plain-language "what's going on right now". */}
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold",
                      active ? "bg-emerald-500/10 text-emerald-600" : run?.status === "failed" ? "bg-red-500/10 text-red-600" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <span className={cn("size-2 rounded-full", active ? "bg-emerald-500" : run?.status === "failed" ? "bg-red-500" : "bg-muted-foreground/50")} />
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
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void load()} className="h-7 gap-1 px-2 text-[11.5px]">
                      <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
                    </Button>
                    <Button size="sm" variant="ghost" onClick={logToConsole} className="h-7 gap-1 px-2 text-[11.5px]">
                      <TerminalSquare className="size-3.5" /> Console
                    </Button>
                    <Button size="sm" variant="outline" onClick={copyJson} className="h-7 gap-1 px-2 text-[11.5px]">
                      <ClipboardCopy className="size-3.5" /> Copy JSON
                    </Button>
                  </span>
                </div>

                {/* Recent event stream — the human-readable trail, newest first. */}
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

                {/* Wake queue — why the task is (or isn't) moving. */}
                <DebugSection title={`Wake queue (${dbg.wakes.length})`}>
                  {dbg.wakes.length === 0 ? <Empty>No wakes.</Empty> : <Raw value={dbg.wakes} />}
                </DebugSection>

                {/* Run rows — where/how it ran (branch, session, result, error). */}
                <DebugSection title={`Runs (${dbg.runs.length})`}>
                  {dbg.runs.length === 0 ? <Empty>No runs.</Empty> : <Raw value={dbg.runs} />}
                </DebugSection>

                {/* Live agent block + open input. */}
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
        </DialogContent>
      </Dialog>
    </>
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
    <pre className="max-h-64 overflow-auto scroll-thin rounded-lg border border-border/60 bg-muted/40 p-2.5 font-mono text-[10.5px] leading-relaxed text-foreground/80">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
