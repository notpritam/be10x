// ABOUTME: The full-screen "deep dive" for a task — a large centered Dialog with a roomy two-column
// layout: a wide main column (lifecycle, contextual actions, moves, content, plan, research, agent)
// and a spacious activity/comments rail. Reuses the shared detail controller + parts so it stays in
// lockstep with the slide-over. Collapse returns to the slide-over; close returns to the board.
import { Minimize2, X } from "lucide-react";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { relativeTime } from "@/lib/utils";
import { PriorityPill, TypeTag, UserAvatar } from "@/components/common/bits";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LifecycleStrip } from "./LifecycleStrip";
import { ReviewActions } from "./ReviewActions";
import { RequestReviewControl } from "./RequestReviewControl";
import { InputRequestPanel } from "./InputRequestPanel";
import { ActivityFeed } from "./ActivityFeed";
import type { useTaskDetail } from "./useTaskDetail";
import {
  AgentStatusBlock,
  DataValue,
  HeaderIconButton,
  MoveButtons,
  ownerName,
  PanelLoading,
  RefreshingHint,
  Section,
  StatusBadge,
  TaskContent,
} from "./detail-parts";

export function DeepDivePanel({
  taskId,
  open,
  onClose,
  onCollapse,
  ctrl,
}: {
  taskId: string | null;
  open: boolean;
  onClose: () => void;
  onCollapse: () => void;
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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[92vh] max-w-[min(1200px,95vw)] flex-col overflow-hidden rounded-2xl p-0 gap-0 sm:max-w-[min(1200px,95vw)] shadow-panel"
      >
        {!task || isStale ? (
          <>
            <DialogTitle className="sr-only">Loading task</DialogTitle>
            <PanelLoading />
          </>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header — spans both columns */}
            <header className="shrink-0 border-b border-border/70 bg-card/40 px-8 pt-6 pb-5">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <span className="font-mono text-[11.5px] font-medium tracking-wide text-muted-foreground">
                      {task.humanId}
                    </span>
                    <span className="text-border">·</span>
                    <TypeTag type={task.type} />
                    <span className="text-border">·</span>
                    <PriorityPill severity={task.severity} />
                    <StatusBadge status={task.status} />
                  </div>
                  <DialogTitle className="max-w-4xl text-[27px] font-bold leading-[1.12] tracking-[-0.02em] text-foreground">
                    {task.title}
                  </DialogTitle>
                  <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                    <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <UserAvatar
                        name={ownerName(task, user.id, user.displayName, resolveActor)}
                        seed={task.assigneeId ?? task.ownerId}
                        size={22}
                        ring={false}
                      />
                      <span className="font-medium text-foreground/80">
                        {ownerName(task, user.id, user.displayName, resolveActor)}
                      </span>
                    </span>
                    <span className="text-[12.5px] text-muted-foreground/80">
                      Updated {relativeTime(task.updatedAt)}
                    </span>
                    {loading && <RefreshingHint />}
                  </div>
                </div>

                {/* Controls — collapse back to the slide-over, or close to the board. */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <HeaderIconButton label="Collapse to side panel" onClick={onCollapse}>
                    <Minimize2 className="size-[17px]" />
                  </HeaderIconButton>
                  <HeaderIconButton label="Close" onClick={onClose}>
                    <X className="size-[18px]" />
                  </HeaderIconButton>
                </div>
              </div>
            </header>

            {/* Body — wide main column + activity rail (stacks under on narrow screens) */}
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(348px,1fr)]">
              {/* Main */}
              <div className="min-h-0 space-y-6 overflow-y-auto scroll-thin border-border/60 px-8 py-7 lg:border-r">
                <LifecycleStrip status={task.status} />

                {task.status === "needs_input" && detail.input && (
                  <InputRequestPanel request={detail.input} onAnswered={refresh} />
                )}

                {task.status === "plan_review" && (
                  <ReviewActions taskId={task.id} onDone={refresh} />
                )}

                <RequestReviewControl task={task} onDone={refresh} />

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
              </div>

              {/* Activity / comments rail */}
              <aside className="flex min-h-0 flex-col overflow-y-auto scroll-thin border-t border-border/60 bg-muted/30 px-6 py-7 lg:border-t-0">
                <h3 className="mb-4 flex items-center gap-2 text-[12.5px] font-semibold text-foreground">
                  Activity &amp; comments
                  <span className="rounded-full bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                    {detail.events.length}
                  </span>
                </h3>
                <ActivityFeed events={detail.events} resolveActor={resolveActor} />
              </aside>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
