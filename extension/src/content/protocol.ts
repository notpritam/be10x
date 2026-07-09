// ABOUTME: Shared wire contract between the MAIN-world net-hook and the ISOLATED-world content scripts.
// ABOUTME: postMessage source tags + NetEntry/Identity shapes; imports are type-only so they erase across worlds.

// window.postMessage `source` tags for the MAIN↔ISOLATED bridge.
export const COLLECT_REQ = 'be10x:collect-req'; // ISOLATED asks the net-hook for the current network log
export const COLLECT_RES = 'be10x:collect-res'; // MAIN answers with NetEntry[]
export const NAV_EVENT = 'be10x:nav'; // MAIN tells ISOLATED about a route change (pushState/replaceState/popstate)

// One timestamped request/response, synced to the session-replay clock (epoch ms).
export type NetEntry = {
  id: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null; // capped to 10KB; null for binary/streamed/absent bodies
  status: number; // 0 until the response settles (or on network error)
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody: string | null; // capped to 50KB; null for opaque/cross-origin/absent bodies
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms; 0 until the response settles
  durationMs: number;
  type?: 'fetch' | 'xhr';
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
