// ABOUTME: The task detail surface. Owns the shared detail controller and renders it in one of two
// shells: the quick slide-over (a shadcn Sheet) or — once expanded — the full-screen deep-dive.
// A maximize control in the slide-over header promotes the SAME task into the deep-dive.
import { Maximize2, X } from "lucide-react";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { relativeTime } from "@/lib/utils";
import { PriorityPill, TypeTag, UserAvatar } from "@/components/common/bits";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { LifecycleStrip } from "./LifecycleStrip";
import { ReviewActions } from "./ReviewActions";
import { InputRequestPanel } from "./InputRequestPanel";
import { ActivityFeed } from "./ActivityFeed";
import { DeepDivePanel } from "./DeepDivePanel";
import { useTaskDetail } from "./useTaskDetail";
import {
  AgentStatusBlock,
  HeaderIconButton,
  MoveButtons,
  ownerName,
  PanelLoading,
  RefreshingHint,
  Section,
  StatusBadge,
  TaskContent,
  DataValue,
} from "./detail-parts";

export function DetailPanel({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { expanded, expandTask, collapseTask } = useApp();
  // One controller feeds both shells, so expanding/collapsing never refetches or flashes.
  const ctrl = useTaskDetail(taskId);

  return (
    <>
      <QuickView
        taskId={taskId}
        open={taskId !== null && !expanded}
        onClose={onClose}
        onExpand={expandTask}
        ctrl={ctrl}
      />
      <DeepDivePanel
        taskId={taskId}
        open={taskId !== null && expanded}
        onClose={onClose}
        onCollapse={collapseTask}
        ctrl={ctrl}
      />
    </>
  );
}

function QuickView({
  taskId,
  open,
  onClose,
  onExpand,
  ctrl,
}: {
  taskId: string | null;
  open: boolean;
  onClose: () => void;
  onExpand: () => void;
  ctrl: ReturnType<typeof useTaskDetail>;
}) {
  const { user, resolveActor } = useApp();
  const { detail, loading, refresh, onMove } = ctrl;
  const task = detail?.task;
  const isStale = task && taskId !== task.id;

  function move(to: Status) {
    void onMove(to);
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 p-0 sm:max-w-[520px]"
        aria-describedby={undefined}
      >
        {/* Header controls — maximize into the deep-dive, then close. */}
        <div className="absolute right-3 top-3.5 z-10 flex items-center gap-0.5">
          <HeaderIconButton label="Open full screen" onClick={onExpand}>
            <Maximize2 className="size-[17px]" />
          </HeaderIconButton>
          <HeaderIconButton label="Close" onClick={onClose}>
            <X className="size-[18px]" />
          </HeaderIconButton>
        </div>

        {!task || isStale ? (
          <PanelLoading />
        ) : (
          <div className="flex h-full flex-col">
            {/* Header */}
            <div className="shrink-0 border-b border-border/70 px-5 pb-4 pt-5 pr-[92px]">
              <div className="mb-2 flex items-center gap-2.5">
                <span className="font-mono text-[11px] font-medium tracking-wide text-muted-foreground">
                  {task.humanId}
                </span>
                <span className="text-border">·</span>
                <TypeTag type={task.type} />
                <div className="ml-auto">
                  <PriorityPill severity={task.severity} />
                </div>
              </div>
              <h2 className="text-[19px] font-bold leading-tight tracking-[-0.015em] text-foreground">
                {task.title}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <StatusBadge status={task.status} />
                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <UserAvatar
                    name={ownerName(task, user.id, user.displayName, resolveActor)}
                    seed={task.assigneeId ?? task.ownerId}
                    size={18}
                    ring={false}
                  />
                  {ownerName(task, user.id, user.displayName, resolveActor)}
                </span>
                <span className="text-[12px] text-muted-foreground/80">
                  Updated {relativeTime(task.updatedAt)}
                </span>
              </div>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scroll-thin px-5 py-5">
              <LifecycleStrip status={task.status} />

              {loading && <RefreshingHint />}

              {task.status === "needs_input" && detail.input && (
                <InputRequestPanel request={detail.input} onAnswered={refresh} />
              )}

              {task.status === "plan_review" && <ReviewActions taskId={task.id} onDone={refresh} />}

              <MoveButtons status={task.status} onMove={move} />

              <Section title="Details">
                <TaskContent task={task} />
              </Section>

              {task.plan != null && (
                <Section title="Plan">
                  <DataValue value={task.plan} />
                </Section>
              )}

              {task.research != null && (
                <Section title="Research">
                  <DataValue value={task.research} />
                </Section>
              )}

              <Section title="Agent">
                <AgentStatusBlock task={task} />
              </Section>

              <Section title="Activity">
                <ActivityFeed events={detail.events} resolveActor={resolveActor} />
              </Section>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
