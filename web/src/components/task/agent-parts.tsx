// ABOUTME: Shared agent-interaction blocks used by both the slide-over and the deep-dive: the hand-off /
// pick-up-now action row, and the comment thread the agent reads on its next wake.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Comment, Task } from "@/lib/types";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Hand a backlog task to the agent (starts planning) or ping an already-engaged task to pick up now.
// Both just enqueue a wake the runner drains — the board is the only interface the human needs.
export function AgentActions({ task, onDone }: { task: Task; onDone: () => void }) {
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
