// ABOUTME: Unit tests for the pure NetEntry helpers — header/body normalization, id, prune, finalize.
// ABOUTME: Pure vitest; no browser, DOM, or Chrome APIs (Node's global Headers/URLSearchParams suffice).
import { describe, it, expect } from 'vitest';
import {
  clamp,
  clampWithFlag,
  byteLength,
  headersToObject,
  headerValue,
  isTextishContentType,
  parseRawHeaders,
  extractRequestBody,
  captureWsFrame,
  newId,
  pruneByAge,
  finalizeEntry,
  REQ_BODY_CAP,
  RES_BODY_CAP,
  WS_FRAME_CAP,
} from './net-entry';
import type { NetEntry } from './protocol';

describe('clamp', () => {
  it('truncates only when over the cap', () => {
    expect(clamp('hello', 10)).toBe('hello');
    expect(clamp('hello', 3)).toBe('hel');
  });
});

describe('headersToObject', () => {
  it('normalizes a Headers instance', () => {
    const h = new Headers({ 'Content-Type': 'application/json', 'X-A': '1' });
    expect(headersToObject(h)).toEqual({ 'content-type': 'application/json', 'x-a': '1' });
  });
  it('normalizes [k,v] pairs and plain objects', () => {
    expect(headersToObject([['A', '1'], ['B', '2']])).toEqual({ A: '1', B: '2' });
    expect(headersToObject({ A: 1, B: true })).toEqual({ A: '1', B: 'true' });
  });
  it('returns {} for null/undefined', () => {
    expect(headersToObject(null)).toEqual({});
    expect(headersToObject(undefined)).toEqual({});
  });
});

describe('parseRawHeaders', () => {
  it('splits a CRLF header blob into a map', () => {
    const raw = 'content-type: text/html\r\ncache-control: no-cache\r\n';
    expect(parseRawHeaders(raw)).toEqual({ 'content-type': 'text/html', 'cache-control': 'no-cache' });
  });
  it('is empty for a blank blob', () => {
    expect(parseRawHeaders('')).toEqual({});
  });
});

describe('clampWithFlag', () => {
  it('reports truncation only when over the cap', () => {
    expect(clampWithFlag('hello', 10)).toEqual({ text: 'hello', truncated: false });
    expect(clampWithFlag('hello', 3)).toEqual({ text: 'hel', truncated: true });
  });
});

describe('byteLength', () => {
  it('counts UTF-8 bytes, not chars', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('€')).toBe(3); // 3-byte code point
  });
});

describe('headerValue', () => {
  it('looks up header names case-insensitively', () => {
    expect(headerValue({ 'Content-Type': 'application/json' }, 'content-type')).toBe('application/json');
    expect(headerValue({ 'content-length': '42' }, 'Content-Length')).toBe('42');
    expect(headerValue({}, 'content-type')).toBeUndefined();
  });
});

describe('isTextishContentType', () => {
  it('treats json/text/xml/form/js/html as text-ish, absent as best-effort text', () => {
    for (const ct of ['application/json', 'text/plain', 'application/xml', 'text/html', 'application/javascript', 'application/x-www-form-urlencoded', undefined]) {
      expect(isTextishContentType(ct)).toBe(true);
    }
  });
  it('treats binary content-types as not text-ish', () => {
    for (const ct of ['image/png', 'application/octet-stream', 'video/mp4', 'font/woff2']) {
      expect(isTextishContentType(ct)).toBe(false);
    }
  });
});

describe('extractRequestBody', () => {
  it('captures string and URLSearchParams bodies as text with byte size', () => {
    expect(extractRequestBody('abc')).toEqual({ text: 'abc', truncated: false, bytes: 3 });
    expect(extractRequestBody(new URLSearchParams({ a: '1', b: '2' }))).toEqual({
      text: 'a=1&b=2',
      truncated: false,
      contentType: 'application/x-www-form-urlencoded',
      bytes: 7,
    });
  });
  it('captures a JSON string POST body verbatim (the common "No body captured" case)', () => {
    const json = JSON.stringify({ email: 'a@b.co', qty: 2 });
    const got = extractRequestBody(json);
    expect(got.text).toBe(json);
    expect(got.truncated).toBe(false);
    expect(got.bytes).toBe(byteLength(json));
  });
  it('flags truncation and reports the original byte size when over the cap', () => {
    const big = 'x'.repeat(REQ_BODY_CAP + 500);
    const got = extractRequestBody(big);
    expect(got.text).toHaveLength(REQ_BODY_CAP);
    expect(got.truncated).toBe(true);
    expect(got.bytes).toBe(REQ_BODY_CAP + 500);
  });
  it('notes FormData by field count without reading values', () => {
    const fd = new FormData();
    fd.append('name', 'ada');
    fd.append('file', new Blob(['xyz']), 'f.txt');
    expect(extractRequestBody(fd)).toEqual({ text: '[FormData: 2 fields]', truncated: false, contentType: 'multipart/form-data' });
  });
  it('notes Blob/ArrayBuffer/typed-array bodies with their byte size', () => {
    expect(extractRequestBody(new Blob(['abcde'], { type: 'application/pdf' }))).toEqual({
      text: '[Blob: 5 bytes, application/pdf]',
      truncated: false,
      contentType: 'application/pdf',
      bytes: 5,
    });
    expect(extractRequestBody(new ArrayBuffer(8))).toEqual({ text: '[ArrayBuffer: 8 bytes]', truncated: false, bytes: 8 });
    expect(extractRequestBody(new Uint8Array([1, 2, 3]))).toEqual({ text: '[Uint8Array: 3 bytes]', truncated: false, bytes: 3 });
  });
  it('returns a null text for absent bodies so "none" stays distinguishable', () => {
    expect(extractRequestBody(null)).toEqual({ text: null, truncated: false });
    expect(extractRequestBody(undefined)).toEqual({ text: null, truncated: false });
  });
});

describe('captureWsFrame', () => {
  it('captures a text send frame with direction, timestamp, and byte size', () => {
    expect(captureWsFrame('send', '{"op":"ping"}', 123)).toEqual({ dir: 'send', data: '{"op":"ping"}', t: 123, bytes: 13 });
  });
  it('captures a text recv frame and flags truncation over the frame cap', () => {
    const big = 'y'.repeat(WS_FRAME_CAP + 10);
    const frame = captureWsFrame('recv', big, 999);
    expect(frame.dir).toBe('recv');
    expect(frame.t).toBe(999);
    expect(frame.data).toHaveLength(WS_FRAME_CAP);
    expect(frame.truncated).toBe(true);
  });
  it('notes binary frames (ArrayBuffer/Blob) as a size, never raw bytes', () => {
    expect(captureWsFrame('recv', new ArrayBuffer(16), 1)).toEqual({ dir: 'recv', data: '[binary 16 bytes]', t: 1, bytes: 16 });
    expect(captureWsFrame('send', new Uint8Array([1, 2, 3, 4]), 2)).toEqual({ dir: 'send', data: '[binary 4 bytes]', t: 2, bytes: 4 });
  });
});

describe('newId', () => {
  it('returns distinct non-empty ids', () => {
    const a = newId();
    const b = newId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });
});

describe('pruneByAge', () => {
  it('drops entries older than the window relative to now', () => {
    const entries = [{ startedAt: 100 }, { startedAt: 500 }, { startedAt: 900 }];
    expect(pruneByAge(entries, 1000, 600)).toEqual([{ startedAt: 500 }, { startedAt: 900 }]); // cutoff 400
  });
  it('keeps a long-lived WebSocket that opened before the window but is still open', () => {
    const entries = [{ startedAt: 100, kind: 'ws' as const, endedAt: 0, frames: [] }];
    expect(pruneByAge(entries, 1000, 600)).toHaveLength(1); // cutoff 400, but still open → kept
  });
  it('keeps a closed WebSocket that carried a frame inside the window', () => {
    const withInWindow = { startedAt: 100, kind: 'ws' as const, endedAt: 300, frames: [{ t: 700 }] };
    const staleClosed = { startedAt: 100, kind: 'ws' as const, endedAt: 300, frames: [{ t: 200 }] };
    expect(pruneByAge([withInWindow, staleClosed], 1000, 600)).toEqual([withInWindow]); // cutoff 400
  });
});

describe('finalizeEntry', () => {
  const base = (): NetEntry => ({
    id: 'x',
    url: 'https://api.test/thing',
    method: 'GET',
    requestHeaders: {},
    requestBody: null,
    status: 0,
    responseHeaders: {},
    responseBody: null,
    startedAt: 1000,
    endedAt: 0,
    durationMs: 0,
    type: 'fetch',
  });

  it('stamps endedAt/durationMs and the response fields, clamping the body', () => {
    const e = finalizeEntry(base(), 1750, {
      status: 200,
      statusText: 'OK',
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: 'x'.repeat(RES_BODY_CAP + 100),
    });
    expect(e.endedAt).toBe(1750);
    expect(e.durationMs).toBe(750);
    expect(e.status).toBe(200);
    expect(e.statusText).toBe('OK');
    expect(e.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(e.responseBody).toHaveLength(RES_BODY_CAP);
    expect(e.responseBodyTruncated).toBe(true);
  });

  it('does not flag truncation for an under-cap response body', () => {
    const e = finalizeEntry(base(), 1200, { responseBody: '{"ok":true}' });
    expect(e.responseBody).toBe('{"ok":true}');
    expect(e.responseBodyTruncated).toBeUndefined();
  });

  it('keeps a null response body as null and never negative duration', () => {
    const e = finalizeEntry(base(), 500, {}); // ended before started (clock skew) → clamp to 0
    expect(e.durationMs).toBe(0);
    expect(e.responseBody).toBeNull();
  });
});
