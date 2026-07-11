// ABOUTME: Optional GitHub issue export — files a bug as an issue in a configured repo. Uses the GitHub REST
// ABOUTME: API via global fetch (no SDK). The issue body is built from the capture + heuristic RCA; test
// ABOUTME: credentials are DELIBERATELY never included. Inert unless GFA_GITHUB_TOKEN + GFA_GITHUB_REPO are set.
import { analyzeBug } from './analyze.js';

// Build the issue body (Markdown) from the bug + its heuristic root cause. Pure. Never includes credentials.
export function bugToIssueMarkdown(bug, { bugUrl } = {}) {
  const a = analyzeBug(bug);
  const m = (bug && bug.meta) || {};
  const lines = [];
  lines.push(`**${bug.humanId}** · severity **${bug.severity}** · status **${bug.status}**`);
  lines.push(`**Page:** ${bug.pageUrl}`);
  if (bugUrl) lines.push(`**be10x board:** ${bugUrl} (open ${bug.humanId} for the replay, network + console)`);
  if (bug.description) lines.push('', bug.description.trim());

  if (a.suspectedCause && (a.evidence.length || a.suspectedComponent || a.errorCount > 0)) {
    lines.push('', `### Likely root cause (${a.confidence} confidence)`, a.suspectedCause);
    if (a.suspectedComponent) {
      lines.push(`- Component: \`${a.suspectedComponent}\`${a.suspectedSource ? ` — \`${a.suspectedSource}\`` : ''}`);
    }
    if (a.evidence.length) {
      lines.push('', '**Evidence**');
      for (const e of a.evidence) lines.push(`- ${e}`);
    }
  }
  if (a.reproSteps.length) {
    lines.push('', '### Repro');
    a.reproSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  const env = m.environment;
  if (env) {
    const bits = [env.brands && env.brands[0], env.platform, env.screen && `${env.screen.w}×${env.screen.h}`].filter(Boolean).join(' · ');
    if (bits) lines.push('', `**Environment:** ${bits}`);
  }
  if (m.notes) lines.push('', '### QA notes', String(m.notes).slice(0, 800));
  lines.push('', '_Filed via be10x._');
  return lines.join('\n');
}

// Create a GitHub issue for the bug. Throws NO_GITHUB_CONFIG when the token/repo aren't configured (the caller
// turns that into a 409). `fetchImpl` is injectable for tests. repo is "owner/name".
export async function createGithubIssue(bug, opts = {}) {
  const token = opts.token ?? process.env.GFA_GITHUB_TOKEN;
  const repo = opts.repo ?? process.env.GFA_GITHUB_REPO;
  if (!token || !repo) throw new Error('NO_GITHUB_CONFIG');
  const doFetch = opts.fetchImpl ?? fetch;

  const resp = await doFetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'be10x',
    },
    body: JSON.stringify({
      title: `[be10x ${bug.humanId}] ${bug.title}`,
      body: bugToIssueMarkdown(bug, { bugUrl: opts.bugUrl }),
      ...(Array.isArray(opts.labels) && opts.labels.length ? { labels: opts.labels } : {}),
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error('GITHUB_HTTP_' + resp.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  const data = await resp.json();
  if (!data || !data.html_url) throw new Error('GITHUB_NO_URL');
  return { url: data.html_url, number: data.number };
}
