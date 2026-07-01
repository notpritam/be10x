// ABOUTME: The board — eight status columns with @dnd-kit drag between them. Governance lives in the
// store's moveTask: illegal moves never hit the API (snap back + toast), and a 409 also snaps back.
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useApp } from "@/state/app-store";
import { BOARD_COLUMNS } from "@/lib/lifecycle";
import type { Status, Task } from "@/lib/types";
import { Column } from "./Column";
import { TaskCardVisual } from "./TaskCard";
import { BoardSkeleton } from "./BoardSkeleton";

export function BoardView({ onNewTask }: { onNewTask: () => void }) {
  const { visibleTasks, tasksLoading, moveTask, selectTask } = useApp();
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byStatus = useMemo(() => {
    const map = new Map<Status, Task[]>();
    for (const s of BOARD_COLUMNS) map.set(s, []);
    for (const t of visibleTasks) {
      if (!map.has(t.status)) map.set(t.status, []);
      map.get(t.status)!.push(t);
    }
    return map;
  }, [visibleTasks]);

  const activeTask = activeId ? visibleTasks.find((t) => t.id === activeId) ?? null : null;

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return; // dropped outside any column — snap back
    const to = over.id as Status;
    const from = (active.data.current?.status as Status | undefined) ?? undefined;
    if (from === to) return;
    void moveTask(String(active.id), to);
  }

  if (tasksLoading) return <BoardSkeleton />;

  if (visibleTasks.length === 0) {
    return <EmptyBoard onNewTask={onNewTask} />;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press and drag this task to another column to change its status. Only legal lifecycle moves are applied; anything else snaps back. You can also open the task and use its Move buttons.",
        },
      }}
    >
      <div className="group/board flex h-full gap-3 overflow-x-auto scroll-thin px-5 pb-6 pt-4">
        {BOARD_COLUMNS.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={byStatus.get(status) ?? []}
            onOpenTask={selectTask}
            onAddTask={onNewTask}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(0.16,1,0.3,1)" }}>
        {activeTask ? (
          <div className="w-[292px]">
            <TaskCardVisual task={activeTask} dragging />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function EmptyBoard({ onNewTask }: { onNewTask: () => void }) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-sm text-center soft-fade">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-accent text-muted-foreground">
          <svg width="22" height="22" viewBox="0 0 20 20" fill="none">
            <rect x="2.5" y="10.5" width="3.6" height="7" rx="1.4" fill="currentColor" />
            <rect x="8.2" y="6" width="3.6" height="11.5" rx="1.4" fill="currentColor" opacity="0.7" />
            <rect x="13.9" y="2.5" width="3.6" height="15" rx="1.4" fill="currentColor" opacity="0.5" />
          </svg>
        </div>
        <h2 className="text-[15px] font-bold text-foreground">Nothing here yet</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          This view has no tasks. Create one to get the board moving.
        </p>
        <button
          type="button"
          onClick={onNewTask}
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          New task
        </button>
      </div>
    </div>
  );
}
