// ABOUTME: Renders the agent's submitted output (task.refs — the "ship" step) as a readable, indicator-
// rich report instead of a key:value text dump: PR / branch / links as chips, Summary and What-changed as
// full-width blocks, commits as a checklist, and tests as a ✓/✗ indicator. Unknown fields fall through to
// the shared DataValue renderer. This is the "Summary / Fix / Verification" surface, made scannable.
import type { ReactNode } from "react";
import { CheckCircle2, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, XCircle } from "lucide-react";
import { humanizeKey } from "@/lib/utils";
import { DataValue } from "./detail-parts";

const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Keys given bespoke treatment below — everything else renders generically (via DataValue) after.
const HANDLED = new Set(["pr", "pull_request", "pullrequest", "url", "link", "branch", "summary", "fix", "commits", "tests", "test", "verification"]);

function Label({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {icon}
      {children}
    </p>
  );
}

function LinkChip({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/[0.06] px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
    >
      {icon}
      {children}
    </a>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{text}</p>
    </div>
  );
}

// Turn a free-form "tests" value into a pass/fail indicator when we can (a boolean, a "429 passing"
// string, or a { passed, failed } object). Falls back to just showing the text with a neutral check.
function TestsIndicator({ value }: { value: unknown }) {
  let ok: boolean | null = null;
  let label = "";
  if (typeof value === "boolean") {
    ok = value;
    label = value ? "Passing" : "Failing";
  } else if (typeof value === "string") {
    label = value;
    if (/\b(fail|failing|error|red)\b|✗|✖/i.test(value)) ok = false;
    else if (/\b(pass|passing|passed|ok|green)\b|✓|✔|\d+\s*tests?/i.test(value)) ok = true;
  } else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const passed = Number(o.passed ?? o.passing ?? 0);
    const failed = Number(o.failed ?? o.failing ?? 0);
    ok = failed === 0;
    label = `${passed} passed${failed ? `, ${failed} failed` : ""}`;
  }
  const Icon = ok === false ? XCircle : CheckCircle2;
  const color = ok === false ? "text-red-600" : "text-emerald-600";
  return (
    <div className="flex items-start gap-1.5 text-[13px]">
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <span className="min-w-0 font-medium text-foreground/90">{label || "Tests"}</span>
    </div>
  );
}

export function AgentOutput({ refs }: { refs: Record<string, unknown> }) {
  const pr = str(refs.pr) || str(refs.pull_request) || (isUrl(refs.url) ? (refs.url as string) : null);
  const branch = str(refs.branch);
  const summary = str(refs.summary);
  const fix = str(refs.fix);
  const commits = Array.isArray(refs.commits) ? refs.commits : null;
  const tests = refs.tests ?? refs.test ?? null;
  const verification = refs.verification ?? null;
  const otherLinks = Object.entries(refs).filter(([k, v]) => !HANDLED.has(k.toLowerCase()) && isUrl(v));
  const rest = Object.entries(refs).filter(
    ([k, v]) => !HANDLED.has(k.toLowerCase()) && !isUrl(v) && v != null && v !== "",
  );

  return (
    <div className="space-y-3">
      {(pr || branch || otherLinks.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {pr && (
            <LinkChip href={pr} icon={<GitPullRequest className="size-3.5" />}>
              Pull request
            </LinkChip>
          )}
          {otherLinks.map(([k, v]) => (
            <LinkChip key={k} href={v as string} icon={<ExternalLink className="size-3.5" />}>
              {humanizeKey(k)}
            </LinkChip>
          ))}
          {branch && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-1 text-[11.5px] text-muted-foreground">
              <GitBranch className="size-3.5" />
              <code className="break-all font-mono">{branch}</code>
            </span>
          )}
        </div>
      )}

      {summary && <Block label="Summary" text={summary} />}
      {fix && <Block label="What changed" text={fix} />}

      {commits && commits.length > 0 && (
        <div>
          <Label icon={<GitCommitHorizontal className="size-3.5" />}>Commits ({commits.length})</Label>
          <ul className="space-y-1">
            {commits.map((c, i) => {
              const rec = c && typeof c === "object" ? (c as Record<string, unknown>) : null;
              const text =
                typeof c === "string"
                  ? c
                  : rec
                    ? [rec.sha, rec.subject].filter(Boolean).join(" ")
                    : String(c);
              return (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 break-words font-mono text-[11.5px] leading-snug text-foreground/85">{text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tests != null && (
        <div>
          <Label>Verification</Label>
          <TestsIndicator value={tests} />
        </div>
      )}
      {verification != null && (
        <div>
          <Label>Verification</Label>
          <DataValue value={verification} />
        </div>
      )}

      {rest.length > 0 && (
        <div className="space-y-2">
          {rest.map(([k, v]) => (
            <div key={k}>
              <Label>{humanizeKey(k)}</Label>
              <DataValue value={v} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
