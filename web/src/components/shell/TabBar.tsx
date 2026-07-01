// ABOUTME: Workspace tab bar atop the main content. A leading "context" button = the current view
// (Personal / a team / …) that returns to the board and reads as selected when no task is open, then
// the open task tabs (title + a status dot, closable). Browser-style; the active tab is a raised card.
import { X } from "lucide-react";
import { useApp, type View } from "@/state/app-store";
import { STATUS_META } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";

function viewLabel(view: View): string {
  switch (view.kind) {
    case "all":
      return "All tasks";
    case "personal":
      return "Personal";
    case "needs_input":
      return "Needs you";
    case "review_queue":
      return "Review queue";
    case "team":
      return view.name;
    case "project":
      return view.name;
  }
}

export function TabBar({ onNavigate }: { onNavigate?: () => void }) {
  const { view, openTabs, selectedTaskId, selectTask, closeTab, allTasks } = useApp();
  const onBoard = selectedTaskId === null;

  function go(id: string | null) {
    onNavigate?.();
    selectTask(id);
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2">
      {/* Context button — the current view; reads as selected when you're on the board. */}
      <button
        type="button"
        onClick={() => go(null)}
        title={`${viewLabel(view)} board`}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold transition-colors",
          onBoard ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:bg-card/60",
        )}
      >
        <span className="size-1.5 rounded-full bg-primary" />
        {viewLabel(view)}
      </button>

      {openTabs.length > 0 && <div className="mx-1 h-5 w-px shrink-0 bg-border" />}

      {/* Open task tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-thin">
        {openTabs.map((t) => {
          const active = t.id === selectedTaskId;
          const status = allTasks.find((x) => x.id === t.id)?.status;
          const dot = status ? STATUS_META[status].color : undefined;
          return (
            <div
              key={t.id}
              className={cn(
                "group flex h-8 min-w-0 max-w-[200px] shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 text-[12.5px] transition-colors",
                active ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:bg-card/60",
              )}
            >
              <button
                type="button"
                onClick={() => go(t.id)}
                className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none"
                title={t.title}
              >
                {dot && <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
                <span className="min-w-0 truncate font-medium">{t.title}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.id)}
                aria-label="Close tab"
                title="Close tab"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded text-muted-foreground/60 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
