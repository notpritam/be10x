// ABOUTME: Pure, dependency-free helpers for building NetEntry records from fetch/XHR/WebSocket data.
// ABOUTME: Extracted from the MAIN-world net-hook so header/body/frame/id/prune logic is unit-testable.
import type { NetEntry, WsFrame } from './protocol';

export const REQ_BODY_CAP = 10 * 1024;
export const RES_BODY_CAP = 50 * 1024;
export const WS_FRAME_CAP = 2 * 1024; // per-frame text cap for WebSocket messages
export const WS_MAX_FRAMES = 200; // per-connection frame ring — keep the most recent to bound memory

export function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// clamp + report whether it clipped, so callers can set a `*Truncated` flag without re-measuring.
export function clampWithFlag(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

// UTF-8 byte size of a string (falls back to char count if TextEncoder is unavailable).
export function byteLength(s: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  } catch {
    /* fall through */
  }
  return s.length;
}

// Case-insensitive header lookup (header maps mix `Content-Type` and `content-type` across sources).
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

// Whether a content-type is text-ish enough to capture as text. Unknown (absent) → attempt (best-effort),
// so responses that omit content-type are still captured; explicit binary types (image/*, octet-stream…)
// are skipped so we never record garbage text.
export function isTextishContentType(ct: string | undefined): boolean {
  if (!ct) return true;
  return /(^text\/)|json|xml|javascript|ecmascript|x-www-form-urlencoded|csv|html|ndjson/i.test(ct);
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

// A request body reduced to something safe to store: text for string/URLSearchParams (capped), or a short
// note for binary/streamed bodies (never the raw bytes). `bytes`/`contentType` describe the original.
export type CapturedBody = {
  text: string | null; // captured text, a "[…]" note for binary, or null when absent
  truncated: boolean; // text was over REQ_BODY_CAP and clipped
  contentType?: string; // derived from the body's own shape (Blob.type, form-urlencoded, multipart)
  bytes?: number; // original byte size when known
};

// Extract a request body across every fetch/XHR body type. string & URLSearchParams (incl. JSON/text
// sent as a string) are captured as text and capped; FormData → a field-count note; Blob/ArrayBuffer/
// typed-array/DataView → a byte-size note; streams → a placeholder. Absent → null. Never throws.
export function extractRequestBody(body: unknown): CapturedBody {
  try {
    if (body == null) return { text: null, truncated: false };
    if (typeof body === 'string') {
      const { text, truncated } = clampWithFlag(body, REQ_BODY_CAP);
      return { text, truncated, bytes: byteLength(body) };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const s = body.toString();
      const { text, truncated } = clampWithFlag(s, REQ_BODY_CAP);
      return { text, truncated, contentType: 'application/x-www-form-urlencoded', bytes: byteLength(s) };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      let fields = 0;
      try {
        body.forEach(() => {
          fields++;
        }); // count keys only — never read values (files/PII)
      } catch {
        /* ignore */
      }
      return { text: `[FormData: ${fields} field${fields === 1 ? '' : 's'}]`, truncated: false, contentType: 'multipart/form-data' };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return { text: `[Blob: ${body.size} bytes${body.type ? ', ' + body.type : ''}]`, truncated: false, contentType: body.type || undefined, bytes: body.size };
    }
    if (body instanceof ArrayBuffer) {
      return { text: `[ArrayBuffer: ${body.byteLength} bytes]`, truncated: false, bytes: body.byteLength };
    }
    if (ArrayBuffer.isView(body)) {
      const view = body as ArrayBufferView;
      const name = (view as { constructor?: { name?: string } }).constructor?.name || 'ArrayBufferView';
      return { text: `[${name}: ${view.byteLength} bytes]`, truncated: false, bytes: view.byteLength };
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return { text: '[ReadableStream]', truncated: false };
    }
    return { text: null, truncated: false };
  } catch {
    return { text: null, truncated: false };
  }
}

// Reduce one WebSocket frame's payload to a capped, storable WsFrame. Text is clipped to WS_FRAME_CAP;
// binary (ArrayBuffer/typed-array/DataView/Blob) becomes a size note. Never throws.
export function captureWsFrame(dir: 'send' | 'recv', data: unknown, t: number): WsFrame {
  try {
    if (typeof data === 'string') {
      const { text, truncated } = clampWithFlag(data, WS_FRAME_CAP);
      return { dir, data: text, t, ...(truncated ? { truncated: true } : {}), bytes: byteLength(data) };
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return { dir, data: `[binary ${data.size} bytes]`, t, bytes: data.size };
    }
    if (data instanceof ArrayBuffer) {
      return { dir, data: `[binary ${data.byteLength} bytes]`, t, bytes: data.byteLength };
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      return { dir, data: `[binary ${view.byteLength} bytes]`, t, bytes: view.byteLength };
    }
    const s = String(data);
    const { text, truncated } = clampWithFlag(s, WS_FRAME_CAP);
    return { dir, data: text, t, ...(truncated ? { truncated: true } : {}) };
  } catch {
    return { dir, data: '[unserializable]', t };
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
// Used to align the network log with the recording window at report time. A long-lived WebSocket that
// opened before the window is kept when it stayed open into it, or carried any frame inside it — so its
// in-window frames aren't lost just because the connection began earlier.
export function pruneByAge<T extends { startedAt: number; endedAt?: number; kind?: string; frames?: { t: number }[] }>(
  entries: T[],
  now: number,
  maxAgeMs: number,
): T[] {
  const cutoff = now - maxAgeMs;
  return entries.filter((e) => {
    if (e.startedAt >= cutoff) return true;
    if (e.kind === 'ws' && (!e.endedAt || (Array.isArray(e.frames) && e.frames.some((f) => f.t >= cutoff)))) return true;
    return false;
  });
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
  if (fields.responseBody !== undefined) {
    if (fields.responseBody === null) entry.responseBody = null;
    else {
      const { text, truncated } = clampWithFlag(fields.responseBody, RES_BODY_CAP);
      entry.responseBody = text;
      if (truncated) entry.responseBodyTruncated = true;
    }
  }
  return entry;
}
