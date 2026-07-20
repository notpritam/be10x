// ABOUTME: The Fleet view — one screen answering "what is every agent doing right now" across the board.
// ABOUTME: Polls GET /api/ps; each row shows the task, its live state (working/waiting/blocked/stalled),
// ABOUTME: phase, current line, assignee, and project. The team's live pulse in one place.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PsSession } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { SessionStateBadge } from "@/components/common/SessionStateBadge";
import { UserAvatar } from "@/components/common/bits";

export function FleetView() {
  const { selectTask } = useApp();
  const [sessions, setSessions] = useState<PsSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .ps()
        .then((r) => live && setSessions(r.sessions))
        .catch((e) => live && setError(String(e?.message ?? e)));
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const working = sessions?.filter((s) => s.state === "working" && !s.stalled).length ?? 0;
  const waiting = sessions?.filter((s) => s.state === "waiting").length ?? 0;
  const stuck = sessions?.filter((s) => s.stalled || s.state === "blocked").length ?? 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">Fleet</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Every session in flight, live. {working} working · {waiting} need you · {stuck} stuck.
        </p>
      </header>

      {error && <p className="text-[13px] text-red-600">Couldn't load the fleet: {error}</p>}
      {sessions && sessions.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/70 px-5 py-10 text-center">
          <p className="text-[14px] font-medium text-foreground">No sessions in flight</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Move a task to Ready to work, or run <code className="rounded bg-muted px-1 py-0.5">be10x start</code>, to begin one.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {sessions?.map((s) => (
          <li key={s.taskId}>
            <button
              onClick={() => selectTask(s.taskId)}
              className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-card px-4 py-3 text-left transition-colors hover:border-border hover:bg-accent/40"
            >
              <span className="font-mono text-[11px] font-medium text-muted-foreground/80">{s.humanId}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-foreground">{s.title}</div>
                {s.message && (
                  <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{s.message}</div>
                )}
              </div>
              <SessionStateBadge state={s.state} phase={s.phase} updatedAt={s.updatedAt} stalled={s.stalled} />
              {s.project && (
                <span className="hidden shrink-0 max-w-[160px] truncate text-[11.5px] text-muted-foreground sm:inline">
                  {s.project.name || s.project.key}
                </span>
              )}
              {s.assignee && (
                <UserAvatar name={s.assignee.displayName} seed={s.assignee.id} size={22} />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
