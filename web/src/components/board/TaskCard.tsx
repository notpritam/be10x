// ABOUTME: The board card visual (approved style). Pure presentation so it can be reused inside the
// @dnd-kit DragOverlay. Prominent title, soft sentence-case priority pill, muted type tag, relative
// date, ringed assignee avatar, and a soft "needs input" badge when applicable.
import { useApp } from "@/state/app-store";
import type { Task } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import { NeedsInputBadge, PriorityPill, TypeTag, UserAvatar } from "@/components/common/bits";
import { SessionStateBadge } from "@/components/common/SessionStateBadge";

export function contentPreview(task: Task): string | null {
  const c = task.content ?? {};
  const primary = task.type === "code-issue" ? c.symptom : c.summary;
  const value =
    (typeof primary === "string" && primary) ||
    Object.values(c).find((v) => typeof v === "string" && v.trim().length > 0);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function TaskCardVisual({
  task,
  dragging,
  className,
}: {
  task: Task;
  dragging?: boolean;
  className?: string;
}) {
  const { user, resolveActor } = useApp();
  const preview = contentPreview(task);
  const personId = task.assigneeId ?? task.ownerId;
  const personName = personId === user.id ? user.displayName : resolveActor(personId);
  const needsInput = task.status === "needs_input";
  // Show the live session state while a session is in flight (hide once done, to keep finished cards quiet).
  const agentState = task.agent?.state;
  const showSession = !!agentState && agentState !== "done";

  return (
    <div
      className={cn(
        "select-none rounded-[8px] border border-border/70 bg-card p-3.5 text-left shadow-card transition-[transform,box-shadow,border-color] duration-200",
        dragging
          ? "rotate-[1.2deg] scale-[1.02] border-primary/30 shadow-drag"
          : "hover:-translate-y-0.5 hover:border-border hover:shadow-card-hover",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] font-medium tracking-wide text-muted-foreground/80">
          {task.humanId}
        </span>
        <PriorityPill severity={task.severity} />
      </div>

      <h3 className="line-clamp-2 text-[15px] font-bold leading-[1.32] tracking-[-0.01em] text-foreground">
        {task.title}
      </h3>

      {preview && (
        <p className="mt-1 line-clamp-1 text-[12.5px] leading-snug text-muted-foreground">
          {preview}
        </p>
      )}

      {showSession && (
        <div className="mt-2.5">
          <SessionStateBadge
            state={task.agent?.state}
            phase={task.agent?.phase}
            updatedAt={task.agent?.updatedAt}
          />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <TypeTag type={task.type} />
        <span className="text-muted-foreground/40">·</span>
        <span className="text-[11.5px] text-muted-foreground">{relativeTime(task.updatedAt)}</span>

        <div className="ml-auto flex items-center gap-2">
          {needsInput && <NeedsInputBadge />}
          <UserAvatar name={personName} seed={personId} size={24} />
        </div>
      </div>
    </div>
  );
}
