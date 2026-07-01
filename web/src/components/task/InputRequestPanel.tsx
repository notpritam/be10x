// ABOUTME: The human-in-the-loop input component. Renders the agent's question with quick-choice chips
// and a custom answer field, posts the answer, and resumes the task (needs_input -> in_progress).
import { useState } from "react";
import { Loader2, MessageCircleQuestion, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { InputRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

export function InputRequestPanel({
  request,
  onAnswered,
}: {
  request: InputRequest;
  onAnswered: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  const answer = custom.trim() || selected || "";

  async function send() {
    if (!answer || busy) return;
    setBusy(true);
    try {
      await api.answerInput(request.id, answer);
      toast.success("Answer sent. Task resumed.");
      onAnswered();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        background: "color-mix(in oklab, var(--status-needs_input) 8%, var(--card))",
        borderColor: "color-mix(in oklab, var(--status-needs_input) 32%, var(--border))",
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <MessageCircleQuestion className="size-4" style={{ color: "#b16207" }} />
        <h3 className="text-[13px] font-bold text-foreground">Needs your input</h3>
      </div>
      <p className="mb-3 text-[13.5px] font-medium leading-relaxed text-foreground">
        {request.question}
      </p>

      {request.choices && request.choices.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {request.choices.map((choice) => {
            const active = selected === choice && !custom.trim();
            return (
              <button
                key={choice}
                type="button"
                onClick={() => {
                  setSelected(choice);
                  setCustom("");
                }}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active
                    ? "border-primary/50 bg-primary/12 text-primary"
                    : "border-border bg-card text-foreground hover:border-primary/30 hover:bg-accent/50",
                )}
              >
                {choice}
              </button>
            );
          })}
        </div>
      )}

      {request.allowCustom && (
        <Textarea
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value.trim()) setSelected(null);
          }}
          placeholder="Or type a custom answer"
          rows={2}
          className="mb-3 resize-none bg-card text-[13px]"
        />
      )}

      <button
        type="button"
        onClick={() => void send()}
        disabled={!answer || busy}
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
        Send answer
      </button>
    </div>
  );
}
