// ABOUTME: The "where/how the agent worked" panel — branch, model/adapter, session, run status + timing,
// worktree, and the agent's submitted output refs (PR, commit, links). Makes the board self-sufficient
// so you never open a terminal to see what happened.
import type { ReactNode } from "react";
import { Bot, GitBranch, GitCommitHorizontal, Package } from "lucide-react";
import type { Run, Task } from "@/lib/types";
import { AgentOutput } from "./AgentOutput";

interface GitMeta {
  commits?: { sha: string; subject: string }[];
  stat?: string;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[84px] shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12.5px] text-foreground/90">{children}</dd>
    </div>
  );
}

const RUN_TONE: Record<string, string> = {
  done: "text-emerald-600",
  running: "text-primary",
  starting: "text-primary",
  failed: "text-red-600",
};

export function WorkSection({ task, runs }: { task: Task; runs: Run[] }) {
  const run = runs.length ? runs[runs.length - 1] : null;
  const refs =
    task.refs && typeof task.refs === "object" && !Array.isArray(task.refs)
      ? (task.refs as Record<string, unknown>)
      : null;

  if (!run && !refs) {
    return <p className="text-[12.5px] text-muted-foreground">The agent hasn't worked this task yet.</p>;
  }

  const tookS =
    run?.startedAt && run?.endedAt ? Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000)) : null;
  const git: GitMeta | null =
    run?.result && typeof run.result === "object" ? ((run.result as { git?: GitMeta }).git ?? null) : null;

  return (
    <div className="space-y-3.5">
      {run && (
        <dl className="space-y-1.5">
          <Row label="Agent">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Bot className="size-3.5 text-muted-foreground" />
              <span className="capitalize">{run.executor}</span>
              {run.model && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                  {run.model}
                </span>
              )}
            </span>
          </Row>
          {run.branch && (
            <Row label="Branch">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5 text-muted-foreground" />
                <code className="break-all font-mono text-[11.5px]">{run.branch}</code>
              </span>
            </Row>
          )}
          <Row label="Status">
            <span className={`font-medium capitalize ${RUN_TONE[run.status] ?? "text-foreground/80"}`}>
              {run.status}
            </span>
            {runs.length > 1 && <span className="ml-2 text-[11px] text-muted-foreground">· {runs.length} runs</span>}
          </Row>
          {tookS != null && <Row label="Took">{tookS}s</Row>}
          {run.sessionId && (
            <Row label="Session">
              <code className="break-all font-mono text-[11px] text-muted-foreground">{run.sessionId}</code>
            </Row>
          )}
          {run.worktreePath && (
            <Row label="Worktree">
              <code className="break-all font-mono text-[11px] text-muted-foreground">{run.worktreePath}</code>
            </Row>
          )}
        </dl>
      )}

      {git && ((git.commits && git.commits.length > 0) || git.stat) && (
        <div className="border-t border-border/50 pt-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <GitCommitHorizontal className="size-3.5" /> Changes
          </p>
          {git.stat && <p className="mb-1.5 text-[12px] text-muted-foreground">{git.stat}</p>}
          {git.commits && git.commits.length > 0 && (
            <ul className="space-y-1">
              {git.commits.map((c) => (
                <li key={c.sha} className="flex gap-2 text-[12px]">
                  <code className="shrink-0 font-mono text-[11px] text-primary">{c.sha}</code>
                  <span className="min-w-0 truncate text-foreground/90">{c.subject}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {refs && Object.keys(refs).length > 0 && (
        <div className="border-t border-border/50 pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <Package className="size-3.5" /> Output
          </p>
          <AgentOutput refs={refs} />
        </div>
      )}
    </div>
  );
}
