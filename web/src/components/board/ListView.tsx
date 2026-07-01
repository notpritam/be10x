// ABOUTME: Compact list view — one row per task, sorted along the lifecycle. Click a row to open detail.
import { type CSSProperties, useMemo } from "react";
import { useApp } from "@/state/app-store";
import { BOARD_COLUMNS, STATUS_META } from "@/lib/lifecycle";
import type { Status, Task } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import { NeedsInputBadge, PriorityPill, StatusDot, TypeTag, UserAvatar } from "@/components/common/bits";
import { BoardSkeleton } from "./BoardSkeleton";

const ORDER: Record<Status, number> = Object.fromEntries(
  BOARD_COLUMNS.map((s, i) => [s, i]),
) as Record<Status, number>;

export function ListView() {
  const { visibleTasks, tasksLoading, selectTask, user, resolveActor } = useApp();

  const sorted = useMemo(
    () =>
      [...visibleTasks].sort((a, b) => {
        const oa = ORDER[a.status] ?? 99;
        const ob = ORDER[b.status] ?? 99;
        return oa !== ob ? oa - ob : b.updatedAt - a.updatedAt;
      }),
    [visibleTasks],
  );

  if (tasksLoading) return <BoardSkeleton />;

  if (visibleTasks.length === 0) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-[13px] text-muted-foreground">No tasks in this view.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scroll-thin px-5 pb-12 pt-4">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-border/70 bg-card shadow-card">
        <div className="divide-y divide-border/70">
          {sorted.map((task, i) => {
            const personId = task.assigneeId ?? task.ownerId;
            const personName = personId === user.id ? user.displayName : resolveActor(personId);
            return (
              <Row
                key={task.id}
                task={task}
                index={i}
                personName={personName}
                personId={personId}
                onOpen={() => selectTask(task.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Row({
  task,
  index,
  personName,
  personId,
  onOpen,
}: {
  task: Task;
  index: number;
  personName: string;
  personId: string;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "feed-in group flex cursor-pointer items-center gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
      )}
      style={{ "--stagger": Math.min(index, 16) } as CSSProperties}
    >
      <div className="flex w-[128px] shrink-0 items-center gap-2">
        <StatusDot status={task.status} />
        <span className="truncate text-[12px] font-medium text-muted-foreground">
          {STATUS_META[task.status].label}
        </span>
      </div>
      <span className="hidden w-14 shrink-0 font-mono text-[11px] text-muted-foreground/70 sm:block">
        {task.humanId}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
        {task.title}
      </span>
      <div className="hidden shrink-0 md:block">
        <TypeTag type={task.type} />
      </div>
      {task.status === "needs_input" && <NeedsInputBadge className="hidden lg:inline-flex" />}
      <PriorityPill severity={task.severity} />
      <span className="hidden w-16 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground sm:block">
        {relativeTime(task.updatedAt)}
      </span>
      <UserAvatar name={personName} seed={personId} size={24} />
    </div>
  );
}
