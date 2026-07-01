// ABOUTME: The full-screen "deep dive" for a task — a real page (URL /t/<id>/full), not a modal: a
// full-viewport panel with a roomy two-column layout (main column + activity/comments rail). Reuses the
// shared detail controller + parts so it stays in lockstep with the slide-over. Collapse (or Escape)
// returns to the slide-over; close returns to the board.
import { useEffect, useState, type ReactNode } from "react";
import { Activity, Info, MessageSquare, Share2 } from "lucide-react";
import { toast } from "sonner";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { LifecycleStrip } from "./LifecycleStrip";
import { PlanView } from "./PlanView";
import { WorkSection } from "./WorkSection";
import { InfoPanel } from "./InfoPanel";
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
  MoveButtons,
  PanelLoading,
  Section,
  TaskContent,
} from "./detail-parts";

export function DeepDivePanel({
  taskId,
  open,
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
  const { detail, refresh, onMove } = ctrl;
  const task = detail?.task;
  const isStale = task && taskId !== task.id;
  // Which right-rail panel is open (null = collapsed to just the icon strip).
  const [rightPanel, setRightPanel] = useState<"discussion" | "activity" | "info" | null>("discussion");

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
            {/* No page header — the task's identity + status live in the Info panel (right rail). The
                body is the plan/details/work + the collapsible right icon-sidebar. */}
            <div className="flex min-h-0 flex-1">
              {/* Main */}
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto scroll-thin px-8 py-7">
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

              {/* Right panel — the active section; collapses to just the icon strip. */}
              {rightPanel && (
                <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-border/60 bg-muted/70">
                  <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
                    <h3 className="text-[12.5px] font-semibold text-foreground">
                      {rightPanel === "discussion" ? "Discussion" : rightPanel === "activity" ? "Activity" : "Info"}
                    </h3>
                    {rightPanel === "discussion" &&
                      (detail.input ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
                          <span className="size-1.5 rounded-full bg-amber-500" /> Waiting for you
                        </span>
                      ) : (
                        <AgentLiveStatus task={task} runs={detail.runs} compact />
                      ))}
                    {rightPanel === "activity" && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                        {detail.events.length}
                      </span>
                    )}
                  </div>
                  {/* Discussion fills the panel as a chat (input pinned at the foot); the others scroll. */}
                  {rightPanel === "discussion" ? (
                    <CommentThread taskId={task.id} resolveActor={resolveActor} onPosted={refresh} />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-3 py-3">
                      {rightPanel === "activity" && (
                        <ActivityFeed events={detail.events} resolveActor={resolveActor} />
                      )}
                      {rightPanel === "info" && <InfoPanel task={task} runs={detail.runs} events={detail.events} />}
                    </div>
                  )}
                </aside>
              )}

              {/* Icon rail — always on the far right; click an icon to open its panel, the active one to collapse. */}
              <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-border/60 bg-muted/70 py-2.5">
                <RailIcon
                  label="Discussion"
                  active={rightPanel === "discussion"}
                  onClick={() => setRightPanel((p) => (p === "discussion" ? null : "discussion"))}
                >
                  <MessageSquare className="size-[18px]" />
                </RailIcon>
                <RailIcon
                  label="Activity"
                  active={rightPanel === "activity"}
                  onClick={() => setRightPanel((p) => (p === "activity" ? null : "activity"))}
                >
                  <Activity className="size-[18px]" />
                </RailIcon>
                <RailIcon
                  label="Info"
                  active={rightPanel === "info"}
                  onClick={() => setRightPanel((p) => (p === "info" ? null : "info"))}
                >
                  <Info className="size-[18px]" />
                </RailIcon>

                {/* Actions moved off the header to keep it clean — share + debug live at the rail's foot. */}
                <div className="mt-auto flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={sharePage}
                    aria-label="Share this page"
                    title="Share this page"
                    className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Share2 className="size-[18px]" />
                  </button>
                  <DebugControl taskId={task.id} />
                </div>
              </nav>
            </div>
          </div>
        )}
    </div>
  );
}

// One icon in the right rail — toggles its panel open/closed; the active icon shows a raised card.
function RailIcon({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-9 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        active ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
