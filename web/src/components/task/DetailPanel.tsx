// ABOUTME: The task detail surface. Owns the shared detail controller and renders it in one of two
// shells: the quick slide-over (a shadcn Sheet) or — once expanded — the full-screen deep-dive.
// A maximize control in the slide-over header promotes the SAME task into the deep-dive.
import { useCallback, useEffect, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { toast } from "sonner";
import type { Comment, Status, Task } from "@/lib/types";
import { api } from "@/lib/api";
import { useApp } from "@/state/app-store";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PriorityPill, TypeTag, UserAvatar } from "@/components/common/bits";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { LifecycleStrip } from "./LifecycleStrip";
import { ReviewActions } from "./ReviewActions";
import { RequestReviewControl } from "./RequestReviewControl";
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

              <RequestReviewControl task={task} onDone={refresh} />

              <AgentActions task={task} onDone={refresh} />

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

              <Section title="Discussion">
                <CommentThread taskId={task.id} resolveActor={resolveActor} onPosted={refresh} />
              </Section>

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

// Hand a backlog task to the agent (starts planning) or ping an already-engaged task to pick up now.
// Both just enqueue a wake the runner drains — the board is the only interface the human needs.
function AgentActions({ task, onDone }: { task: Task; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const canHandOff = task.status === "backlog";
  const canPing = ["researching", "plan_review", "ready_to_work", "in_progress", "needs_input", "verifying"].includes(
    task.status,
  );
  if (!canHandOff && !canPing) return null;

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await action();
      toast.success(ok);
      onDone();
    } catch {
      toast.error("Couldn't reach the agent runner.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canHandOff && (
        <Button size="sm" disabled={busy} onClick={() => run(() => api.handToAgent(task.id), "Handed to the agent — it'll start planning.")}>
          Hand to agent
        </Button>
      )}
      {canPing && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => api.pickUpNow(task.id), "Pinged the agent to pick this up now.")}
        >
          Pick up now
        </Button>
      )}
    </div>
  );
}

// The comment thread the agent reads on its next wake. Posting a comment steers the agent (revises the
// plan under review, or nudges an in-flight task); it's the human half of the plan/review loop.
function CommentThread({
  taskId,
  resolveActor,
  onPosted,
}: {
  taskId: string;
  resolveActor: (id: string) => string;
  onPosted: () => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listComments(taskId);
      setComments(r.comments);
    } catch {
      /* a failed thread fetch is non-fatal — the box still works */
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.addComment(taskId, text);
      setBody("");
      await load();
      onPosted();
      toast.success("Comment posted — the agent reads it on its next wake.");
    } catch {
      toast.error("Couldn't post the comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {comments.length > 0 && (
        <ul className="space-y-2.5">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{resolveActor(c.author)}</span>
                {c.anchor !== "general" && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{c.anchor}</span>
                )}
                <span className="ml-auto">{relativeTime(c.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-[13px] leading-snug text-foreground/90">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Comment to steer the agent — it reads new comments on its next wake…"
          rows={2}
          className="text-[13px]"
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={busy || !body.trim()} onClick={post}>
            Post comment
          </Button>
        </div>
      </div>
    </div>
  );
}
