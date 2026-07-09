// ABOUTME: Pure, dependency-free helpers for building NetEntry records from fetch/XHR data.
// ABOUTME: Extracted from the MAIN-world net-hook so header/body/id/prune logic is unit-testable.
import type { NetEntry } from './protocol';

export const REQ_BODY_CAP = 10 * 1024;
export const RES_BODY_CAP = 50 * 1024;

export function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Normalize any header representation (Headers instance, [k,v][] pairs, plain object) to a string map.
export function headersToObject(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((v, k) => {
        out[k] = v;
      });
    } else if (Array.isArray(h)) {
      for (const pair of h as [string, string][]) if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
    } else if (typeof h === 'object') {
      const rec = h as Record<string, unknown>;
      for (const k of Object.keys(rec)) out[k] = String(rec[k]);
    }
  } catch {
    /* best-effort — return whatever we gathered */
  }
  return out;
}

// XHR exposes response headers as one CRLF-delimited blob; split it back into a map.
export function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of (raw || '').trim().split(/[\r\n]+/)) {
      const idx = line.indexOf(':');
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  } catch {
    /* ignore malformed header blob */
  }
  return out;
}

// Only string-ish request bodies are recorded; binary (Blob/FormData/ArrayBuffer) or absent → null,
// so the contract can distinguish "no body" from "empty string body".
export function requestBodyToString(body: unknown): string | null {
  try {
    if (body == null) return null;
    if (typeof body === 'string') return clamp(body, REQ_BODY_CAP);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return clamp(body.toString(), REQ_BODY_CAP);
    return null;
  } catch {
    return null;
  }
}

// Stable-ish unique id for correlating a request with its response row in the dashboard.
export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Drop entries whose start is older than `maxAgeMs` before `now`. Pure; returns a new array.
// Used to align the network log with the recording window at report time.
export function pruneByAge<T extends { startedAt: number }>(entries: T[], now: number, maxAgeMs: number): T[] {
  const cutoff = now - maxAgeMs;
  return entries.filter((e) => e.startedAt >= cutoff);
}

// Stamp the response side of an entry once it settles. Mutates in place (the live buffer row) and
// returns it. `endedAt`/`durationMs` come from the same clock as `startedAt`.
export function finalizeEntry(
  entry: NetEntry,
  now: number,
  fields: { status?: number; statusText?: string; responseHeaders?: Record<string, string>; responseBody?: string | null },
): NetEntry {
  entry.endedAt = now;
  entry.durationMs = Math.max(0, now - entry.startedAt);
  if (fields.status !== undefined) entry.status = fields.status;
  if (fields.statusText !== undefined) entry.statusText = fields.statusText;
  if (fields.responseHeaders !== undefined) entry.responseHeaders = fields.responseHeaders;
  if (fields.responseBody !== undefined) entry.responseBody = fields.responseBody === null ? null : clamp(fields.responseBody, RES_BODY_CAP);
  return entry;
}
