// ABOUTME: MAIN-world content script — wraps fetch/XHR at document_start into a timestamped NetEntry log,
// ABOUTME: and broadcasts SPA route changes. Must never throw or noticeably slow the page.
import { createRingBuffer } from './ring-buffer';
import { COLLECT_REQ, COLLECT_RES, NAV_EVENT, type NetEntry } from './protocol';
import { clamp, headersToObject, newId, parseRawHeaders, requestBodyToString, finalizeEntry, RES_BODY_CAP } from './net-entry';

// Count-bounded so a long-lived tab can't grow the log without limit; the report filters this down
// to the recording window before upload. Bodies are already capped (req 10KB / resp 50KB).
const CAP = 500;

const buffer = createRingBuffer<NetEntry>(CAP);

function installFetchHook(): void {
  try {
    const orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let rec: NetEntry | null = null;
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        rec = {
          id: newId(),
          url,
          method,
          requestHeaders: headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
          requestBody: requestBodyToString(init?.body),
          status: 0,
          responseHeaders: {},
          responseBody: null,
          startedAt: Date.now(),
          endedAt: 0,
          durationMs: 0,
          type: 'fetch',
        };
        buffer.push(rec); // record the request up front so it survives even if the response read fails
      } catch {
        rec = null;
      }

      const p = orig.call(window, input, init);
      if (!rec) return p;
      const record = rec;
      return p.then(
        (res) => {
          try {
            finalizeEntry(record, Date.now(), {
              status: res.status,
              statusText: res.statusText,
              responseHeaders: headersToObject(res.headers),
            });
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
            finalizeEntry(record, Date.now(), {});
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
          const record: NetEntry = {
            id: newId(),
            url: m.url,
            method: m.method,
            requestHeaders: m.requestHeaders,
            requestBody: requestBodyToString(body),
            status: 0,
            responseHeaders: {},
            responseBody: null,
            startedAt: Date.now(),
            endedAt: 0,
            durationMs: 0,
            type: 'xhr',
          };
          buffer.push(record);
          this.addEventListener('loadend', () => {
            try {
              let responseBody: string | null = null;
              const type = this.responseType;
              if (type === '' || type === 'text') responseBody = this.responseText ?? null;
              else if (type === 'json') responseBody = JSON.stringify(this.response);
              finalizeEntry(record, Date.now(), {
                status: this.status,
                statusText: this.statusText,
                responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
                responseBody,
              });
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

// SPA route changes don't fire a native event — patch history and forward them to the ISOLATED recorder
// (which owns the visits timeline). popstate is native and forwarded the same way for symmetry.
function installNavHook(): void {
  try {
    const emit = () => {
      try {
        window.postMessage({ source: NAV_EVENT, url: location.href, title: document.title }, '*');
      } catch {
        /* ignore */
      }
    };
    const wrap = (name: 'pushState' | 'replaceState') => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (this: History, ...args: unknown[]) {
        const ret = orig.apply(this, args as Parameters<History[typeof name]>);
        emit();
        return ret;
      } as History[typeof name];
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', emit);
  } catch {
    /* leave native history intact */
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
installNavHook();
installCollectResponder();
