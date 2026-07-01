// ABOUTME: A single board column — a droppable status lane with a colored dot + count header,
// a subtle "+ add" affordance, and its draggable cards. Card list carries generous bottom padding.
import { type CSSProperties } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { Status, Task } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";
import { TaskCardVisual } from "./TaskCard";

function DraggableCard({
  task,
  index,
  onOpen,
}: {
  task: Task;
  index: number;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { status: task.status },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`Open ${task.humanId}: ${task.title}`}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
      className={cn(
        "card-rise cursor-grab rounded-[12px] outline-none transition-opacity active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isDragging && "opacity-40",
      )}
      style={{ "--stagger": Math.min(index, 12) } as CSSProperties}
    >
      <TaskCardVisual task={task} />
    </div>
  );
}

export function Column({
  status,
  tasks,
  onOpenTask,
  onAddTask,
}: {
  status: Status;
  tasks: Task[];
  onOpenTask: (id: string) => void;
  onAddTask: () => void;
}) {
  const meta = STATUS_META[status];
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section className="flex h-full w-[300px] shrink-0 flex-col">
      {/* Column header */}
      <div className="flex h-9 items-center gap-2 px-1.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: meta.color }} />
        <h2 className="text-[13px] font-semibold text-foreground">{meta.label}</h2>
        <span className="text-[12px] font-medium tabular-nums text-muted-foreground/70">
          {tasks.length}
        </span>
        <button
          type="button"
          onClick={onAddTask}
          className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground/60 opacity-0 transition-[opacity,color,background-color] hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/board:opacity-100"
          aria-label={`Add task to ${meta.label}`}
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* Droppable card list — generous bottom padding so the last card never touches the edge */}
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scroll-thin rounded-xl px-1 pb-14 pt-1 transition-colors",
          isOver && "bg-primary/[0.045] ring-1 ring-inset ring-primary/20",
        )}
      >
        <div className="flex flex-col gap-2.5">
          {tasks.map((task, i) => (
            <DraggableCard key={task.id} task={task} index={i} onOpen={onOpenTask} />
          ))}

          {tasks.length === 0 && (
            <div
              className={cn(
                "mt-1 rounded-[13px] border border-dashed border-border/70 py-8 text-center text-[12px] text-muted-foreground/60 transition-colors",
                isOver && "border-primary/40 text-primary/70",
              )}
            >
              {isOver ? "Drop here" : "No tasks"}
            </div>
          )}

          {status === "backlog" && (
            <button
              type="button"
              onClick={onAddTask}
              className="flex items-center gap-1.5 rounded-[13px] border border-dashed border-border/70 px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Plus className="size-4" />
              Add task
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
