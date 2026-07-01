// ABOUTME: The full-screen "deep dive" for a task — a real page (URL /t/<id>/full), not a modal: a
// full-viewport panel with a roomy two-column layout (main column + activity/comments rail). Reuses the
// shared detail controller + parts so it stays in lockstep with the slide-over. Collapse (or Escape)
// returns to the slide-over; close returns to the board.
import { useEffect, useState, type ReactNode } from "react";
import { Bug, ChevronUp, Copy, History, Info, Maximize2, MessageSquare, Share2, X } from "lucide-react";
import { toast } from "sonner";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { LifecycleStrip } from "./LifecycleStrip";
import { PlanView } from "./PlanView";
import { PlanVersions } from "./PlanVersions";
import { WorkSection } from "./WorkSection";
import { InfoPanel } from "./InfoPanel";
import { AgentLiveStatus } from "./AgentLiveStatus";
import { DebugPanelContent } from "./DebugControl";
import { ShareDialog } from "@/components/share/ShareDialog";
import { AgentActions, CommentThread } from "./agent-parts";
import { ReviewActions } from "./ReviewActions";
import { RequestReviewControl } from "./RequestReviewControl";
import { InputRequestPanel } from "./InputRequestPanel";
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
  // "discussion" is the merged Interaction panel (comments + activity in one timeline).
  const [rightPanel, setRightPanel] = useState<"discussion" | "info" | "debug" | null>("discussion");
  const [shareOpen, setShareOpen] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [interactionBarOpen, setInteractionBarOpen] = useState(true);

  function move(to: Status) {
    void onMove(to);
  }

  function copyPlan() {
    const p = task?.plan;
    if (p == null) return;
    const text = typeof p === "string" ? p : JSON.stringify(p, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Plan copied."))
      .catch(() => toast.error("Copy failed."));
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
              {/* Main column — scroll content + a sticky interaction bar pinned at the foot. */}
              <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto scroll-thin px-8 py-7">
                <LifecycleStrip status={task.status} />

                {/* Plan review sits here, in place — not pinned to the foot. */}
                {task.status === "plan_review" && <ReviewActions taskId={task.id} onDone={refresh} />}

                <RequestReviewControl task={task} onDone={refresh} />

                <AgentActions task={task} onDone={refresh} />

                <MoveButtons status={task.status} onMove={move} />

                {/* Plan first — the artifact under review. Copy its content or expand it full-screen. */}
                {task.plan != null && (
                  <section>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-[12px] font-semibold text-muted-foreground/80">Plan</h3>
                      <div className="ml-auto flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => setShowHistory((v) => !v)}
                          title="Version history"
                          aria-label="Version history"
                          className={cn(
                            "grid size-7 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
                            showHistory ? "bg-accent text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <History className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={copyPlan}
                          title="Copy plan"
                          aria-label="Copy plan"
                          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Copy className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPlanExpanded(true)}
                          title="Expand plan"
                          aria-label="Expand plan"
                          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Maximize2 className="size-4" />
                        </button>
                      </div>
                    </div>
                    {showHistory && <PlanVersions taskId={task.id} onRestored={refresh} />}
                    <PlanView plan={task.plan} />
                  </section>
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

              {/* The agent's open question floats at the foot, collapsible — never covers the page. */}
              {detail.input && (
                <div className="shrink-0 border-t border-border/60 bg-card/90 backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => setInteractionBarOpen((v) => !v)}
                    className="flex w-full items-center gap-2 px-6 py-2 text-left"
                  >
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11.5px] font-semibold text-amber-600">
                      <span className="size-1.5 rounded-full bg-amber-500" />
                      Input needed
                    </span>
                    <span className="truncate text-[12px] text-muted-foreground">The agent asked you a question.</span>
                    <ChevronUp
                      className={cn(
                        "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
                        !interactionBarOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {interactionBarOpen && (
                    <div className="max-h-[45vh] space-y-4 overflow-y-auto scroll-thin px-6 pb-4">
                      <InputRequestPanel request={detail.input} onAnswered={refresh} />
                    </div>
                  )}
                </div>
              )}
              </div>

              {/* Right panel — the active section; collapses to just the icon strip. */}
              {rightPanel && (
                <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-border/60 bg-muted/70">
                  <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
                    <h3 className="text-[12.5px] font-semibold text-foreground">
                      {rightPanel === "discussion" ? "Interaction" : rightPanel === "debug" ? "Debug" : "Info"}
                    </h3>
                    {rightPanel === "discussion" &&
                      (detail.input ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
                          <span className="size-1.5 rounded-full bg-amber-500" /> Waiting for you
                        </span>
                      ) : (
                        <AgentLiveStatus task={task} runs={detail.runs} compact />
                      ))}
                  </div>
                  {/* Discussion fills the panel as a chat (input pinned at the foot); the others scroll. */}
                  {rightPanel === "discussion" ? (
                    <CommentThread taskId={task.id} events={detail.events} resolveActor={resolveActor} onPosted={refresh} />
                  ) : rightPanel === "debug" ? (
                    <DebugPanelContent taskId={task.id} />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-3 py-3">
                      {rightPanel === "info" && <InfoPanel task={task} runs={detail.runs} events={detail.events} />}
                    </div>
                  )}
                </aside>
              )}

              {/* Icon rail — always on the far right; click an icon to open its panel, the active one to collapse. */}
              <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-border/60 bg-muted/70 py-2.5">
                <RailIcon
                  label="Interaction"
                  active={rightPanel === "discussion"}
                  onClick={() => setRightPanel((p) => (p === "discussion" ? null : "discussion"))}
                >
                  <MessageSquare className="size-[18px]" />
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
                    onClick={() => setShareOpen(true)}
                    aria-label="Share for review"
                    title="Share for review"
                    className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Share2 className="size-[18px]" />
                  </button>
                  <RailIcon
                    label="Debug"
                    active={rightPanel === "debug"}
                    onClick={() => setRightPanel((p) => (p === "debug" ? null : "debug"))}
                  >
                    <Bug className="size-[18px]" />
                  </RailIcon>
                </div>
              </nav>
            </div>
            {planExpanded && task.plan != null && (
              <div className="fixed inset-0 z-50 flex flex-col bg-background">
                <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-5 py-3">
                  <h2 className="text-[14px] font-semibold text-foreground">Plan · {task.humanId}</h2>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={copyPlan}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Copy className="size-4" /> Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlanExpanded(false)}
                      aria-label="Close"
                      title="Close"
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-[18px]" />
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-8 py-6">
                  <PlanView plan={task.plan} />
                </div>
              </div>
            )}
            <ShareDialog taskId={task.id} open={shareOpen} onOpenChange={setShareOpen} />
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
