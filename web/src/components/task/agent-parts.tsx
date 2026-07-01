// ABOUTME: Shared agent-interaction blocks used by both the slide-over and the deep-dive: the hand-off /
// pick-up-now action row, and the comment thread the agent reads on its next wake.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { Comment, Task, TaskEvent } from "@/lib/types";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describe } from "./ActivityFeed";

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
  resolveActor,
  onPosted,
}: {
  taskId: string;
  /** Task activity events, interleaved with the comments to form one interaction timeline. */
  events?: TaskEvent[];
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

  // One interaction timeline: comments (as bubbles) + activity events (compact step lines), oldest first.
  // The 'comment' event kind is dropped — comments already render as bubbles.
  const items = useMemo(() => {
    const merged: (
      | { kind: "comment"; at: number; c: Comment }
      | { kind: "event"; at: number; e: TaskEvent }
    )[] = [
      ...comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, c })),
      ...events.filter((e) => e.kind !== "comment").map((e) => ({ kind: "event" as const, at: e.createdAt, e })),
    ];
    merged.sort((a, b) => a.at - b.at);
    return merged;
  }, [comments, events]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Messages — fill the panel and scroll (no list height cap); each message still collapses at 160px. */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 py-4" style={{ minHeight: 200 }}>
        {items.length === 0 ? (
          <p className="grid h-full place-items-center px-4 text-center text-[12.5px] text-muted-foreground">
            No interaction yet — say something to steer the agent.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((it) =>
              it.kind === "comment" ? (
                <li key={`c-${it.c.id}`} className="group flex flex-col gap-1">
                  <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{resolveActor(it.c.author)}</span>
                    {it.c.anchor !== "general" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{it.c.anchor}</span>
                    )}
                    <span className="ml-auto tabular-nums">{relativeTime(it.c.createdAt)}</span>
                    <button
                      type="button"
                      onClick={() => copyText(it.c.body)}
                      title="Copy message"
                      aria-label="Copy message"
                      className="grid size-5 place-items-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                  <div className="rounded-lg rounded-tl-sm border border-border/60 bg-card px-3 py-2 shadow-card">
                    <CommentBody text={it.c.body} />
                  </div>
                </li>
              ) : (
                <ActivityLine key={`e-${it.e.id}`} event={it.e} actorName={resolveActor(it.e.actor)} />
              ),
            )}
          </ul>
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
