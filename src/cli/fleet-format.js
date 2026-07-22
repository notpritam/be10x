// ABOUTME: Pure rendering for `be10x ps` — a compact aligned fleet table + relative-age formatting. No I/O.

// Compact relative age from a millisecond duration: 5s / 3m / 2h / 4d, or '-' when unknown.
export function relAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// A claude session id is a full uuid; show the leading 8 chars so the column stays scannable but is still
// enough to grep the full id from the board or `claude --resume`. '-' until the stream yields one.
export function shortSession(sessionId) {
  return sessionId ? String(sessionId).slice(0, 8) : '-';
}

// Render fleet rows (from assembleFleetStatus) as an aligned table. A stalled row shows state 'stalled'.
export function formatFleetTable(rows) {
  if (!rows || rows.length === 0) return 'no active sessions.';
  const header = ['TASK', 'PHASE', 'STATE', 'AGE', 'SESSION', 'HOST', 'ASSIGNEE', 'PROJECT'];
  const body = rows.map((r) => [
    r.humanId || '-',
    r.phase || '-',
    r.stalled ? 'stalled' : (r.state || '-'),
    relAge(r.ageMs),
    shortSession(r.sessionId),
    r.host || '-',
    r.assignee ? (r.assignee.displayName || r.assignee.email || '-') : '-',
    r.project ? (r.project.key || r.project.name || '-') : '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
  const line = (cols) => cols.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}
