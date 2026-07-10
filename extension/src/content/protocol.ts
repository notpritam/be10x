// ABOUTME: Shared wire contract between the MAIN-world net-hook and the ISOLATED-world content scripts.
// ABOUTME: postMessage source tags + NetEntry/Identity shapes; imports are type-only so they erase across worlds.

// window.postMessage `source` tags for the MAIN↔ISOLATED bridge.
export const COLLECT_REQ = 'be10x:collect-req'; // ISOLATED asks the net-hook for the current network log
export const COLLECT_RES = 'be10x:collect-res'; // MAIN answers with NetEntry[]
export const NAV_EVENT = 'be10x:nav'; // MAIN tells ISOLATED about a route change (pushState/replaceState/popstate)

// One captured WebSocket frame on the session clock. `data` is capped (~2KB); binary frames become a
// short "[binary N bytes]" note rather than raw bytes. Rides in a ws-kind NetEntry's `frames`.
export type WsFrame = {
  dir: 'send' | 'recv';
  data: string; // capped ~2KB; a "[binary N bytes]" note for ArrayBuffer/Blob frames
  t: number; // epoch ms
  truncated?: boolean; // the frame text was over the cap and clipped
  bytes?: number; // original byte size when known
};

// One timestamped request/response, synced to the session-replay clock (epoch ms). WebSocket connections
// share this shape with `kind: 'ws'` and their `frames` timeline (method/status/headers stay defaulted).
export type NetEntry = {
  id: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null; // capped to 10KB; a note for binary/streamed bodies; null for absent
  requestBodyTruncated?: boolean; // requestBody was over the cap and clipped
  requestContentType?: string; // request body content-type (from header, else derived from body shape)
  requestBodyBytes?: number; // original request body byte size when known
  status: number; // 0 until the response settles (or on network error); 101 for an open WebSocket
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody: string | null; // capped to 50KB; null for opaque/cross-origin/binary/absent bodies
  responseBodyTruncated?: boolean; // responseBody was over the cap and clipped
  responseContentType?: string; // response body content-type (from header)
  responseBodyBytes?: number; // original response body byte size when known
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms; 0 until the response settles (or the socket closes)
  durationMs: number;
  type?: 'fetch' | 'xhr'; // legacy discriminator; kept for back-compat. Prefer `kind`.
  kind?: 'fetch' | 'xhr' | 'ws'; // canonical transport discriminator; ws entries carry `frames`
  frames?: WsFrame[]; // present when kind === 'ws'
};

// Best-effort React identity for a picked element, read from its fiber. All fields optional — a
// non-React page yields `undefined` for the whole ReactInfo. Never contains DOM nodes or circular refs.
export type ReactInfo = {
  component?: string; // nearest component's displayName/name
  props?: Record<string, unknown>; // shallow, JSON-safe (functions → "[fn]"), capped ~2KB
  source?: string; // fiber._debugSource as "file:line", when present
  chain?: string[]; // a few ancestor component names, nearest first
};

// One element the QA pinpointed with the picker. Rides in meta.pickedElements. The dashboard highlights
// `rect` on the replay and renders `react` as a component/props panel, so this shape is a shared contract.
export type PickedElement = {
  selector: string; // a robust CSS selector
  xpath?: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string; // trimmed + whitespace-collapsed, capped ~200 chars
  rect: { x: number; y: number; w: number; h: number }; // viewport coords at pick time
  react?: ReactInfo;
};

// A route change observed during a recording. Rides in meta.visits.
export type Visit = { t: number; url: string; title: string };

// A user-placed "the bug happens here" pin on the session clock. Rides in meta.markers.
export type Marker = { t: number; label: string };

export type Identity = {
  loggedIn: boolean | null; // null = unknown
  email?: string;
  source?: string; // url the email was read from
  storageKeys?: string[]; // auth-ish localStorage key names, WITHOUT their values
};
