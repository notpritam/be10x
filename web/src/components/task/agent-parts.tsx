// ABOUTME: Shared agent-interaction blocks used by both the slide-over and the deep-dive: the hand-off /
// pick-up-now action row, and the comment thread the agent reads on its next wake.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import type { Comment, Task } from "@/lib/types";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// A discussion message collapses to a precise 160px; if it's taller, a Show more/less toggle reveals the
// rest. Keeps long agent replies and pasted context from flooding the thread while staying one click away.
const COMMENT_MAX_PX = 160;

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied."))
    .catch(() => toast.error("Copy failed."));
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
        <div className="max-h-[44vh] overflow-y-auto scroll-thin pr-0.5">
          <ul className="space-y-2">
            {comments.map((c) => (
            <li key={c.id} className="group rounded-lg border border-border/60 bg-card px-3 py-1.5 shadow-card">
              <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{resolveActor(c.author)}</span>
                {c.anchor !== "general" && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{c.anchor}</span>
                )}
                <span className="ml-auto tabular-nums">{relativeTime(c.createdAt)}</span>
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
              <CommentBody text={c.body} />
            </li>
          ))}
          </ul>
        </div>
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
