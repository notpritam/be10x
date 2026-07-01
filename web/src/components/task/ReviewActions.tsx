// ABOUTME: Plan-review gate. Approve → ready_to_work; Request changes → researching. Both post a review.
import { useState } from "react";
import { Check, GitPullRequestArrow, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { Textarea } from "@/components/ui/textarea";

export function ReviewActions({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<null | "approved" | "changes_requested">(null);

  async function submit(verdict: "approved" | "changes_requested") {
    setBusy(verdict);
    try {
      await api.submitReview(taskId, verdict, comment.trim() || undefined);
      toast.success(
        verdict === "approved"
          ? "Plan approved. Moved to ready to work."
          : "Changes requested. Sent back to research.",
      );
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        background: "color-mix(in oklab, var(--status-plan_review) 7%, var(--card))",
        borderColor: "color-mix(in oklab, var(--status-plan_review) 28%, var(--border))",
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <GitPullRequestArrow className="size-4" style={{ color: "var(--status-plan_review)" }} />
        <h3 className="text-[13px] font-bold text-foreground">Plan review</h3>
      </div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        This plan is waiting on your review. Approve to send it to work, or request changes to send it
        back to research.
      </p>

      <Textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Add a note for the author (optional)"
        rows={2}
        className="mb-3 resize-none bg-card text-[13px]"
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void submit("changes_requested")}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {busy === "changes_requested" ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
          Request changes
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void submit("approved")}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {busy === "approved" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Approve
        </button>
      </div>
    </div>
  );
}
