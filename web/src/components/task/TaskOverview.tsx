// ABOUTME: The full-screen "Overview" for a task — the whole story/artifact trail at any point: the
// original ask, every plan version over time (each viewable, current one marked in-use), research, the
// affected files + changes, where/how it ran, shipped artifacts, and the lifecycle step history.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, GitBranch, GitCommitHorizontal, X } from "lucide-react";
import { api, type PlanVersion } from "@/lib/api";
import type { Run, Task, TaskEvent } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { cn, humanizeKey, relativeTime } from "@/lib/utils";
import { PlanView } from "./PlanView";
import { DataValue } from "./detail-parts";
import { describe } from "./ActivityFeed";

interface GitMeta {
  commits?: { sha: string; subject: string }[];
  stat?: string;
}

const PROMPT_KEYS = ["symptom", "summary", "question", "description"] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-5">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</h3>
      {children}
    </section>
  );
}

function isUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//.test(v);
}

export function TaskOverview({
  task,
  runs,
  events,
  onClose,
}: {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [openVersion, setOpenVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPlanVersions(task.id)
      .then((r) => {
        setVersions(r.versions);
        setOpenVersion(r.versions[0]?.id ?? null); // current plan expanded by default
      })
      .catch(() => setVersions([]));
  }, [task.id]);

  const run = runs.length ? runs[runs.length - 1] : null;
  const git: GitMeta | null =
    run?.result && typeof run.result === "object" ? ((run.result as { git?: GitMeta }).git ?? null) : null;
  const gitHasData = !!git && (!!git.stat || !!(git.commits && git.commits.length));

  const prompt = PROMPT_KEYS.map((k) => task.content?.[k]).find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );

  const refs =
    task.refs && typeof task.refs === "object" && !Array.isArray(task.refs)
      ? (task.refs as Record<string, unknown>)
      : null;
  const refEntries = refs ? Object.entries(refs) : [];

  // Milestone steps: status changes + the meaningful artifact events, oldest first.
  const steps = useMemo(
    () =>
      events.filter((e) =>
        ["created", "status", "plan", "research", "review", "review_requested", "ship", "input_answer"].includes(e.kind),
      ),
    [events],
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-5 py-3">
        <span className="font-mono text-[11.5px] font-medium tracking-wide text-muted-foreground">{task.humanId}</span>
        <h2 className="min-w-0 truncate text-[14px] font-semibold text-foreground">{task.title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Overview</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="ml-auto grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-[18px]" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-[900px] space-y-6 px-8 py-8">
          {/* The ask */}
          {prompt && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">The ask</h3>
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">{prompt}</p>
            </section>
          )}

          {/* Plans over time */}
          <Section title={`Plans over time${versions.length ? ` · ${versions.length}` : ""}`}>
            {versions.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">No plan versions yet.</p>
            ) : (
              <ul className="space-y-2">
                {versions.map((v, i) => {
                  const label = i === 0 ? "Current — in use" : i === versions.length - 1 ? "Initial" : `v${versions.length - i}`;
                  const open = openVersion === v.id;
                  return (
                    <li key={v.id} className="overflow-hidden rounded-[8px] border border-border/60 bg-card">
                      <button
                        type="button"
                        onClick={() => setOpenVersion(open ? null : v.id)}
                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
                      >
                        <ChevronDown
                          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
                        />
                        <span
                          className={cn(
                            "text-[12.5px] font-semibold",
                            i === 0 ? "text-primary" : "text-foreground",
                          )}
                        >
                          {label}
                        </span>
                        <span className="text-[11.5px] text-muted-foreground">· {relativeTime(v.createdAt)}</span>
                      </button>
                      {open && (
                        <div className="border-t border-border/50 px-4 py-4">
                          <PlanView plan={v.plan} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {task.research != null && (
            <Section title="Research">
              <DataValue value={task.research} />
            </Section>
          )}

          {/* Changes / affected files */}
          {gitHasData && git && (
            <Section title="Changes & affected files">
              {git.stat && (
                <p className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <GitCommitHorizontal className="size-4" /> {git.stat}
                </p>
              )}
              {git.commits && git.commits.length > 0 && (
                <ul className="space-y-1">
                  {git.commits.map((c) => (
                    <li key={c.sha} className="flex gap-2 text-[12.5px]">
                      <code className="shrink-0 font-mono text-[11px] text-primary">{c.sha}</code>
                      <span className="min-w-0 text-foreground/90">{c.subject}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {/* Where it ran */}
          {run && (
            <Section title="Where it ran">
              <dl className="space-y-1.5 text-[12.5px]">
                {run.branch && (
                  <Row label="Branch">
                    <span className="inline-flex items-center gap-1.5">
                      <GitBranch className="size-3.5 text-muted-foreground" />
                      <code className="font-mono text-[11.5px]">{run.branch}</code>
                    </span>
                  </Row>
                )}
                {run.worktreePath && (
                  <Row label="Repo">
                    <code className="break-all font-mono text-[11px] text-muted-foreground">{run.worktreePath}</code>
                  </Row>
                )}
                {(run.model || run.executor) && (
                  <Row label="Model">
                    <span className="capitalize">{run.executor}</span>
                    {run.model && (
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {run.model}
                      </span>
                    )}
                  </Row>
                )}
                {run.sessionId && (
                  <Row label="Session">
                    <code className="break-all font-mono text-[11px] text-muted-foreground">{run.sessionId}</code>
                  </Row>
                )}
              </dl>
            </Section>
          )}

          {refEntries.length > 0 && (
            <Section title="Artifacts">
              <dl className="space-y-1.5 text-[12.5px]">
                {refEntries.map(([k, v]) => (
                  <Row key={k} label={humanizeKey(k)}>
                    {isUrl(v) ? (
                      <a href={v} target="_blank" rel="noreferrer" className="break-all text-primary underline underline-offset-2">
                        {v}
                      </a>
                    ) : (
                      <span className="break-all">{typeof v === "string" ? v : JSON.stringify(v)}</span>
                    )}
                  </Row>
                ))}
              </dl>
            </Section>
          )}

          {/* Step history */}
          <Section title="Steps">
            {steps.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">No steps recorded yet.</p>
            ) : (
              <ol className="space-y-2.5">
                {steps.map((e) => {
                  const { icon: Icon, phrase } = describe(e);
                  const to = e.kind === "status" ? (e.payload?.to as string | undefined) : undefined;
                  return (
                    <li key={e.id} className="flex items-start gap-2.5 text-[12.5px] text-muted-foreground">
                      <span
                        className="mt-0.5 shrink-0"
                        style={to ? { color: STATUS_META[to as keyof typeof STATUS_META]?.color } : undefined}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        {phrase}
                        <span className="ml-1.5 text-[11px] text-muted-foreground/60">{relativeTime(e.createdAt)}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[76px] shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground/90">{children}</dd>
    </div>
  );
}
