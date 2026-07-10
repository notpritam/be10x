// ABOUTME: ISOLATED-world collectors — a point-in-time DOM snapshot, the network log, and identity.
// ABOUTME: Bridges to the MAIN-world net-hook over postMessage; degrades to best-effort on any failure.
import { snapshot } from 'rrweb-snapshot';
import { COLLECT_REQ, COLLECT_RES, type NetEntry, type ConsoleEntry, type Identity } from './protocol';

const NET_TIMEOUT_MS = 500;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const AUTH_URL_RE = /\/(me|users?\/me|account|session|auth|profile|whoami|viewer)\b/i;
const AUTH_KEY_RE = /token|jwt|session|auth/i;

// The MAIN-world net-hook's buffers, pulled over one postMessage round-trip: the network log and the
// console log (both already capped/bounded in the hook).
export type HookData = { network: NetEntry[]; console: ConsoleEntry[] };

// Round-trip to the MAIN-world net-hook; resolve empties if it never answers within the timeout.
export function collectNetwork(): Promise<HookData> {
  return new Promise((resolve) => {
    let settled = false;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const finish = (out: HookData) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve(out);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; nonce?: string; network?: unknown; console?: unknown } | null;
      if (!d || d.source !== COLLECT_RES || d.nonce !== nonce) return;
      finish({
        network: Array.isArray(d.network) ? (d.network as NetEntry[]) : [],
        console: Array.isArray(d.console) ? (d.console as ConsoleEntry[]) : [],
      });
    };
    try {
      window.addEventListener('message', onMsg);
      window.postMessage({ source: COLLECT_REQ, nonce }, '*');
    } catch {
      finish({ network: [], console: [] });
      return;
    }
    setTimeout(() => finish({ network: [], console: [] }), NET_TIMEOUT_MS);
  });
}

// rrweb-snapshot yields a rebuildable node tree; fall back to raw outerHTML if it throws.
export function captureDom(): unknown {
  try {
    const snap = snapshot(document);
    if (snap) return snap;
  } catch {
    /* fall through to the raw-HTML fallback */
  }
  try {
    return { html: document.documentElement.outerHTML };
  } catch {
    return null;
  }
}

// Bounded recursive scan for an email — prefers mail-ish keys, then any email-shaped string.
function findEmail(value: unknown, depth = 0): string | undefined {
  if (value == null || depth > 5) return undefined;
  if (typeof value === 'string') {
    const m = value.match(EMAIL_RE);
    return m ? m[0] : undefined;
  }
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /mail/i.test(k)) {
      const m = v.match(EMAIL_RE);
      if (m) return m[0];
    }
  }
  for (const k of Object.keys(obj)) {
    const found = findEmail(obj[k], depth + 1);
    if (found) return found;
  }
  return undefined;
}

// Auth-ish localStorage key names only — never the values (avoid exfiltrating secrets).
function authStorageKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && AUTH_KEY_RE.test(k)) out.push(k);
    }
  } catch {
    /* storage may be blocked (e.g. third-party context) */
  }
  return out;
}

export function extractIdentity(network: NetEntry[]): Identity {
  let loggedIn: boolean | null = null;
  let email: string | undefined;
  let source: string | undefined;
  for (const r of network) {
    try {
      if (!AUTH_URL_RE.test(r.url)) continue;
      if (r.status === 401 || r.status === 403) {
        if (loggedIn === null) loggedIn = false; // an auth endpoint rejected us — signal logged-out
        continue;
      }
      if (!r.responseBody) continue;
      const found = findEmail(JSON.parse(r.responseBody));
      if (found) {
        email = found;
        source = r.url;
        loggedIn = true;
        break;
      }
    } catch {
      /* not JSON / not parseable — keep scanning */
    }
  }
  const storageKeys = authStorageKeys();
  if (loggedIn === null && storageKeys.length > 0) loggedIn = true; // auth-ish storage implies a session
  return { loggedIn, email, source, storageKeys };
}

export async function collect(): Promise<{ dom: unknown; network: NetEntry[]; identity: Identity }> {
  const { network } = await collectNetwork();
  const dom = captureDom();
  const identity = extractIdentity(network);
  return { dom, network, identity };
}

// Register the SW's point-in-time `collect` responder (the popup's quick-report fallback path).
export function installCollectHandler(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'collect') {
      collect()
        .then(sendResponse)
        .catch(() => sendResponse({ dom: null, network: [], identity: { loggedIn: null } as Identity }));
      return true; // keep the channel open for the async sendResponse
    }
    return false;
  });
}
