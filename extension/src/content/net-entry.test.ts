// ABOUTME: Unit tests for the pure NetEntry helpers — header/body normalization, id, prune, finalize.
// ABOUTME: Pure vitest; no browser, DOM, or Chrome APIs (Node's global Headers/URLSearchParams suffice).
import { describe, it, expect } from 'vitest';
import { clamp, headersToObject, parseRawHeaders, requestBodyToString, newId, pruneByAge, finalizeEntry, RES_BODY_CAP } from './net-entry';
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

describe('requestBodyToString', () => {
  it('keeps string and URLSearchParams bodies, capped', () => {
    expect(requestBodyToString('abc')).toBe('abc');
    expect(requestBodyToString(new URLSearchParams({ a: '1', b: '2' }))).toBe('a=1&b=2');
  });
  it('returns null for absent/binary bodies so "none" is distinguishable', () => {
    expect(requestBodyToString(null)).toBeNull();
    expect(requestBodyToString(undefined)).toBeNull();
    expect(requestBodyToString({ any: 'object' })).toBeNull();
    expect(requestBodyToString(new Uint8Array([1, 2, 3]))).toBeNull();
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
  });

  it('keeps a null response body as null and never negative duration', () => {
    const e = finalizeEntry(base(), 500, {}); // ended before started (clock skew) → clamp to 0
    expect(e.durationMs).toBe(0);
    expect(e.responseBody).toBeNull();
  });
});
