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
import {
  CheckCircle2,
  GitPullRequestArrow,
  Lightbulb,
  Plug,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useApp, type View } from "@/state/app-store";
import { BOARD_COLUMNS } from "@/lib/lifecycle";
import type { Status, Task } from "@/lib/types";
import { BrandTile } from "@/components/common/Brandmark";
import { Button } from "@/components/ui/button";
import { Column } from "./Column";
import { TaskCardVisual } from "./TaskCard";
import { BoardSkeleton } from "./BoardSkeleton";

export function BoardView({
  onNewTask,
  onConnectAgent,
}: {
  onNewTask: () => void;
  onConnectAgent: () => void;
}) {
  const { visibleTasks, tasksLoading, moveTask, selectTask, allTasks, view } = useApp();
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
    return (
      <EmptyBoard
        onNewTask={onNewTask}
        onConnectAgent={onConnectAgent}
        firstRun={allTasks.length === 0}
        view={view}
      />
    );
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

function emptyCopy(view: View): { title: string; body: string } {
  switch (view.kind) {
    case "review_queue":
      return {
        title: "Your review queue is clear",
        body: "When a teammate asks you to review a plan, it shows up here.",
      };
    case "needs_input":
      return {
        title: "Nothing needs you right now",
        body: "Tasks paused on a question for you will land here.",
      };
    case "personal":
      return {
        title: "No personal tasks yet",
        body: "Capture an idea or a bug to get your board moving.",
      };
    case "team":
      return {
        title: "No tasks in this team yet",
        body: "Add the first shared task, or invite teammates from Manage team.",
      };
    default:
      return {
        title: "Nothing here yet",
        body: "This view has no tasks. Create one to get the board moving.",
      };
  }
}

function EmptyBoard({
  onNewTask,
  onConnectAgent,
  firstRun,
  view,
}: {
  onNewTask: () => void;
  onConnectAgent: () => void;
  firstRun: boolean;
  view: View;
}) {
  // A true first run (no tasks anywhere) gets the warm welcome; a merely-empty
  // filtered view gets a lighter, view-specific message.
  if (firstRun && view.kind === "all") {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-xl text-center soft-fade">
          <BrandTile className="mx-auto mb-5 size-14 rounded-2xl [&_svg]:size-7" />
          <h2 className="text-[23px] font-bold tracking-tight text-foreground">
            Welcome to be10x
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
            A calm board where you and your agents move work from idea to done. Add your first task,
            or connect an agent to let it pick up the work.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
            <Button onClick={onNewTask} className="h-10 text-[13px]">
              <Plus className="size-4" />
              Add your first task
            </Button>
            <Button variant="outline" onClick={onConnectAgent} className="h-10 text-[13px]">
              <Plug className="size-4" />
              Connect an agent
            </Button>
          </div>

          <div className="mt-9 grid gap-3 text-left sm:grid-cols-3">
            <HintCard
              icon={Lightbulb}
              title="Capture"
              body="Jot down an idea or a bug. It lands in backlog."
            />
            <HintCard
              icon={GitPullRequestArrow}
              title="Review"
              body="Agents research and plan; you approve or send back."
            />
            <HintCard
              icon={CheckCircle2}
              title="Ship"
              body="Watch work flow across the board to done."
            />
          </div>
        </div>
      </div>
    );
  }

  const { title, body } = emptyCopy(view);
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
        <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
        <button
          type="button"
          onClick={onNewTask}
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus className="size-4" />
          New task
        </button>
      </div>
    </div>
  );
}

function HintCard({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
      <span className="mb-2.5 grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <p className="text-[13px] font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
