// ABOUTME: The full-screen "deep dive" for a task — a real page (URL /t/<id>/full), not a modal: a
// full-viewport panel with a roomy two-column layout (main column + activity/comments rail). Reuses the
// shared detail controller + parts so it stays in lockstep with the slide-over. Collapse (or Escape)
// returns to the slide-over; close returns to the board.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Minimize2, Share2, X } from "lucide-react";
import { toast } from "sonner";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
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
  inline = false,
}: {
  taskId: string | null;
  open: boolean;
  onClose: () => void;
  onCollapse?: () => void;
  ctrl: ReturnType<typeof useTaskDetail>;
  /** Render as the active tab's page (fills the main area) rather than a fixed overlay. */
  inline?: boolean;
}) {
  const { resolveActor } = useApp();
  const { detail, loading, refresh, onMove } = ctrl;
  const task = detail?.task;
  const isStale = task && taskId !== task.id;
  const [discussionOpen, setDiscussionOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(true);

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

  // Escape steps back to the slide-over (overlay mode only; as an inline tab page there's nowhere to go).
  useEffect(() => {
    if (!open || !onCollapse) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCollapse]);

  if (!open) return null;

  return (
    <div
      className={
        inline
          ? "relative flex h-full min-h-0 flex-col bg-background"
          : "fixed inset-0 z-40 flex flex-col bg-background"
      }
    >
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
                  {onCollapse && (
                    <HeaderIconButton label="Collapse to side panel" onClick={onCollapse}>
                      <Minimize2 className="size-[16px]" />
                    </HeaderIconButton>
                  )}
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

              {/* Discussion + activity rail — each section collapses to free space and the discussion
                  scrolls internally, so the column never runs away with height. */}
              <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto scroll-thin border-t border-border/60 bg-muted/30 px-4 py-4 lg:border-t-0">
                <RailSection
                  title="Discussion"
                  open={discussionOpen}
                  onToggle={() => setDiscussionOpen((v) => !v)}
                  badge={
                    detail.input ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
                        <span className="size-1.5 rounded-full bg-amber-500" /> Waiting for you
                      </span>
                    ) : (
                      <AgentLiveStatus task={task} runs={detail.runs} compact />
                    )
                  }
                >
                  <CommentThread taskId={task.id} resolveActor={resolveActor} onPosted={refresh} />
                </RailSection>

                <RailSection
                  title="Activity"
                  count={detail.events.length}
                  open={activityOpen}
                  onToggle={() => setActivityOpen((v) => !v)}
                >
                  <ActivityFeed events={detail.events} resolveActor={resolveActor} />
                </RailSection>
              </aside>
            </div>
          </div>
        )}
    </div>
  );
}

// A collapsible rail section (Discussion / Activity). The header stays put; the body toggles so the
// user can fold either away to free vertical space. `badge` carries a live status chip (agent running,
// waiting for input) on the right.
function RailSection({
  title,
  count,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="shrink-0 overflow-hidden rounded-xl border border-border/60 bg-card/50">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none"
      >
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
        />
        <h3 className="text-[12.5px] font-semibold text-foreground">{title}</h3>
        {count != null && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
        {badge && <span className="ml-auto min-w-0 truncate">{badge}</span>}
      </button>
      {open && <div className="border-t border-border/50 px-3 py-3">{children}</div>}
    </section>
  );
}
