// ABOUTME: Deterministic, dependency-free heuristic root-cause analysis of a filed bug from its captured
// ABOUTME: signals (console errors, error markers, picked component/source, QA notes, credentials, env).
// ABOUTME: Pure function over a hydrated bug — reused by the bug MCP (bug_analyze) and the dashboard RCA card.

const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

// analyzeBug(bug) → { suspectedCause, confidence, evidence[], reproSteps[], suspectedComponent,
// suspectedSource, errorCount, signals }. No I/O; operates only on the hydrated bug (meta_json). Network
// failures live in an artifact, not meta, so they are out of scope here (callers can enrich separately).
export function analyzeBug(bug) {
  const m = (bug && bug.meta) || {};
  const consoleErrors = (m.console || []).filter((c) => c.level === 'error');
  const picked = m.pickedElements || [];
  const markers = m.markers || [];
  const evidence = [];

  // Strongest signal: a captured JS error.
  let suspectedCause = null;
  let confidence = 'low';
  if (consoleErrors.length > 0) {
    const first = firstLine(consoleErrors[0].text);
    suspectedCause = 'JavaScript error: ' + first.slice(0, 200);
    confidence = 'medium';
    evidence.push(consoleErrors.length + ' error-level console line(s). First: "' + first.slice(0, 160) + '"');
  }

  // The element the reporter pinpointed → the likeliest code location.
  let suspectedComponent = null;
  let suspectedSource = null;
  const withComponent = picked.find((p) => p.react && p.react.component);
  if (withComponent) {
    suspectedComponent = withComponent.react.component;
    if (withComponent.react.source) suspectedSource = withComponent.react.source;
  }
  if (!suspectedSource) {
    const withSource = picked.find((p) => p.react && p.react.source);
    if (withSource) suspectedSource = withSource.react.source;
  }
  if (suspectedComponent) {
    evidence.push('Reporter pinpointed the <' + suspectedComponent + '> component' + (suspectedSource ? ' (' + suspectedSource + ')' : '') + '.');
  } else if (picked.length > 0) {
    evidence.push('Reporter pinpointed ' + picked.length + ' element(s): ' + picked.slice(0, 3).map((p) => p.selector).join(', '));
  }
  for (const p of picked) {
    if (p.note) evidence.push('Note on ' + p.selector + ': "' + String(p.note).slice(0, 140) + '"');
  }

  // Marked moments.
  const errorMarkers = markers.filter((mk) => mk.kind === 'error');
  if (errorMarkers.length > 0) evidence.push(errorMarkers.length + ' error moment(s) auto-marked on the replay clock.');
  const userMarkers = markers.filter((mk) => mk.kind !== 'error');
  if (userMarkers.length > 0) evidence.push('Reporter marked "' + (userMarkers[0].label || 'the bug moment') + '".');

  // QA notes seed the repro steps.
  const reproSteps = [];
  if (m.notes) reproSteps.push(...firstNonEmptyLines(m.notes, 8));

  // Fallbacks for the cause.
  if (!suspectedCause) {
    if (suspectedComponent) suspectedCause = 'Issue in the ' + suspectedComponent + ' component (no console error was captured).';
    else if (m.notes) suspectedCause = firstLine(m.notes).slice(0, 200);
    else suspectedCause = 'No automatic signal — review the replay and captured data below.';
  }
  if (consoleErrors.length > 0 && suspectedComponent) confidence = 'high';

  // Default repro when the reporter left no notes.
  if (reproSteps.length === 0) {
    if (bug && bug.pageUrl) reproSteps.push('Open ' + bug.pageUrl);
    if (m.credentials && m.credentials.username) reproSteps.push('Sign in as ' + m.credentials.username);
    reproSteps.push('Replay the recording and watch the marked error moment.');
  }

  return {
    suspectedCause,
    confidence,
    evidence,
    reproSteps,
    suspectedComponent,
    suspectedSource,
    errorCount: m.errorCount != null ? m.errorCount : consoleErrors.length,
    signals: {
      consoleErrors: consoleErrors.length,
      errorMarkers: errorMarkers.length,
      pickedElements: picked.length,
      hasNotes: !!m.notes,
      hasReplay: !!(bug && bug.sessionKey),
    },
  };
}

function firstNonEmptyLines(text, cap) {
  return String(text)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, cap);
}
