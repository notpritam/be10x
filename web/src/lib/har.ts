// ABOUTME: Build a HAR 1.2 log from a bug's captured NetEntry timeline, so a developer can import the exact
// ABOUTME: network activity into Chrome DevTools / Charles / Proxyman. Pure, dependency-free, browser-side.
import type { NetEntry } from "./types";

type HarNv = { name: string; value: string };

function headersArray(h?: Record<string, string>): HarNv[] {
  return Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function headerValue(h: Record<string, string> | undefined, name: string): string {
  if (!h) return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v;
  return "";
}

function queryString(url: string): HarNv[] {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function iso(ms: number): string {
  const n = Number.isFinite(ms) ? ms : 0;
  return new Date(n).toISOString();
}

function harEntry(e: NetEntry, pageRef: string | undefined) {
  const reqContentType = headerValue(e.requestHeaders, "content-type");
  const resContentType = headerValue(e.responseHeaders, "content-type");
  const responseText = e.responseBody ?? "";
  return {
    ...(pageRef ? { pageref: pageRef } : {}),
    startedDateTime: iso(e.startedAt),
    time: Math.max(0, e.durationMs || 0),
    request: {
      method: e.method || "GET",
      url: e.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: headersArray(e.requestHeaders),
      queryString: queryString(e.url),
      ...(e.requestBody != null
        ? { postData: { mimeType: reqContentType || "application/octet-stream", text: e.requestBody } }
        : {}),
      headersSize: -1,
      bodySize: e.requestBody != null ? e.requestBody.length : 0,
    },
    response: {
      status: e.status || 0,
      statusText: e.statusText || "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: headersArray(e.responseHeaders),
      content: {
        size: responseText.length,
        mimeType: resContentType || "x-unknown",
        text: responseText,
      },
      redirectURL: headerValue(e.responseHeaders, "location"),
      headersSize: -1,
      bodySize: responseText.length,
    },
    cache: {},
    timings: { send: 0, wait: Math.max(0, e.durationMs || 0), receive: 0 },
    ...(e.responseBodyTruncated || e.requestBodyTruncated
      ? { comment: "be10x: body truncated at capture" }
      : {}),
  };
}

/** Build a HAR 1.2 object from the timeline. WebSocket entries (kind: "ws") are omitted — HAR models
 *  request/response, not socket frames; those still live in the raw network.json. */
export function buildHar(entries: NetEntry[], opts: { pageUrl?: string } = {}): unknown {
  const http = entries.filter((e) => e.kind !== "ws");
  const firstStart = http.reduce((min, e) => (e.startedAt && e.startedAt < min ? e.startedAt : min), http[0]?.startedAt ?? 0);
  const pageId = "page_1";
  return {
    log: {
      version: "1.2",
      creator: { name: "be10x", version: "1.0" },
      pages: opts.pageUrl
        ? [{ startedDateTime: iso(firstStart), id: pageId, title: opts.pageUrl, pageTimings: { onContentLoad: -1, onLoad: -1 } }]
        : [],
      entries: http.map((e) => harEntry(e, opts.pageUrl ? pageId : undefined)),
    },
  };
}

/** Trigger a client-side download of any text as a file (Blob + object URL). */
export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build a HAR from the entries and download it as `<name>.har`. */
export function downloadHar(entries: NetEntry[], name: string, pageUrl?: string): void {
  const safe = name.replace(/[^a-z0-9._-]+/gi, "-") || "network";
  downloadText(`${safe}.har`, JSON.stringify(buildHar(entries, { pageUrl }), null, 2));
}
