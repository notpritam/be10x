// ABOUTME: The task-detail "Linked bugs" panel — the extension-filed QA bug(s) this task fixes. Lists them,
// ABOUTME: lets you attach one (a searchable list of your filed bugs) or detach one. The working agent gets
// ABOUTME: each linked bug's full capture (replay/console/network/DOM) via the be10x-bugs MCP. Follows the
// ABOUTME: InfoPanel section vocabulary (uppercase eyebrow, hairline card rows).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug as BugIcon, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { Bug } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A tiny severity chip — the four bug severities (task PriorityPill only knows three, so this is local). */
const SEV_CLASS: Record<string, string> = {
  critical: "bg-red-500/15 text-red-500",
  high: "bg-orange-500/15 text-orange-500",
  medium: "bg-amber-500/15 text-amber-600",
  low: "bg-muted text-muted-foreground",
};
function SevChip({ severity }: { severity: string }) {
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", SEV_CLASS[severity] ?? SEV_CLASS.low)}>
      {severity}
    </span>
  );
}

export function LinkedBugs({ taskId }: { taskId: string }) {
  const [linked, setLinked] = useState<Bug[]>([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [all, setAll] = useState<Bug[] | null>(null); // the caller's bugs, lazily loaded for the picker
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // bug id mid-(de)link

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { bugs } = await api.taskBugs(taskId);
      setLinked(bugs);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPicker = useCallback(async () => {
    setPicking(true);
    if (all === null) {
      try {
        const { bugs } = await api.listBugs();
        setAll(bugs);
      } catch (err) {
        toast.error(errorMessage(err));
        setAll([]);
      }
    }
  }, [all]);

  const attach = async (bug: Bug) => {
    setBusy(bug.id);
    try {
      await api.attachBug(taskId, bug.id);
      toast.success(`Linked ${bug.humanId}.`);
      setPicking(false);
      setQuery("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const detach = async (bug: Bug) => {
    setBusy(bug.id);
    try {
      await api.detachBug(taskId, bug.id);
      toast.success(`Unlinked ${bug.humanId}.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const linkedIds = useMemo(() => new Set(linked.map((b) => b.id)), [linked]);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? [])
      .filter((b) => !linkedIds.has(b.id))
      .filter((b) => !q || b.title.toLowerCase().includes(q) || b.humanId.toLowerCase().includes(q))
      .slice(0, 8);
  }, [all, linkedIds, query]);

  return (
    <section className="px-4 py-3.5">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <BugIcon className="size-3.5" /> Linked bugs{linked.length ? ` · ${linked.length}` : ""}
      </p>

      {linked.length === 0 && !loading && (
        <p className="mb-2 text-[12px] text-muted-foreground">
          No bugs linked. Attach a filed bug so the agent gets its capture.
        </p>
      )}

      {linked.length > 0 && (
        <ul className="space-y-1.5">
          {linked.map((b) => (
            <li key={b.id} className="flex items-center gap-2 rounded-[8px] border border-border/60 bg-card px-2.5 py-2">
              <code className="shrink-0 font-mono text-[11px] text-primary">{b.humanId}</code>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90" title={b.title}>
                {b.title}
              </span>
              {(b.meta.errorCount ?? 0) > 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{b.meta.errorCount} err</span>
              )}
              <SevChip severity={b.severity} />
              <button
                type="button"
                onClick={() => void detach(b)}
                disabled={busy === b.id}
                title="Unlink"
                aria-label={`Unlink ${b.humanId}`}
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking ? (
        <div className="mt-2 rounded-[8px] border border-border/60 bg-card p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border/60 px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your bugs…"
              className="w-full bg-transparent py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={() => {
                setPicking(false);
                setQuery("");
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Cancel"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto scroll-thin">
            {all === null ? (
              <li className="px-1 py-2 text-[12px] text-muted-foreground">Loading…</li>
            ) : candidates.length === 0 ? (
              <li className="px-1 py-2 text-[12px] text-muted-foreground">No matching bugs.</li>
            ) : (
              candidates.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => void attach(b)}
                    disabled={busy === b.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <code className="shrink-0 font-mono text-[11px] text-primary">{b.humanId}</code>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90" title={b.title}>
                      {b.title}
                    </span>
                    <SevChip severity={b.severity} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void openPicker()}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" /> Attach bug
        </button>
      )}
    </section>
  );
}
