// ABOUTME: The full-screen "deep dive" for a task — a real page (URL /t/<id>/full), not a modal: a
// full-viewport panel with a roomy two-column layout (main column + activity/comments rail). Reuses the
// shared detail controller + parts so it stays in lockstep with the slide-over. Collapse (or Escape)
// returns to the slide-over; close returns to the board.
import { useEffect } from "react";
import { Minimize2, Share2, X } from "lucide-react";
import { toast } from "sonner";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { PriorityPill, TypeTag } from "@/components/common/bits";
import { LifecycleStrip } from "./LifecycleStrip";
import { PlanView } from "./PlanView";
import { WorkSection } from "./WorkSection";
import { AgentLiveStatus } from "./AgentLiveStatus";
import { DebugControl } from "./DebugControl";
import { AgentActions, CommentThread } from "./agent-parts";
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
  const { resolveActor } = useApp();
  const { detail, loading, refresh, onMove } = ctrl;
  const task = detail?.task;
  const isStale = task && taskId !== task.id;

  function move(to: Status) {
    void onMove(to);
  }

  // Share this exact page — copies the deep-link (/t/<id>/full). Grows into the permissioned share
  // dialog (keyed link, run-agent vs comment-only) once that lands.
  function sharePage() {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => toast.success("Page link copied — anyone you share it with lands here."))
      .catch(() => toast.error("Couldn't copy the link."));
  }

  // Escape steps back to the slide-over (this is a page, not a modal, so wire the key ourselves).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCollapse]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      {!task || isStale ? (
        <PanelLoading />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
            {/* Header — one compact row: chips → title → live status → controls. Kept to a single line
                so the page starts at the content, not a tall banner. */}
            <header className="shrink-0 border-b border-border/60 bg-card/40 px-5 py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="shrink-0 font-mono text-[11.5px] font-medium tracking-wide text-muted-foreground">
                  {task.humanId}
                </span>
                <TypeTag type={task.type} />
                <PriorityPill severity={task.severity} />
                <StatusBadge status={task.status} />
                <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                  {task.title}
                </h1>
                <AgentLiveStatus task={task} runs={detail.runs} compact />
                {loading && <RefreshingHint />}

                {/* Controls — right-aligned, easy to grab: share · debug · collapse · close */}
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <HeaderIconButton label="Share this page" onClick={sharePage}>
                    <Share2 className="size-[16px]" />
                  </HeaderIconButton>
                  <DebugControl taskId={task.id} />
                  <HeaderIconButton label="Collapse to side panel" onClick={onCollapse}>
                    <Minimize2 className="size-[16px]" />
                  </HeaderIconButton>
                  <HeaderIconButton label="Close" onClick={onClose}>
                    <X className="size-[17px]" />
                  </HeaderIconButton>
                </div>
              </div>
            </header>

            {/* Body — wide main column + activity rail (stacks under on narrow screens) */}
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(348px,1fr)]">
              {/* Main */}
              <div className="min-h-0 space-y-6 overflow-y-auto scroll-thin border-border/60 px-8 py-7 lg:border-r">
                <LifecycleStrip status={task.status} />

                {/* An open question the agent asked — answerable anytime, not only in needs_input. */}
                {detail.input && <InputRequestPanel request={detail.input} onAnswered={refresh} />}

                {task.status === "plan_review" && <ReviewActions taskId={task.id} onDone={refresh} />}

                <RequestReviewControl task={task} onDone={refresh} />

                <AgentActions task={task} onDone={refresh} />

                <MoveButtons status={task.status} onMove={move} />

                {/* Plan first — it's the artifact under review. */}
                {task.plan != null && (
                  <Section title="Plan">
                    <PlanView plan={task.plan} />
                  </Section>
                )}

                <Section title="Details">
                  <TaskContent task={task} />
                </Section>

                <Section title="Work">
                  <WorkSection task={task} runs={detail.runs} />
                </Section>

                {task.research != null && (
                  <Section title="Research">
                    <DataValue value={task.research} />
                  </Section>
                )}

                <Section title="Agent">
                  <AgentStatusBlock task={task} />
                </Section>
              </div>

              {/* Discussion + activity rail */}
              <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto scroll-thin border-t border-border/60 bg-muted/30 px-6 py-7 lg:border-t-0">
                <div>
                  <h3 className="mb-3 text-[12.5px] font-semibold text-foreground">Discussion</h3>
                  <CommentThread taskId={task.id} resolveActor={resolveActor} onPosted={refresh} />
                </div>
                <div>
                  <h3 className="mb-4 flex items-center gap-2 text-[12.5px] font-semibold text-foreground">
                    Activity
                    <span className="rounded-full bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                      {detail.events.length}
                    </span>
                  </h3>
                  <ActivityFeed events={detail.events} resolveActor={resolveActor} />
                </div>
              </aside>
            </div>
          </div>
        )}
    </div>
  );
}
