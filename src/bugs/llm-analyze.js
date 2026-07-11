// ABOUTME: Optional LLM-backed root-cause analysis — upgrades the deterministic heuristic (analyze.js) when a
// ABOUTME: key is configured. Calls the Anthropic messages API via global fetch (no SDK). The prompt is built
// ABOUTME: from NON-sensitive signals only — test credentials and auth tokens are deliberately never included.

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const oneLine = (s, n) => String(s ?? '').split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Build the analysis prompt from a hydrated bug + the heuristic guess + (optional) network failures. Pure.
// Deliberately excludes bug.meta.credentials and any Authorization headers — those never leave the board.
export function buildRcaPrompt(bug, { heuristic, networkFailures } = {}) {
  const m = (bug && bug.meta) || {};
  const lines = [];
  lines.push(
    'You are a senior engineer triaging a web bug from a QA capture. Give a concise root-cause analysis: the single most likely cause, the suspected file/component, and 2–4 concrete next steps to confirm or fix it. Be specific, technical, and under 180 words. Do not restate the raw data or add pleasantries.',
  );
  lines.push('');
  lines.push('BUG: ' + (bug.title || '(untitled)'));
  lines.push('PAGE: ' + (bug.pageUrl || '(unknown)'));
  if (heuristic && heuristic.suspectedCause) {
    const comp = heuristic.suspectedComponent
      ? ' [component ' + heuristic.suspectedComponent + (heuristic.suspectedSource ? ' @ ' + heuristic.suspectedSource : '') + ']'
      : '';
    lines.push('HEURISTIC GUESS: ' + heuristic.suspectedCause + comp);
  }
  const errs = (m.console || []).filter((c) => c.level === 'error').slice(0, 8);
  if (errs.length) {
    lines.push('', 'CONSOLE ERRORS:');
    for (const e of errs) lines.push('- ' + oneLine(e.text, 300));
  }
  const picked = (m.pickedElements || []).slice(0, 5);
  if (picked.length) {
    lines.push('', 'PICKED ELEMENTS (what the reporter pointed at):');
    for (const p of picked) {
      const react = p.react && p.react.component ? ' [' + p.react.component + (p.react.source ? ' @ ' + p.react.source : '') + ']' : '';
      lines.push('- ' + p.selector + react + (p.note ? ' — note: "' + oneLine(p.note, 140) + '"' : ''));
    }
  }
  if (networkFailures && networkFailures.length) {
    lines.push('', 'NETWORK FAILURES:');
    for (const f of networkFailures.slice(0, 12)) lines.push('- ' + (f.method || 'GET') + ' ' + f.url + ' -> ' + f.status);
  }
  if (m.notes) lines.push('', 'QA NOTES:', oneLine(m.notes, 500));
  const env = m.environment;
  if (env) {
    const bits = [env.brands && env.brands[0], env.platform].filter(Boolean).join(' / ');
    if (bits) lines.push('', 'ENV: ' + bits);
  }
  return lines.join('\n');
}

// Run the LLM analysis. Throws NO_LLM_KEY when no key is configured (the caller turns that into a 409). The
// real network call is only reached when a key is set. `fetchImpl` is injectable for tests.
export async function llmAnalyzeBug(bug, opts = {}) {
  const key = opts.key ?? process.env.GFA_LLM_KEY;
  if (!key) throw new Error('NO_LLM_KEY');
  const model = opts.model ?? process.env.GFA_LLM_MODEL ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const prompt = buildRcaPrompt(bug, { heuristic: opts.heuristic, networkFailures: opts.networkFailures });

  const resp = await doFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error('LLM_HTTP_' + resp.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  const data = await resp.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    : '';
  if (!text) throw new Error('LLM_EMPTY');
  return { text, model, generatedAt: opts.now ?? Date.now() };
}
