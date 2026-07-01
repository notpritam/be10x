// ABOUTME: Top bar for the active view — title + task count, the Board/List segmented control,
// and the primary "New task" action.
import { LayoutGrid, Plus, Rows3, type LucideIcon } from "lucide-react";
import { useApp, type View } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type BoardTab = "board" | "list";

function viewTitle(view: View): string {
  switch (view.kind) {
    case "all":
      return "All tasks";
    case "personal":
      return "Personal";
    case "needs_input":
      return "Needs you";
    case "team":
      return view.name;
  }
}

function viewSubtitle(view: View): string {
  switch (view.kind) {
    case "needs_input":
      return "Tasks paused on a question for you";
    case "personal":
      return "Your personal-scope tasks";
    case "team":
      return "Shared team work";
    default:
      return "Every task on the board";
  }
}

export function Topbar({
  tab,
  onTab,
  onNewTask,
}: {
  tab: BoardTab;
  onTab: (tab: BoardTab) => void;
  onNewTask: () => void;
}) {
  const { view, visibleTasks } = useApp();
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background/80 px-5 backdrop-blur-sm">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {viewTitle(view)}
          </h1>
          <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {visibleTasks.length}
          </span>
        </div>
        <p className="truncate text-[11.5px] text-muted-foreground/80">{viewSubtitle(view)}</p>
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          <SegButton active={tab === "board"} onClick={() => onTab("board")} icon={LayoutGrid} label="Board" />
          <SegButton active={tab === "list"} onClick={() => onTab("list")} icon={Rows3} label="List" />
        </div>
        <Button onClick={onNewTask} className="h-9 text-[13px]">
          <Plus className="size-4" />
          New task
        </Button>
      </div>
    </header>
  );
}

function SegButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-card text-foreground shadow-card"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
