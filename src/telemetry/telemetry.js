// ABOUTME: Opt-in CLI telemetry — local consent state, a durable local queue, and a best-effort
// ABOUTME: flush to the central endpoint. Silent by design: a failure here never surfaces to the user.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

// The central collection point every be10x install reports to, regardless of which board it
// talks to for tasks (see docs/superpowers/specs/2026-07-03-cli-telemetry-consent-design.md) —
// deliberately hardcoded and visible in source, since a "phone home" endpoint in an open-source
// CLI should never be a secret. Override only for local development/testing.
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://be10x.notpritam.in/api/telemetry';

// Bounds on both ends of the pipe: a single huge plan can't grow the local queue file without
// limit, and a single flush can't send an unbounded batch.
export const MAX_CONTENT_CHARS = 20000;
export const MAX_EVENTS_PER_BATCH = 200;

export function telemetryConfigPath(home = homedir()) {
  return join(home, '.be10x', 'telemetry.json');
}

export function queuePath(home = homedir()) {
  return join(home, '.be10x', 'telemetry-queue.ndjson');
}

export function loadTelemetryConfig(path = telemetryConfigPath()) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function saveTelemetryConfig(cfg, path = telemetryConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return path;
}

// Records the user's decision once and for all — called after the first-run prompt, or directly
// by `be10x telemetry on|off`. installId is generated on first write and then kept stable across
// later toggles: it identifies the machine, not the decision.
export function setTelemetryEnabled(enabled, path = telemetryConfigPath()) {
  const existing = loadTelemetryConfig(path);
  const cfg = { installId: existing?.installId || randomUUID(), enabled, decidedAt: Date.now() };
  saveTelemetryConfig(cfg, path);
  return cfg;
}

// The effective state for THIS invocation. An explicit GFA_TELEMETRY env var always wins and is
// NEVER persisted — a CI job setting GFA_TELEMETRY=0 shouldn't silently overwrite a human's own
// stored choice. Otherwise falls back to the stored decision. Returns undefined when there's
// neither an override nor a stored decision — the caller's cue to prompt (if interactive) or
// treat as off (if not), without writing anything.
export function effectiveEnabled(env = process.env, cfg = loadTelemetryConfig()) {
  const override = env.GFA_TELEMETRY;
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;
  return cfg ? cfg.enabled : undefined;
}

// A task's `content`/`plan` field can be a string (HTML/markdown) OR an object ({ steps, diagram
// } etc.) — cap both shapes. Small objects pass through untouched (keeps their structure); an
// oversized one is replaced with a bounded JSON preview rather than left to grow the queue
// unbounded. Primitives (number/boolean/null) are always small — left as-is.
function truncate(value) {
  if (typeof value === 'string') {
    return value.length > MAX_CONTENT_CHARS ? value.slice(0, MAX_CONTENT_CHARS) + '…[truncated]' : value;
  }
  if (value !== null && typeof value === 'object') {
    const str = JSON.stringify(value);
    return str && str.length > MAX_CONTENT_CHARS ? { truncated: true, preview: str.slice(0, MAX_CONTENT_CHARS) } : value;
  }
  return value;
}

// Append one event to the local queue. A no-op unless enabled is explicitly true, so call sites
// never need their own if-enabled guard.
export function recordEvent(event, fields = {}, { enabled, path = queuePath() } = {}) {
  if (!enabled) return;
  const line = JSON.stringify({
    event,
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, truncate(v)])),
    occurredAt: Date.now(),
  });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + '\n');
}

function readQueue(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Best-effort flush: sends up to MAX_EVENTS_PER_BATCH queued events and clears only those from
// the queue file — anything past the cap, or appended after we read, stays queued for next time.
// NEVER throws: a network error, timeout, or non-2xx just leaves the queue untouched so nothing
// is lost, and the caller never needs to wrap this in its own try/catch.
export async function flushQueue({
  endpoint = process.env.GFA_TELEMETRY_ENDPOINT || DEFAULT_TELEMETRY_ENDPOINT,
  installId,
  cliVersion,
  path = queuePath(),
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  if (!installId) return { sent: 0 };
  const all = readQueue(path);
  if (!all.length) return { sent: 0 };
  const batch = all.slice(0, MAX_EVENTS_PER_BATCH);
  const rest = all.slice(MAX_EVENTS_PER_BATCH);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, cliVersion, os: process.platform, nodeVersion: process.version, events: batch }),
      signal: controller.signal,
    });
    if (!res.ok) return { sent: 0 };
    writeFileSync(path, rest.length ? rest.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    return { sent: batch.length };
  } catch {
    return { sent: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// The one-time first-run prompt. `ask` and `isTTY` are injected (mirrors runDeviceLogin's
// injected open/sleep/log) so this is unit-testable without a real terminal. Returns true/false,
// or null when skipped (non-interactive) — the caller should treat null as "stay undecided,
// effectively off" rather than persisting a choice nobody actually made.
export async function promptForConsent({ ask, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (!isTTY) return null;
  const answer = await ask('Send task activity (including task/plan content) to help improve be10x? [y/N] ');
  return /^y(es)?$/i.test(String(answer || '').trim());
}
