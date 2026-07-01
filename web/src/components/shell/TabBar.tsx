// ABOUTME: The workspace tab bar — app icon (→ board) · Search · + New │ then the open task tabs as a
// Chrome-like, closable, horizontally-scrolling strip. Opening a task adds a tab; the active tab is the
// page shown in the main area. Styled to the reference: rounded, raised white cards on the gray canvas.
import { Plus, Search, X } from "lucide-react";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { BrandTile } from "@/components/common/Brandmark";

export function TabBar({ onNewTask }: { onNewTask: () => void }) {
  const { openTabs, selectedTaskId, selectTask, closeTab } = useApp();
  const onBoard = selectedTaskId === null;

  return (
    <div className="flex h-[56px] shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3.5">
      {/* App icon → board/home */}
      <button
        type="button"
        onClick={() => selectTask(null)}
        aria-label="Board"
        title="Board"
        className="shrink-0 rounded-xl transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <BrandTile
          className={cn("size-9 rounded-[9px]", onBoard && "ring-2 ring-primary/30 ring-offset-2 ring-offset-background")}
        />
      </button>

      {/* Search (placeholder for now) */}
      <button
        type="button"
        onClick={() => {}}
        className="hidden h-9 items-center gap-2 rounded-xl bg-card px-3 text-[13px] text-muted-foreground shadow-card transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:inline-flex"
      >
        <Search className="size-4" /> Search
      </button>

      {/* New task */}
      <button
        type="button"
        onClick={onNewTask}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Plus className="size-4" /> New
      </button>

      {openTabs.length > 0 && <div className="mx-1 h-6 w-px shrink-0 bg-border" />}

      {/* Open tabs — horizontally scrollable, active one raised */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-thin">
        {openTabs.map((t) => {
          const active = t.id === selectedTaskId;
          return (
            <div
              key={t.id}
              className={cn(
                "group flex h-9 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-xl pl-2.5 pr-1.5 text-[12.5px] transition-colors",
                active ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:bg-card/60",
              )}
            >
              <button
                type="button"
                onClick={() => selectTask(t.id)}
                className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none"
                title={t.title}
              >
                <span className="shrink-0 font-mono text-[10.5px] opacity-70">{t.humanId}</span>
                <span className="min-w-0 truncate font-medium">{t.title}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.id)}
                aria-label="Close tab"
                title="Close tab"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100",
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
