// ABOUTME: Shared wire contract between the MAIN-world net-hook and the ISOLATED-world collector.
// ABOUTME: postMessage source tags + NetRecord/Identity shapes; imports are type-only so they erase across worlds.

// window.postMessage `source` tags for the collect round-trip (collector asks, net-hook answers).
export const COLLECT_REQ = 'be10x:collect-req';
export const COLLECT_RES = 'be10x:collect-res';

export type NetRecord = {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string; // capped to 10KB; empty for binary/streamed bodies
  status: number; // 0 until the response settles (or on network error)
  responseHeaders: Record<string, string>;
  responseBody: string; // capped to 50KB; empty for cross-origin/opaque responses
  startedAt: number; // epoch ms
  durationMs: number;
};

export type Identity = {
  loggedIn: boolean | null; // null = unknown
  email?: string;
  source?: string; // url the email was read from
  storageKeys?: string[]; // auth-ish localStorage key names, WITHOUT their values
};
