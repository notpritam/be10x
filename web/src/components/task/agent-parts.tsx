// ABOUTME: Shared agent-interaction blocks used by both the slide-over and the deep-dive: the hand-off /
// pick-up-now action row, and the comment thread the agent reads on its next wake.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, ChevronDown, ChevronRight, Copy, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { Comment, Run, Task, TaskEvent } from "@/lib/types";
import { api } from "@/lib/api";
import { useApp } from "@/state/app-store";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describe } from "./ActivityFeed";
import { AgentLiveStatus } from "./AgentLiveStatus";

// Actor ids that mean "the agent" (mirrors app-store's resolveActor) — used to color/label its bubbles.
const AGENT_ACTORS = new Set(["agent", "worker", "runner"]);
// Events worth surfacing on their own line (never hidden in a collapsed activity cluster) — the things a
// human acts on: the agent's questions, your answers, and review verdicts/requests.
const IMPORTANT_KINDS = new Set(["input_request", "input_answer", "review", "review_requested", "artifact"]);

// A stable key for de-duplicating consecutive routine events (the repeated "working…" progress notes).
function eventKey(e: TaskEvent): string {
  const p = e.payload ?? {};
  if (e.kind === "progress") return `progress|${(p.step as string) ?? ""}|${(p.message as string) ?? ""}`;
  if (e.kind === "status") return `status|${(p.to as string) ?? ""}`;
  return e.kind;
}

// A discussion message collapses to a precise 160px; if it's taller, a Show more/less toggle reveals the
// rest. Keeps long agent replies and pasted context from flooding the thread while staying one click away.
const COMMENT_MAX_PX = 160;

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied."))
    .catch(() => toast.error("Copy failed."));
}

// A single activity event rendered inline in the interaction timeline (a compact "step" line, lighter
// than a message bubble) — reuses the Activity feed's describe() so the phrasing/icons stay consistent.
function ActivityLine({ event, actorName }: { event: TaskEvent; actorName: string }) {
  const { icon: Icon, phrase, tone } = describe(event);
  return (
    <li className="flex items-start gap-2 px-1 text-[12px] leading-snug text-muted-foreground">
      <span className={cn("mt-[3px] shrink-0", tone === "accent" ? "text-primary" : "text-muted-foreground/60")}>
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <b className="font-medium text-foreground/75">{actorName}</b> {phrase}
        <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">{relativeTime(event.createdAt)}</span>
      </span>
    </li>
  );
}

// A run of routine activity between two messages, collapsed to one "N updates" line you can expand.
// Consecutive duplicate notes (the repeated "working…") are de-duped so it reads cleanly; a single event
// renders as a plain line (no collapse chrome). The live "what's it doing now" card is separate (foot).
function ActivityCluster({ events, resolveActor }: { events: TaskEvent[]; resolveActor: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const deduped = useMemo(() => {
    const out: TaskEvent[] = [];
    let lastKey = "";
    for (const e of events) {
      const k = eventKey(e);
      if (k !== lastKey) out.push(e);
      lastKey = k;
    }
    return out;
  }, [events]);

  if (deduped.length <= 1) {
    return deduped[0] ? <ActivityLine event={deduped[0]} actorName={resolveActor(deduped[0].actor)} /> : null;
  }

  const last = deduped[deduped.length - 1];
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Activity className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="shrink-0 font-medium">{deduped.length} updates</span>
        {!open && <span className="min-w-0 flex-1 truncate text-left text-muted-foreground/70">· {describe(last).phrase}</span>}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 border-l border-border/50 pl-3">
          {deduped.map((e) => (
            <ActivityLine key={e.id} event={e} actorName={resolveActor(e.actor)} />
          ))}
        </ul>
      )}
    </li>
  );
}

// An important event (the agent's question, your answer, a review verdict) — always shown, accented, so
// the things you need to act on never get buried in a collapsed cluster.
function ImportantEvent({ event, actorName }: { event: TaskEvent; actorName: string }) {
  const { icon: Icon, phrase } = describe(event);
  return (
    <li className="flex items-start gap-2 rounded-lg border border-primary/20 border-l-2 border-l-primary/50 bg-primary/[0.04] px-2.5 py-1.5 text-[12px] leading-snug">
      <span className="mt-[3px] shrink-0 text-primary">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <b className="font-medium text-foreground/80">{actorName}</b> {phrase}
        <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">{relativeTime(event.createdAt)}</span>
      </span>
    </li>
  );
}

// One message, styled by who sent it: you (right, accent), the agent (left, faint-accent + bot mark), or
// another person (left, neutral) — three distinct colors so the back-and-forth reads at a glance.
function CommentBubble({
  c,
  mine,
  isAgent,
  actorName,
}: {
  c: Comment;
  mine: boolean;
  isAgent: boolean;
  actorName: string;
}) {
  return (
    <li className={cn("group flex flex-col gap-1", mine && "items-end")}>
      <div className={cn("flex items-center gap-2 px-1 text-[11px] text-muted-foreground", mine && "flex-row-reverse")}>
        <span className={cn("inline-flex items-center gap-1 font-medium", isAgent ? "text-primary" : "text-foreground/80")}>
          {isAgent && <Bot className="size-3" />}
          {mine ? "You" : actorName}
        </span>
        {c.anchor !== "general" && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{c.anchor}</span>
        )}
        <span className="tabular-nums">{relativeTime(c.createdAt)}</span>
        <button
          type="button"
          onClick={() => copyText(c.body)}
          title="Copy message"
          aria-label="Copy message"
          className="grid size-5 place-items-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Copy className="size-3" />
        </button>
      </div>
      <div
        className={cn(
          "max-w-[86%] px-3 py-2 shadow-card",
          mine
            ? "rounded-lg rounded-tr-sm border border-primary/25 bg-primary/10"
            : isAgent
              ? "rounded-lg rounded-tl-sm border border-primary/15 bg-primary/[0.04]"
              : "rounded-lg rounded-tl-sm border border-border/60 bg-card",
        )}
      >
        <CommentBody text={c.body} />
      </div>
    </li>
  );
}

function CommentBody({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight > COMMENT_MAX_PX + 4);
  }, [text]);

  // Double-click anywhere on an expandable message toggles it — a quick way to close one you opened.
  return (
    <div onDoubleClick={() => overflows && setExpanded((v) => !v)}>
      <div className="relative">
        <p
          ref={ref}
          className={cn(
            "whitespace-pre-wrap text-[13px] leading-snug text-foreground/90",
            !expanded && overflows && "max-h-[160px] overflow-hidden",
          )}
        >
          {text}
        </p>
        {overflows && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// Hand a backlog task to the agent (starts planning) or ping an already-engaged task to pick up now.
// Both just enqueue a wake the runner drains — the board is the only interface the human needs.
export function AgentActions({ task, onDone }: { task: Task; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const canHandOff = task.status === "backlog";
  // Only where the agent has meaningful next work — not verifying/done/terminal, where a ping would
  // wrongly re-plan (there's no "verify" mode yet). needs_input should be answered, not pinged.
  const canPing = ["researching", "plan_review", "ready_to_work", "in_progress"].includes(task.status);
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
export function CommentThread({
  taskId,
  events = [],
  task,
  runs,
  resolveActor,
  onPosted,
}: {
  taskId: string;
  /** Task activity events, interleaved with the comments to form one interaction timeline. */
  events?: TaskEvent[];
  task: Task;
  runs: Run[];
  resolveActor: (id: string) => string;
  onPosted: () => void;
}) {
  const { user } = useApp();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // stick to the bottom unless the user scrolled up

  const run = runs.length ? runs[runs.length - 1] : null;
  const agentActive = run?.status === "running" || run?.status === "starting";

  const load = useCallback(async () => {
    try {
      const r = await api.listComments(taskId);
      setComments(r.comments);
    } catch {
      /* a failed thread fetch is non-fatal — the box still works */
    }
  }, [taskId]);

  // Poll so the agent's replies appear live (events already stream in via props).
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  function onScroll() {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  async function post() {
    const text = body.trim();
    if (!text || busy) return;
    stickRef.current = true; // sending always jumps you to the newest message
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

  // One interaction timeline, oldest first: your/agent messages as bubbles, the important events
  // (questions, answers, reviews) on their own accented lines, and routine activity grouped into
  // collapsible clusters between messages. The 'comment' event kind is dropped (comments are bubbles).
  type Row =
    | { kind: "comment"; c: Comment }
    | { kind: "important"; e: TaskEvent }
    | { kind: "cluster"; events: TaskEvent[] };
  const rows = useMemo<Row[]>(() => {
    const merged = [
      ...comments.map((c) => ({ at: c.createdAt, comment: c as Comment | null, event: null as TaskEvent | null })),
      ...events
        .filter((e) => e.kind !== "comment")
        .map((e) => ({ at: e.createdAt, comment: null as Comment | null, event: e as TaskEvent | null })),
    ].sort((a, b) => a.at - b.at);

    const out: Row[] = [];
    let cluster: TaskEvent[] = [];
    const flush = () => {
      if (cluster.length) out.push({ kind: "cluster", events: cluster });
      cluster = [];
    };
    for (const m of merged) {
      if (m.comment) {
        flush();
        out.push({ kind: "comment", c: m.comment });
      } else if (m.event && IMPORTANT_KINDS.has(m.event.kind)) {
        flush();
        out.push({ kind: "important", e: m.event });
      } else if (m.event) {
        cluster.push(m.event);
      }
    }
    flush();
    return out;
  }, [comments, events]);

  // Keep the view pinned to the newest message/activity while the user is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, agentActive]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Messages — fill the panel and scroll (no list height cap); each message still collapses at 160px. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 py-4"
        style={{ minHeight: 200 }}
      >
        {rows.length === 0 ? (
          <p className="grid h-full place-items-center px-4 text-center text-[12.5px] text-muted-foreground">
            No interaction yet — say something to steer the agent.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row, i) => {
              if (row.kind === "comment") {
                return (
                  <CommentBubble
                    key={`c-${row.c.id}`}
                    c={row.c}
                    mine={row.c.author === user.id}
                    isAgent={AGENT_ACTORS.has(row.c.author)}
                    actorName={resolveActor(row.c.author)}
                  />
                );
              }
              if (row.kind === "important") {
                return <ImportantEvent key={`e-${row.e.id}`} event={row.e} actorName={resolveActor(row.e.actor)} />;
              }
              return <ActivityCluster key={`cl-${i}`} events={row.events} resolveActor={resolveActor} />;
            })}
          </ul>
        )}
        {/* Live "what's it doing now" card at the foot — shown while the agent is working OR while it's
            waiting on you. It never collapses (unlike the activity clusters above it). */}
        {(agentActive || task.status === "needs_input") && (
          <div className="mt-3 px-1">
            <AgentLiveStatus task={task} runs={runs} />
          </div>
        )}
      </div>

      {/* Composer — input + send as one component, pinned at the foot. Enter sends, Shift+Enter newlines. */}
      <div className="shrink-0 border-t border-border/60 p-3">
        <div className="flex items-end gap-1.5 rounded-lg border border-border/60 bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void post();
              }
            }}
            placeholder="Message the agent…"
            rows={1}
            className="max-h-32 min-h-[34px] flex-1 resize-none border-0 bg-transparent p-1 text-[13px] shadow-none focus-visible:ring-0"
          />
          <Button size="icon" disabled={busy || !body.trim()} onClick={post} aria-label="Send" className="size-8 shrink-0">
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
