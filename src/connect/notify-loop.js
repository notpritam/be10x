// ABOUTME: Connector-side notification delivery: poll the board's Bearer feed since a local per-board
// ABOUTME: watermark, show each as a native OS notification, advance the watermark. Exactly-once, catches up
// ABOUTME: on everything queued while the machine was offline. Injectable fetch/show for tests; never throws.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { showDeviceNotification } from './device-notify.js';

export function notifyStatePath() {
  return join(homedir(), '.be10x', 'notify-state.json');
}
export function loadNotifyState(path = notifyStatePath()) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return { enabled: s.enabled !== false, lastSeq: s.lastSeq || {} };
  } catch {
    return { enabled: true, lastSeq: {} };
  }
}
export function saveNotifyState(state, path = notifyStatePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    /* best-effort — a lost watermark just re-shows at most the last window */
  }
}

// One poll cycle. Mutates `state.lastSeq[board]` to the highest seq seen. Returns { shown, lastSeq }.
export async function runNotifyOnce({ board, token, state, fetchImpl = fetch, show = showDeviceNotification } = {}) {
  if (!state || !state.enabled) return { shown: 0 };
  const base = String(board || '').replace(/\/$/, '');
  const since = (state.lastSeq && state.lastSeq[base]) || 0;
  let notifications = [];
  try {
    const res = await fetchImpl(base + '/api/agent/notifications?since=' + since, { headers: { Authorization: 'Bearer ' + token } });
    if (!res || !res.ok) return { shown: 0 };
    notifications = (await res.json()).notifications || [];
  } catch {
    return { shown: 0 }; // a blip must never break the claim loop
  }
  let maxSeq = since;
  for (const n of notifications) {
    try { show({ title: n.title, body: n.body || '' }); } catch { /* one bad notification shouldn't drop the rest */ }
    if (n.seq > maxSeq) maxSeq = n.seq;
  }
  if (!state.lastSeq) state.lastSeq = {};
  state.lastSeq[base] = maxSeq;
  return { shown: notifications.length, lastSeq: maxSeq };
}
