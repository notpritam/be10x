// ABOUTME: Slide-over detail panel (shadcn Sheet). Fetches the task, its events and any open input
// request, shows the lifecycle strip, contextual actions (review / input), legal moves, content and
// the activity feed. Every mutation refreshes the panel and syncs the board via the store.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bot, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { legalMoves, STATUS_META } from "@/lib/lifecycle";
import type { InputRequest, Status, Task, TaskEvent } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { humanizeKey, isRecord, relativeTime } from "@/lib/utils";
import { PriorityPill, TypeTag, UserAvatar } from "@/components/common/bits";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { LifecycleStrip } from "./LifecycleStrip";
import { ReviewActions } from "./ReviewActions";
import { InputRequestPanel } from "./InputRequestPanel";
import { ActivityFeed } from "./ActivityFeed";

interface Detail {
  task: Task;
  events: TaskEvent[];
  input: InputRequest | null;
}

export function DetailPanel({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { user, resolveActor, applyTask, moveTask } = useApp();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [{ task }, { events }] = await Promise.all([api.getTask(id), api.events(id)]);
        let input: InputRequest | null = null;
        if (task.status === "needs_input") {
          input = (await api.getInput(id)).inputRequest;
        }
        setDetail({ task, events, input });
        applyTask(task);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [applyTask],
  );

  useEffect(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  const refresh = useCallback(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  async function onMove(to: Status) {
    if (!detail) return;
    const ok = await moveTask(detail.task.id, to);
    if (ok) toast.success(`Moved to ${STATUS_META[to].label}.`);
    refresh();
  }

  const task = detail?.task;
  const isStale = task && taskId !== task.id;

  return (
    <Sheet open={taskId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-[520px]"
        aria-describedby={undefined}
      >
        {!task || isStale ? (
          <PanelLoading />
        ) : (
          <div className="flex h-full flex-col">
            {/* Header */}
            <div className="shrink-0 border-b border-border/70 px-5 pb-4 pt-5 pr-12">
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

              {loading && (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Refreshing…
                </div>
              )}

              {task.status === "needs_input" && detail.input && (
                <InputRequestPanel request={detail.input} onAnswered={refresh} />
              )}

              {task.status === "plan_review" && <ReviewActions taskId={task.id} onDone={refresh} />}

              <MoveButtons status={task.status} onMove={onMove} />

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

function ownerName(
  task: Task,
  userId: string,
  displayName: string,
  resolveActor: (id: string) => string,
): string {
  const id = task.assigneeId ?? task.ownerId;
  return id === userId ? displayName : resolveActor(id);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-muted-foreground/80">{title}</h3>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[12px] font-semibold text-foreground">
      <span className="size-2 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

function MoveButtons({ status, onMove }: { status: Status; onMove: (to: Status) => void }) {
  const moves = legalMoves(status);
  if (moves.length === 0) {
    return (
      <div className="rounded-xl border border-border/70 bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
        This task is closed. No further moves.
      </div>
    );
  }
  return (
    <Section title="Move to">
      <div className="flex flex-wrap gap-2">
        {moves.map((to) => (
          <button
            key={to}
            type="button"
            onClick={() => onMove(to)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="size-2 rounded-full" style={{ background: STATUS_META[to].color }} />
            {STATUS_META[to].moveVerb}
          </button>
        ))}
      </div>
    </Section>
  );
}

function TaskContent({ task }: { task: Task }) {
  const content = task.content ?? {};
  const primaryKey = task.type === "code-issue" ? "symptom" : "summary";
  const entries = Object.entries(content).filter(([, v]) => v != null && v !== "");
  const primary = entries.find(([k]) => k === primaryKey);
  const rest = entries.filter(([k]) => k !== primaryKey);

  if (entries.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No details yet.</p>;
  }

  return (
    <div className="space-y-3.5">
      {primary && (
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/90">
          {String(primary[1])}
        </p>
      )}
      {rest.map(([k, v]) => (
        <div key={k}>
          <p className="mb-1 text-[11.5px] font-medium text-muted-foreground">{humanizeKey(k)}</p>
          <DataValue value={v} />
        </div>
      ))}
    </div>
  );
}

function DataValue({ value }: { value: unknown }): ReactNode {
  if (value == null) return null;
  if (typeof value === "string") {
    return (
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">{value}</p>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-[13.5px] text-foreground/90">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="ml-4 list-disc space-y-1 text-[13.5px] leading-relaxed text-foreground/90 marker:text-muted-foreground/50">
        {value.map((v, i) => (
          <li key={i}>
            <DataValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <div className="space-y-1.5">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="text-[13px]">
            <span className="font-medium text-muted-foreground">{humanizeKey(k)}: </span>
            <span className="text-foreground/90">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function AgentStatusBlock({ task }: { task: Task }) {
  const agent = task.agent;
  if (!agent) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Bot className="size-4" />
        </span>
        <div className="text-[12.5px] leading-snug">
          <p className="font-medium text-foreground">No agent assigned yet</p>
          <p className="text-muted-foreground">
            {task.type === "code-issue"
              ? "An agent can pick this up once the plan is approved."
              : "This type runs with a human in the loop."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 text-[12.5px] leading-snug">
        <p className="font-semibold text-foreground">{agent.name ?? "Agent"}</p>
        <p className="text-muted-foreground">
          {[agent.state, agent.model].filter(Boolean).join(" · ") || "Working"}
        </p>
      </div>
      {task.retryCount > 0 && (
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {task.retryCount} {task.retryCount === 1 ? "retry" : "retries"}
        </span>
      )}
    </div>
  );
}

function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}
