// ABOUTME: MAIN-world content script — wraps fetch/XHR/WebSocket at document_start into a timestamped
// ABOUTME: NetEntry log, and broadcasts SPA route changes. Must never throw or noticeably slow the page.
import { createRingBuffer } from './ring-buffer';
import { COLLECT_REQ, COLLECT_RES, NAV_EVENT, type NetEntry, type ConsoleEntry } from './protocol';
import {
  byteLength,
  captureWsFrame,
  clampWithFlag,
  extractRequestBody,
  finalizeEntry,
  headersToObject,
  headerValue,
  isTextishContentType,
  newId,
  parseRawHeaders,
  serializeConsoleArgs,
  REQ_BODY_CAP,
  RES_BODY_CAP,
  WS_MAX_FRAMES,
} from './net-entry';

// Count-bounded so a long-lived tab can't grow the log without limit; the report filters this down
// to the recording window before upload. Bodies are already capped (req 10KB / resp 50KB).
const CAP = 500;

const buffer = createRingBuffer<NetEntry>(CAP);

// Same bound for console calls; the report trims to the recording window. Text is capped per entry.
const CONSOLE_CAP = 500;
const consoleBuffer = createRingBuffer<ConsoleEntry>(CONSOLE_CAP);

function installFetchHook(): void {
  try {
    const orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let rec: NetEntry | null = null;
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const captured = extractRequestBody(init?.body);
        rec = {
          id: newId(),
          url,
          method,
          requestHeaders,
          requestBody: captured.text,
          ...(captured.truncated ? { requestBodyTruncated: true } : {}),
          requestContentType: headerValue(requestHeaders, 'content-type') ?? captured.contentType,
          requestBodyBytes: captured.bytes,
          status: 0,
          responseHeaders: {},
          responseBody: null,
          startedAt: Date.now(),
          endedAt: 0,
          durationMs: 0,
          type: 'fetch',
          kind: 'fetch',
        };
        buffer.push(rec); // record the request up front so it survives even if the response read fails
        // `fetch(new Request(url, { body }))` carries the body on the Request, not in `init` — read a
        // clone asynchronously (never disturbs the real request) so those POSTs aren't "No body captured".
        if (init?.body == null && input instanceof Request && input.body) {
          const record = rec;
          input
            .clone()
            .text()
            .then((t) => {
              try {
                const { text, truncated } = clampWithFlag(t, REQ_BODY_CAP);
                record.requestBody = text;
                if (truncated) record.requestBodyTruncated = true;
                record.requestBodyBytes = byteLength(t);
              } catch {
                /* ignore */
              }
            }, () => {});
        }
      } catch {
        rec = null;
      }

      const p = orig.call(window, input, init);
      if (!rec) return p;
      const record = rec;
      return p.then(
        (res) => {
          try {
            const responseHeaders = headersToObject(res.headers);
            finalizeEntry(record, Date.now(), {
              status: res.status,
              statusText: res.statusText,
              responseHeaders,
            });
            const ct = headerValue(responseHeaders, 'content-type');
            record.responseContentType = ct;
            if (res.type !== 'opaque' && res.type !== 'opaqueredirect') {
              if (isTextishContentType(ct)) {
                // Fire-and-forget body read on a clone so the page's own consumption is untouched.
                res
                  .clone()
                  .text()
                  .then(
                    (t) => {
                      try {
                        const { text, truncated } = clampWithFlag(t, RES_BODY_CAP);
                        record.responseBody = text;
                        if (truncated) record.responseBodyTruncated = true;
                        record.responseBodyBytes = byteLength(t);
                      } catch {
                        /* ignore */
                      }
                    },
                    () => {},
                  );
              } else {
                // Binary/non-text response — don't capture garbage text; record its size from content-length.
                const len = Number(headerValue(responseHeaders, 'content-length'));
                if (Number.isFinite(len) && len >= 0) record.responseBodyBytes = len;
              }
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
          const captured = extractRequestBody(body);
          const record: NetEntry = {
            id: newId(),
            url: m.url,
            method: m.method,
            requestHeaders: m.requestHeaders,
            requestBody: captured.text,
            ...(captured.truncated ? { requestBodyTruncated: true } : {}),
            requestContentType: headerValue(m.requestHeaders, 'content-type') ?? captured.contentType,
            requestBodyBytes: captured.bytes,
            status: 0,
            responseHeaders: {},
            responseBody: null,
            startedAt: Date.now(),
            endedAt: 0,
            durationMs: 0,
            type: 'xhr',
            kind: 'xhr',
          };
          buffer.push(record);
          this.addEventListener('loadend', () => {
            try {
              const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
              record.responseContentType = headerValue(responseHeaders, 'content-type');
              let responseBody: string | null = null;
              const type = this.responseType;
              if (type === '' || type === 'text') {
                responseBody = this.responseText ?? null;
                if (responseBody != null) record.responseBodyBytes = byteLength(responseBody);
              } else if (type === 'json') {
                try {
                  responseBody = JSON.stringify(this.response);
                  if (responseBody != null) record.responseBodyBytes = byteLength(responseBody);
                } catch {
                  responseBody = null;
                }
              } else if (type === 'arraybuffer' && this.response) {
                const buf = this.response as ArrayBuffer;
                responseBody = `[binary ${buf.byteLength} bytes]`; // don't stringify binary
                record.responseBodyBytes = buf.byteLength;
              } else if (type === 'blob' && this.response) {
                const b = this.response as Blob;
                responseBody = `[binary ${b.size} bytes]`;
                record.responseBodyBytes = b.size;
              }
              finalizeEntry(record, Date.now(), {
                status: this.status,
                statusText: this.statusText,
                responseHeaders,
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

// Append a frame to a ws entry's timeline, keeping only the most recent WS_MAX_FRAMES to bound memory.
function pushWsFrame(entry: NetEntry, dir: 'send' | 'recv', data: unknown): void {
  try {
    const frame = captureWsFrame(dir, data, Date.now());
    if (!entry.frames) entry.frames = [];
    entry.frames.push(frame);
    if (entry.frames.length > WS_MAX_FRAMES) entry.frames.splice(0, entry.frames.length - WS_MAX_FRAMES);
  } catch {
    /* ignore */
  }
}

// Wrap window.WebSocket so each connection and its send/recv frames land in the same NetEntry log as a
// `kind: 'ws'` record. A Proxy on the constructor preserves instanceof + the static readyState constants;
// send is wrapped once on the prototype; recv/open/close ride non-intrusive addEventListener so the page's
// own handlers are untouched. Every step is defensive — a failure never breaks the socket.
function installWebSocketHook(): void {
  try {
    const OrigWS = window.WebSocket;
    if (typeof OrigWS !== 'function') return;
    const entryFor = new WeakMap<WebSocket, NetEntry>();

    try {
      const origSend = OrigWS.prototype.send;
      if (typeof origSend === 'function') {
        OrigWS.prototype.send = function (this: WebSocket, ...args: unknown[]): void {
          try {
            const entry = entryFor.get(this);
            if (entry) pushWsFrame(entry, 'send', args[0]);
          } catch {
            /* ignore */
          }
          return (origSend as (...a: unknown[]) => void).apply(this, args);
        } as typeof OrigWS.prototype.send;
      }
    } catch {
      /* leave native send intact */
    }

    const instrument = (ws: WebSocket, url: string) => {
      try {
        const entry: NetEntry = {
          id: newId(),
          url,
          method: 'GET', // a WebSocket opens as an HTTP GET Upgrade (101 Switching Protocols on success)
          requestHeaders: {},
          requestBody: null,
          status: 0,
          responseHeaders: {},
          responseBody: null,
          startedAt: Date.now(),
          endedAt: 0,
          durationMs: 0,
          kind: 'ws',
          frames: [],
        };
        entryFor.set(ws, entry);
        buffer.push(entry);
        ws.addEventListener('open', () => {
          entry.status = 101;
          entry.statusText = 'Switching Protocols';
        });
        ws.addEventListener('message', (e: MessageEvent) => pushWsFrame(entry, 'recv', e.data));
        const close = (code?: number, reason?: string) => {
          entry.endedAt = Date.now();
          entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
          if (typeof code === 'number') entry.statusText = `closed ${code}${reason ? ' ' + reason : ''}`;
        };
        ws.addEventListener('close', (e: CloseEvent) => close(e.code, e.reason));
        ws.addEventListener('error', () => close());
      } catch {
        /* ignore — never break the socket */
      }
    };

    const WSProxy = new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget) as WebSocket;
        try {
          const raw = args && args.length ? args[0] : '';
          const url = typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : String(raw ?? '');
          instrument(ws, url);
        } catch {
          /* ignore */
        }
        return ws;
      },
    });
    window.WebSocket = WSProxy as unknown as typeof WebSocket;
  } catch {
    /* leave native WebSocket intact */
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

// Mirror the page's console into a timestamped buffer so the dashboard can lay it over the replay clock.
// The original method is always called (devtools output is untouched); a reentrancy guard means a console
// call made while we serialize can't recurse. Levels beyond these (trace/table/…) are intentionally left
// unhooked — the five below are what a QA session needs.
function installConsoleHook(): void {
  try {
    const levels: ConsoleEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
    let inHook = false;
    for (const level of levels) {
      const orig = (console as unknown as Record<string, unknown>)[level];
      if (typeof orig !== 'function') continue;
      const original = orig as (...a: unknown[]) => unknown;
      (console as unknown as Record<string, unknown>)[level] = function (this: unknown, ...args: unknown[]): unknown {
        if (!inHook) {
          inHook = true;
          try {
            const { text, truncated } = serializeConsoleArgs(args);
            consoleBuffer.push({ ts: Date.now(), level, text, ...(truncated ? { truncated: true } : {}) });
          } catch {
            /* never let capture break the page's logging */
          } finally {
            inHook = false;
          }
        }
        return original.apply(this, args);
      };
    }
  } catch {
    /* leave console intact */
  }
}

// Answer the collector's round-trip: correlate on the source tag + nonce, reply with the current log.
function installCollectResponder(): void {
  try {
    window.addEventListener('message', (e: MessageEvent) => {
      try {
        const d = e.data as { source?: string; nonce?: unknown } | null;
        if (!d || d.source !== COLLECT_REQ || typeof d.nonce === 'undefined') return;
        window.postMessage({ source: COLLECT_RES, nonce: d.nonce, network: buffer.toArray(), console: consoleBuffer.toArray() }, '*');
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
installWebSocketHook();
installConsoleHook();
installNavHook();
installCollectResponder();
