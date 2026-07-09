// ABOUTME: MAIN-world content script — wraps fetch/XHR at document_start into a capped in-page request log.
// ABOUTME: Must never throw or noticeably slow the page; answers the collector's postMessage round-trip.
import { createRingBuffer } from './ring-buffer';
import { COLLECT_REQ, COLLECT_RES, type NetRecord } from './protocol';

const CAP = 50;
const REQ_BODY_CAP = 10 * 1024;
const RES_BODY_CAP = 50 * 1024;

const buffer = createRingBuffer<NetRecord>(CAP);

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function headersToObject(h: unknown): Record<string, string> {
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

// Only string-ish request bodies are recorded; binary (Blob/FormData/ArrayBuffer) is skipped.
function bodyToString(body: unknown): string {
  try {
    if (body == null) return '';
    if (typeof body === 'string') return clamp(body, REQ_BODY_CAP);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return clamp(body.toString(), REQ_BODY_CAP);
    return '';
  } catch {
    return '';
  }
}

function parseRawHeaders(raw: string): Record<string, string> {
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

function installFetchHook(): void {
  try {
    const orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let rec: NetRecord | null = null;
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        rec = {
          url,
          method,
          requestHeaders: headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
          requestBody: bodyToString(init?.body),
          status: 0,
          responseHeaders: {},
          responseBody: '',
          startedAt: Date.now(),
          durationMs: 0,
        };
        buffer.push(rec); // record the request up front so it survives even if the response read fails
      } catch {
        rec = null;
      }

      const p = orig.call(window, input, init);
      if (!rec) return p;
      const started = rec.startedAt;
      const record = rec;
      return p.then(
        (res) => {
          try {
            record.status = res.status;
            record.durationMs = Date.now() - started;
            record.responseHeaders = headersToObject(res.headers);
            if (res.type !== 'opaque' && res.type !== 'opaqueredirect') {
              // Fire-and-forget body read on a clone so the page's own consumption is untouched.
              res
                .clone()
                .text()
                .then(
                  (t) => {
                    try {
                      record.responseBody = clamp(t, RES_BODY_CAP);
                    } catch {
                      /* ignore */
                    }
                  },
                  () => {},
                );
            }
          } catch {
            /* ignore — never disturb the page's response */
          }
          return res;
        },
        (err) => {
          try {
            record.durationMs = Date.now() - started;
          } catch {
            /* ignore */
          }
          throw err;
        },
      );
    } as typeof fetch;
  } catch {
    /* leave native fetch intact */
  }
}

type XhrMeta = { url: string; method: string; requestHeaders: Record<string, string> };

function installXhrHook(): void {
  try {
    const X = window.XMLHttpRequest;
    if (typeof X !== 'function') return;
    const origOpen = X.prototype.open;
    const origSend = X.prototype.send;
    const origSetHeader = X.prototype.setRequestHeader;

    X.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL): void {
      try {
        (this as unknown as { __be10x?: XhrMeta }).__be10x = {
          url: String(url),
          method: String(method || 'GET').toUpperCase(),
          requestHeaders: {},
        };
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line prefer-rest-params
      return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
    };

    X.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      try {
        const m = (this as unknown as { __be10x?: XhrMeta }).__be10x;
        if (m) m.requestHeaders[name] = value;
      } catch {
        /* ignore */
      }
      return origSetHeader.call(this, name, value);
    };

    X.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      try {
        const m = (this as unknown as { __be10x?: XhrMeta }).__be10x;
        if (m) {
          const record: NetRecord = {
            url: m.url,
            method: m.method,
            requestHeaders: m.requestHeaders,
            requestBody: bodyToString(body),
            status: 0,
            responseHeaders: {},
            responseBody: '',
            startedAt: Date.now(),
            durationMs: 0,
          };
          buffer.push(record);
          const started = record.startedAt;
          this.addEventListener('loadend', () => {
            try {
              record.status = this.status;
              record.durationMs = Date.now() - started;
              record.responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
              const type = this.responseType;
              if (type === '' || type === 'text') {
                record.responseBody = clamp(this.responseText ?? '', RES_BODY_CAP);
              } else if (type === 'json') {
                record.responseBody = clamp(JSON.stringify(this.response), RES_BODY_CAP);
              }
            } catch {
              /* ignore — responseText can throw for some response types */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return origSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    };
  } catch {
    /* leave native XHR intact */
  }
}

// Answer the collector's round-trip: correlate on the source tag + nonce, reply with the current log.
function installCollectResponder(): void {
  try {
    window.addEventListener('message', (e: MessageEvent) => {
      try {
        const d = e.data as { source?: string; nonce?: unknown } | null;
        if (!d || d.source !== COLLECT_REQ || typeof d.nonce === 'undefined') return;
        window.postMessage({ source: COLLECT_RES, nonce: d.nonce, network: buffer.toArray() }, '*');
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

installFetchHook();
installXhrHook();
installCollectResponder();
