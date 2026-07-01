// ABOUTME: A step-aware lead card at the top of the task page — names the current lifecycle state, says
// what's happening / what to do, and carries the live agent status, so the main view leads with "where
// we are + what's here" instead of the Move/Plan controls. The artifacts (plan, task list, changes,
// research) render below; the Overview holds the full per-step trail.
import type { Run, Status, Task } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { AgentLiveStatus } from "./AgentLiveStatus";

const STEP_COPY: Partial<Record<Status, { body: string }>> = {
  backlog: { body: "Hand this to the agent to start planning — or add more detail first." },
  researching: { body: "The agent is exploring the code and gathering context before it plans. Research artifacts appear below as they land." },
  plan_review: { body: "The plan is ready — review it below, then approve it or request changes." },
  ready_to_work: { body: "Plan approved. The agent will pick it up and start implementing." },
  in_progress: { body: "The agent is working through the task list below and committing changes." },
  needs_input: { body: "The agent asked a question — answer it at the foot of the page to continue." },
  verifying: { body: "The agent finished. Check the task list + changes below, then mark it done or send it back." },
  done: { body: "This task is complete — the plan, changes, and artifacts are captured below and in the Overview." },
  blocked: { body: "Something stopped the agent — the interaction timeline shows why." },
};

export function CurrentStep({ task, runs }: { task: Task; runs: Run[] }) {
  const meta = STATUS_META[task.status];
  const copy = STEP_COPY[task.status];

  return (
    <div className="rounded-[8px] border border-border/60 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: meta.color }} />
        <h2 className="text-[14px] font-semibold text-foreground">{meta.label}</h2>
        <div className="ml-auto">
          <AgentLiveStatus task={task} runs={runs} compact />
        </div>
      </div>
      {copy && <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{copy.body}</p>}
    </div>
  );
}
