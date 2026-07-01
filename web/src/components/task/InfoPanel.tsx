// ABOUTME: A compact "Info / metadata" card that shows a task's whole picture at a glance — where the
// agent worked (repo, branch, model, session), the originating ask, current state, the git changes it
// produced, shipped artifacts, and the humans who touched it. Purely presentational; renders each
// section only when its data exists.
import type { ReactNode } from "react";
import {
  Activity,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Info,
  MessageSquareText,
  Package,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Run, Task, TaskEvent } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { humanizeKey } from "@/lib/utils";
import { PriorityPill, StatusDot, TypeTag, UserAvatar } from "@/components/common/bits";

interface GitMeta {
  commits?: { sha: string; subject: string }[];
  stat?: string;
}

/** Actors that are the machine, not a person — excluded from the "People" row. */
const NON_HUMAN = new Set(["agent", "worker", "runner", "system"]);
/** Content keys, in priority order, that hold the originating ask. */
const PROMPT_KEYS = ["symptom", "summary", "question", "description"] as const;

function isUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//.test(v);
}

/** A label / value line — 76px muted label, value fills the rest. Mirrors the Work panel rows. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[76px] shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12.5px] text-foreground/90">{children}</dd>
    </div>
  );
}

/** A titled section inside the card — quiet uppercase eyebrow with an icon. */
function Block({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="px-4 py-3.5">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <Icon className="size-3.5" /> {title}
      </p>
      {children}
    </section>
  );
}

export function InfoPanel({ task, runs, events }: { task: Task; runs: Run[]; events: TaskEvent[] }) {
  // The latest run carries the "where/how it worked" metadata — mirror the Work panel's selection.
  const run = runs.length ? runs[runs.length - 1] : null;

  const git: GitMeta | null =
    run?.result && typeof run.result === "object" ? ((run.result as { git?: GitMeta }).git ?? null) : null;
  const gitHasData = !!git && (!!git.stat || !!(git.commits && git.commits.length));

  const refs =
    task.refs && typeof task.refs === "object" && !Array.isArray(task.refs)
      ? (task.refs as Record<string, unknown>)
      : null;
  const refEntries = refs ? Object.entries(refs) : [];

  // First string present among the originating-ask fields.
  const prompt = PROMPT_KEYS.map((k) => task.content?.[k]).find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );

  const people = Array.from(new Set(events.map((e) => e.actor))).filter(
    (a) => a && !NON_HUMAN.has(a.toLowerCase()),
  );

  const hasRepo = !!run && !!(run.branch || run.worktreePath || run.model || run.sessionId || run.executor);

  return (
    <div className="overflow-hidden rounded-[13px] border border-border/60 bg-card shadow-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <Info className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground" title={task.title}>
          {task.title}
        </h3>
      </header>

      <div className="flex flex-col divide-y divide-border/50">
        {hasRepo && run && (
          <Block icon={FolderGit2} title="Repo & branch">
            <dl className="space-y-1.5">
              {run.branch && (
                <Row label="Branch">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <code className="break-all font-mono text-[11.5px]">{run.branch}</code>
                  </span>
                </Row>
              )}
              {run.worktreePath && (
                <Row label="Repo">
                  <code className="block truncate font-mono text-[11px] text-muted-foreground" title={run.worktreePath}>
                    {run.worktreePath}
                  </code>
                </Row>
              )}
              {(run.model || run.executor) && (
                <Row label="Model">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className="capitalize text-foreground/90">{run.executor}</span>
                    {run.model && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {run.model}
                      </span>
                    )}
                  </span>
                </Row>
              )}
              {run.sessionId && (
                <Row label="Session">
                  <code className="block truncate font-mono text-[11px] text-muted-foreground" title={run.sessionId}>
                    {run.sessionId}
                  </code>
                </Row>
              )}
            </dl>
          </Block>
        )}

        {prompt && (
          <Block icon={MessageSquareText} title="First prompt">
            <p className="line-clamp-6 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
              {prompt}
            </p>
          </Block>
        )}

        <Block icon={Activity} title="State">
          <dl className="space-y-1.5">
            <Row label="Status">
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={task.status} className="size-2" />
                <span className="font-medium text-foreground/90">{STATUS_META[task.status].label}</span>
              </span>
            </Row>
            <Row label="ID">
              <code className="font-mono text-[11.5px] text-muted-foreground">{task.humanId}</code>
            </Row>
            <Row label="Type">
              <TypeTag type={task.type} />
            </Row>
            <Row label="Severity">
              <PriorityPill severity={task.severity} />
            </Row>
          </dl>
        </Block>

        {gitHasData && git && (
          <Block icon={GitCommitHorizontal} title="Changes">
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
          </Block>
        )}

        {refEntries.length > 0 && (
          <Block icon={Package} title="Artifacts">
            <dl className="space-y-1.5">
              {refEntries.map(([k, v]) => (
                <Row key={k} label={humanizeKey(k)}>
                  {isUrl(v) ? (
                    <a
                      href={v}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary underline underline-offset-2"
                    >
                      {v}
                    </a>
                  ) : (
                    <span className="break-all">{typeof v === "string" ? v : JSON.stringify(v)}</span>
                  )}
                </Row>
              ))}
            </dl>
          </Block>
        )}

        {people.length > 0 && (
          <Block icon={Users} title="People">
            <div className="flex items-center gap-2.5">
              <div className="flex -space-x-1.5">
                {people.slice(0, 6).map((a) => (
                  <UserAvatar key={a} name={a} seed={a} size={22} />
                ))}
              </div>
              <span className="text-[12px] text-muted-foreground">
                {people.length} {people.length === 1 ? "person" : "people"}
                {people.length > 6 && (
                  <span className="text-muted-foreground/70"> · +{people.length - 6} more</span>
                )}
              </span>
            </div>
          </Block>
        )}
      </div>
    </div>
  );
}
