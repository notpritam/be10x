// ABOUTME: Assemble a shareable Markdown summary of a bug (identity, root-cause, environment, repro, test
// ABOUTME: login, notes) — for pasting into Slack / a PR / an issue tracker. Pure; no React, no I/O.
import type { Bug, BugAnalysis, BugEnvironment } from "./types";

function envLine(env?: BugEnvironment): string {
  if (!env) return "";
  const parts: string[] = [];
  const browser = env.brands?.find((b) => !/not.?a.?brand/i.test(b));
  if (browser) parts.push(browser);
  else if (env.userAgent) parts.push(env.userAgent.slice(0, 60));
  if (env.platform) parts.push(env.platform);
  if (env.screen) parts.push(`${env.screen.w}×${env.screen.h}${env.screen.dpr ? ` @${env.screen.dpr}×` : ""}`);
  if (env.timezone) parts.push(env.timezone);
  if (env.online === false) parts.push("offline");
  return parts.join(" · ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Build the Markdown summary. `opts` supplies human-readable team/project names when known. */
export function buildBugMarkdown(
  bug: Bug,
  analysis?: BugAnalysis | null,
  opts: { teamName?: string; projectName?: string; date?: string } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${bug.humanId} — ${bug.title}`);
  lines.push("");

  const meta: string[] = [`**Status:** ${cap(bug.status.replace(/_/g, " "))}`, `**Severity:** ${cap(bug.severity)}`];
  lines.push(meta.join(" · "));
  lines.push(`**Page:** ${bug.pageUrl}`);
  if (opts.date) lines.push(`**Reported:** ${opts.date}`);
  const owner: string[] = [];
  if (opts.teamName) owner.push(`**Team:** ${opts.teamName}`);
  if (opts.projectName) owner.push(`**Project:** ${opts.projectName}`);
  if (owner.length) lines.push(owner.join(" · "));
  if (bug.tags.length) lines.push(`**Tags:** ${bug.tags.join(", ")}`);

  if (bug.description) {
    lines.push("", "## Description", bug.description.trim());
  }

  if (analysis && (analysis.evidence.length || analysis.suspectedComponent || analysis.errorCount > 0)) {
    lines.push("", `## Likely root cause (${analysis.confidence} confidence)`, analysis.suspectedCause);
    if (analysis.suspectedComponent) {
      lines.push(`- Component: \`${analysis.suspectedComponent}\`${analysis.suspectedSource ? ` — \`${analysis.suspectedSource}\`` : ""}`);
    }
    if (analysis.evidence.length) {
      lines.push("", "**Evidence**");
      for (const e of analysis.evidence) lines.push(`- ${e}`);
    }
    if (analysis.reproSteps.length) {
      lines.push("", "**Repro**");
      analysis.reproSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
  }

  const env = envLine(bug.meta.environment);
  if (env) lines.push("", "## Environment", env);

  const creds = bug.meta.credentials;
  if (creds && (creds.username || creds.password || creds.notes)) {
    lines.push("", "## Test credentials");
    if (creds.username) lines.push(`- Username: ${creds.username}`);
    if (creds.password) lines.push(`- Password: ${creds.password}`);
    if (creds.notes) lines.push(`- Other: ${creds.notes}`);
  }

  if (bug.meta.notes) lines.push("", "## QA notes", bug.meta.notes.trim());

  return lines.join("\n").trim() + "\n";
}
