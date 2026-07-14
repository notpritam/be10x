// ABOUTME: A tiny structured single-line logger for the connector. Each record is one greppable line —
// ABOUTME: `<ISO> <LEVEL> <event> <k=v ...>` — written to stdout, which the LaunchAgent tees to ~/.be10x/connect.log.
//
// Deliberately dependency-free and injectable (`now`/`out`) so the connect loop can emit a per-poll heartbeat
// and per-task lifecycle lines that stay one line each, and so tests can capture the exact bytes + pin the clock.

// Render a single field value. Simple strings pass through raw for grep-ability; anything with whitespace,
// quotes, or `=` (and every non-string) is JSON-encoded so the k=v boundary stays unambiguous on one line.
function renderValue(v) {
  if (typeof v === 'string') {
    return v === '' || /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return JSON.stringify(v);
}

// makeLogger({ now, out }) → { info(event, fields), warn(...), error(...) }. Writes exactly one newline-
// terminated line per call: ISO timestamp, uppercased level, the event name, then space-joined k=v fields
// (undefined fields skipped, so optional ids like a runId never litter the line).
export function makeLogger({ now = () => new Date(), out = process.stdout } = {}) {
  const emit = (level, event, fields = {}) => {
    const parts = [now().toISOString(), level.toUpperCase(), String(event)];
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined) continue;
      parts.push(k + '=' + renderValue(v));
    }
    out.write(parts.join(' ') + '\n');
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
