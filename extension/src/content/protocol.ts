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
  ts?: number; // epoch ms the QA picked it — lets the dashboard seek the replay to this moment
  note?: string; // the reporter's own words on WHY this element matters, capped ~500 chars
};

// One freehand annotation the QA drew over the page while recording. Points are normalized to the viewport
// (0..1 of innerWidth/innerHeight at draw time) so the dashboard can scale them onto the replay stage at any
// zoom. `ts`/`tEnd` are epoch ms, so a stroke surfaces on the replay at the moment it was drawn. Rides in
// meta.drawings. The drawing canvas lives in the widget's blocked Shadow DOM, so rrweb never bakes it in.
export type DrawStroke = {
  ts: number; // epoch ms the stroke began
  tEnd: number; // epoch ms the stroke ended
  color: string; // hex from the widget's fixed palette
  width: number; // pen width in CSS px at draw time
  points: { x: number; y: number }[]; // viewport-normalized 0..1
};

// The login the reporter was actually using while they hit the bug — entered by hand in the report form so a
// developer can reproduce with the same account. Rides in meta.credentials. NOTE: stored and surfaced raw
// (the product exposes full captures on public share links by design) — this is for test accounts.
export type TestCredentials = {
  username?: string; // the email / username they signed in with
  password?: string; // the test password (surfaced masked-by-default on the dashboard)
  notes?: string; // anything else needed to reproduce — role, tenant, 2FA seed, etc.
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

// One captured console call on the session clock (epoch ms). Rides in meta.console; the dashboard renders
// it in the time-synced activity rail beside the replay. `text` is the serialized args, capped ~8KB.
export type ConsoleEntry = {
  ts: number; // epoch ms
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  truncated?: boolean; // the serialized text was over the cap and clipped
};

// The reporter's device + browser + page-load environment, read from the ISOLATED world at report time.
// Every field is best-effort/optional (older browsers, privacy modes). Rides in meta.environment; the
// dashboard renders it as an "Environment" card and parses `userAgent`/`brands` into a browser+OS line.
export type BugEnvironment = {
  userAgent?: string;
  platform?: string; // navigator.userAgentData.platform ?? navigator.platform
  brands?: string[]; // "Chromium 152", … from userAgentData (Chromium only)
  mobile?: boolean; // userAgentData.mobile
  language?: string;
  languages?: string[]; // capped to a few
  timezone?: string; // IANA zone from Intl
  online?: boolean;
  cores?: number; // navigator.hardwareConcurrency
  memoryGb?: number; // navigator.deviceMemory (coarse)
  screen?: { w: number; h: number; dpr: number; colorDepth?: number };
  connection?: { effectiveType?: string; downlinkMbps?: number; rttMs?: number; saveData?: boolean };
  performance?: { ttfbMs?: number; domInteractiveMs?: number; domContentLoadedMs?: number; loadMs?: number; fcpMs?: number };
  capturedAt?: number; // epoch ms
};
