// ABOUTME: The full-screen "deep dive" for a task — a real page (URL /t/<id>/full), not a modal: a
// full-viewport panel with a roomy two-column layout (main column + activity/comments rail). Reuses the
// shared detail controller + parts so it stays in lockstep with the slide-over. Collapse (or Escape)
// returns to the slide-over; close returns to the board.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bug,
  ChevronDown,
  ChevronUp,
  Copy,
  History,
  Info,
  Layers,
  Maximize2,
  MessageSquare,
  PanelRightClose,
  Share2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Status } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { LifecycleStrip } from "./LifecycleStrip";
import { PlanView } from "./PlanView";
import { PlanVersions } from "./PlanVersions";
import { TaskOverview } from "./TaskOverview";
import { TaskArtifacts } from "./TaskArtifacts";
import { TaskChecklist } from "./TaskChecklist";
import { CurrentStep } from "./CurrentStep";
import { AgentConfigControl } from "./AgentConfigControl";
import { WorkSection } from "./WorkSection";
import { InfoPanel } from "./InfoPanel";
import { LinkedBugs } from "./LinkedBugs";
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
  CollapsibleSection,
  DataValue,
  MoveButtons,
  PanelLoading,
  Section,
  TaskContent,
} from "./detail-parts";

// Panel sizing: the right panel has no fixed max — it can grow until the MAIN task content would drop
// below MIN_CONTENT. So it's "as wide as you want" while the content stays readable. NAV_W is the fixed
// icon rail to the panel's right.
const MIN_PANEL = 320;
const MIN_CONTENT = 360;
const NAV_W = 48;

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
  const lastRun = detail?.runs?.length ? detail.runs[detail.runs.length - 1] : null;
  const agentActive = lastRun?.status === "running" || lastRun?.status === "starting";
  // Which right-rail panel is open (null = collapsed to just the icon strip).
  // "discussion" is the merged Interaction panel (comments + activity in one timeline).
  const [rightPanel, setRightPanel] = useState<"discussion" | "info" | "debug" | null>("discussion");
  const [shareOpen, setShareOpen] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [interactionBarOpen, setInteractionBarOpen] = useState(true);
  const [overviewOpen, setOverviewOpen] = useState(false);

  // Right-panel width — draggable and remembered. The drag binds window-level listeners on pointerdown
  // and removes them on pointerup, so it can't get stuck: there's no reliance on pointer-capture staying
  // on a thin handle, and moving the mouse when NOT dragging never resizes. Delta-based from the width at
  // grab time (dragging toward the main column widens; away narrows), clamped to [320, min(760, 70vw)].
  const asideRef = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 460;
    const saved = Number(localStorage.getItem("gfa.rightPanelWidth"));
    return saved >= MIN_PANEL ? saved : 460;
  });
  // The only ceiling is "don't crush the content": max = the row width minus the icon rail minus the
  // content minimum. No fixed cap, so the panel expands as far as the user drags while content stays ≥ min.
  const maxPanelWidth = () => {
    const row = asideRef.current?.parentElement?.clientWidth;
    return row ? Math.max(MIN_PANEL, row - NAV_W - MIN_CONTENT) : Number.POSITIVE_INFINITY;
  };
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = asideRef.current?.getBoundingClientRect().width ?? panelWidth;
    let latest = startWidth;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(MIN_PANEL, Math.min(maxPanelWidth(), Math.round(startWidth + (startX - ev.clientX))));
      setPanelWidth(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem("gfa.rightPanelWidth", String(latest));
      } catch {
        /* non-fatal */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

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

  // Keep the panel within the available space when the window resizes or the panel (re)opens, so it can
  // never crowd the content below its minimum after a layout change.
  useEffect(() => {
    const clamp = () => setPanelWidth((w) => Math.min(w, maxPanelWidth()));
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanel]);

  // Plan expansion: auto-open during planning, auto-collapsed once work moves on (the current-step recap
  // leads instead). null = follow that rule; true/false = the user's explicit toggle. Reset per task.
  const [planOverride, setPlanOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setPlanOverride(null);
  }, [taskId]);

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

  // Plan auto-expands while we're still planning; once work has moved on it collapses (CurrentStep is the
  // recap). The user's explicit toggle (planOverride) always wins.
  const planningStage = task ? ["backlog", "researching", "plan_review"].includes(task.status) : false;
  const planOpen = planOverride ?? planningStage;

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

                {/* Lead with where we are + what's here — not the Move/Plan controls. */}
                <CurrentStep task={task} runs={detail.runs} />

                {/* The model + reasoning effort this task runs at — visible and togglable. */}
                <AgentConfigControl task={task} onChanged={refresh} />

                {/* Plan review sits here, in place — not pinned to the foot. */}
                {task.status === "plan_review" && <ReviewActions taskId={task.id} onDone={refresh} />}

                <AgentActions task={task} onDone={refresh} />

                {/* The agent's live implementation task list — what it's working on, what's done/left.
                    When the agent isn't active, an in-progress step shows as paused (not a live spinner). */}
                <TaskChecklist todos={task.agent?.todos} active={agentActive} />

                {/* The agent's visual brief — RCA, diagrams, findings, suggestions, verification, rendered
                    as HTML. This leads the view: it's how the agent shows what it found and proposes, so the
                    human grasps the task at a glance and steers from the interaction panel. */}
                <TaskArtifacts artifacts={task.artifacts} />

                {/* Plan first — the artifact under review. Copy its content or expand it full-screen. */}
                {task.plan != null && (
                  <section>
                    <div className="mb-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPlanOverride(!planOpen)}
                        title={planOpen ? "Collapse plan" : "Expand plan"}
                        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronDown className={cn("size-4 transition-transform", !planOpen && "-rotate-90")} />
                        <h3 className="text-[12px] font-semibold text-muted-foreground/80">Plan</h3>
                      </button>
                      {!planOpen && (
                        <span className="text-[11.5px] text-muted-foreground/70">· approved — expand to view</span>
                      )}
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
                    {planOpen && showHistory && <PlanVersions taskId={task.id} onRestored={refresh} />}
                    {planOpen && <PlanView plan={task.plan} />}
                  </section>
                )}

                <CollapsibleSection title="Details" storageKey="gfa.sec.details">
                  <TaskContent task={task} />
                </CollapsibleSection>

                <CollapsibleSection title="Work" storageKey="gfa.sec.work">
                  <WorkSection task={task} runs={detail.runs} />
                </CollapsibleSection>

                {task.research != null && (
                  <CollapsibleSection title="Research" storageKey="gfa.sec.research">
                    <DataValue value={task.research} />
                  </CollapsibleSection>
                )}

                <Section title="Agent">
                  <AgentStatusBlock task={task} />
                </Section>

                {/* Move / request-review controls at the foot — the artifacts lead the view, not the controls. */}
                <RequestReviewControl task={task} onDone={refresh} />
                <MoveButtons status={task.status} onMove={move} />
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

              {/* Right panel — the active section; collapses to just the icon strip. Drag its left edge to
                  resize (width is remembered). */}
              {rightPanel && (
                <aside
                  ref={asideRef}
                  style={{ width: panelWidth }}
                  className="relative flex shrink-0 flex-col overflow-hidden border-l border-border/60 bg-muted/70"
                >
                  <div
                    onPointerDown={startResize}
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize"
                    className="group absolute inset-y-0 left-0 z-20 flex w-2.5 cursor-col-resize touch-none items-stretch justify-start"
                  >
                    <span className="w-0.5 bg-border/60 transition-colors group-hover:bg-primary/60" />
                  </div>
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
                    <button
                      type="button"
                      onClick={() => setRightPanel(null)}
                      title="Collapse panel"
                      aria-label="Collapse panel"
                      className="ml-auto grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <PanelRightClose className="size-4" />
                    </button>
                  </div>
                  {/* Discussion fills the panel as a chat (input pinned at the foot); the others scroll. */}
                  {rightPanel === "discussion" ? (
                    <CommentThread
                      taskId={task.id}
                      events={detail.events}
                      task={task}
                      runs={detail.runs}
                      resolveActor={resolveActor}
                      onPosted={refresh}
                    />
                  ) : rightPanel === "debug" ? (
                    <DebugPanelContent taskId={task.id} />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-3 py-3">
                      {rightPanel === "info" && (
                        <>
                          <InfoPanel task={task} runs={detail.runs} events={detail.events} />
                          <div className="mt-3 border-t border-border/60 pt-1">
                            <LinkedBugs taskId={task.id} />
                          </div>
                        </>
                      )}
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
                <RailIcon label="Overview — plans, changes, steps" active={overviewOpen} onClick={() => setOverviewOpen(true)}>
                  <Layers className="size-[18px]" />
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
            {overviewOpen && (
              <TaskOverview
                task={task}
                runs={detail.runs}
                events={detail.events}
                onClose={() => setOverviewOpen(false)}
              />
            )}
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
