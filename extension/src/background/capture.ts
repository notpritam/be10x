// ABOUTME: Report flow — screenshot + rrweb DOM snapshot + network log + identity for the active tab,
// ABOUTME: uploaded to UploadThing (best-effort, per-artifact) then filed as a bug. Never lose the bug.
import { mintUploadUrls, fileBug } from '../lib/board';
import type { Identity, NetEntry } from '../content/protocol';

type Collected = { dom: unknown; network: NetEntry[]; identity: Identity | null };
type Artifact = { slot: 'screenshot' | 'dom' | 'network' | 'session'; name: string; blob: Blob; type: string };

// Everything the ISOLATED content script gathered for a widget-initiated session report.
export type SessionReportPayload = {
  pageUrl?: string;
  form: { title: string; severity?: string; description?: string };
  session: { events: unknown[]; startedAt: number; endedAt: number };
  network?: NetEntry[];
  dom?: unknown;
  identity?: Identity | null;
  meta?: Record<string, unknown>;
};

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error('NO_ACTIVE_TAB');
  return tab;
}

// data: URL -> Blob, for the multipart PUT to UploadThing.
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return await (await fetch(dataUrl)).blob();
}

// Best-effort cover screenshot of the reporting tab's window. Never throws — a capture failure just
// means the bug files without a cover image (some pages/states aren't capturable).
async function captureScreenshot(windowId?: number): Promise<Blob | null> {
  try {
    const dataUrl = typeof windowId === 'number' ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }) : await chrome.tabs.captureVisibleTab({ format: 'png' });
    return await dataUrlToBlob(dataUrl);
  } catch {
    return null;
  }
}

function jsonBlob(data: unknown): Blob {
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// Coarse identity from cookies — the collector's page-context identity is layered over this later.
async function readIdentity(url: string) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    const names = cookies.map((c) => c.name);
    const loggedIn = names.some((n) => /sess|token|auth|sid|jwt/i.test(n));
    return { loggedIn, cookieNames: names };
  } catch {
    return { loggedIn: null };
  }
}

// Ask the tab's content scripts for DOM + network + identity. Degrades cleanly on pages with no
// content script (chrome://, the web store, PDF viewer, etc.) — the bug still files without them.
async function collectFromTab(tabId: number): Promise<Collected> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'collect' })) as Partial<Collected> | undefined;
    return {
      dom: res?.dom ?? null,
      network: Array.isArray(res?.network) ? (res.network as NetEntry[]) : [],
      identity: (res?.identity as Identity | undefined) ?? null,
    };
  } catch {
    return { dom: null, network: [], identity: null };
  }
}

// Mint all upload URLs in one call, then PUT each. A failed upload yields a null key, never throws;
// if minting itself throws (storage not configured), every key degrades to null.
async function uploadArtifacts(boardUrl: string, token: string, artifacts: Artifact[]): Promise<(string | null)[]> {
  if (artifacts.length === 0) return [];
  try {
    const { uploads } = await mintUploadUrls(
      fetch,
      boardUrl,
      token,
      artifacts.map((a) => ({ name: a.name, size: a.blob.size, type: a.type })),
    );
    return await Promise.all(
      artifacts.map(async (a, i) => {
        const u = uploads?.[i];
        if (!u) return null;
        try {
          const fd = new FormData();
          fd.append('file', a.blob, a.name);
          const put = await fetch(u.uploadUrl, { method: 'PUT', body: fd });
          return put.ok ? u.key : null;
        } catch {
          return null;
        }
      }),
    );
  } catch {
    return artifacts.map(() => null); // storage not configured (e.g. no UPLOADTHING_TOKEN) — degrade, don't lose the bug
  }
}

// Collector wins field-by-field, but only for fields it actually resolved (never clobber cookie
// signal with an unknown/null from the page).
function mergeIdentity(cookie: Record<string, unknown>, collector: Identity | null): Record<string, unknown> {
  if (!collector) return cookie;
  const out: Record<string, unknown> = { ...cookie };
  if (collector.loggedIn !== null && collector.loggedIn !== undefined) out.loggedIn = collector.loggedIn;
  if (collector.email) out.email = collector.email;
  if (collector.source) out.source = collector.source;
  if (collector.storageKeys) out.storageKeys = collector.storageKeys;
  return out;
}

export async function reportCurrentTab(
  boardUrl: string,
  token: string,
  meta: { title: string; description?: string; severity?: string },
) {
  const tab = await activeTab();
  const pageUrl = tab.url || '';
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  const shot = await dataUrlToBlob(dataUrl);

  const collected = tab.id ? await collectFromTab(tab.id) : { dom: null, network: [], identity: null };

  const artifacts: Artifact[] = [{ slot: 'screenshot', name: 'screenshot.png', blob: shot, type: 'image/png' }];
  if (collected.dom != null) artifacts.push({ slot: 'dom', name: 'dom.json', blob: jsonBlob(collected.dom), type: 'application/json' });
  if (collected.network.length > 0) artifacts.push({ slot: 'network', name: 'network.json', blob: jsonBlob(collected.network), type: 'application/json' });

  const keys = await uploadArtifacts(boardUrl, token, artifacts);
  const keyBySlot: Partial<Record<Artifact['slot'], string | null>> = {};
  artifacts.forEach((a, i) => {
    keyBySlot[a.slot] = keys[i];
  });

  const identity = mergeIdentity(await readIdentity(pageUrl), collected.identity);

  const bug = await fileBug(fetch, boardUrl, token, {
    pageUrl,
    title: meta.title || tab.title || 'Untitled bug',
    description: meta.description || '',
    severity: meta.severity || 'medium',
    screenshotKey: keyBySlot.screenshot ?? null,
    domKey: keyBySlot.dom ?? null,
    networkKey: keyBySlot.network ?? null,
    identity,
    meta: { pageTitle: tab.title, userAgent: navigator.userAgent, capturedAt: Date.now() },
  });
  return {
    ok: true,
    bug: bug.bug,
    warning: keyBySlot.screenshot ? undefined : 'screenshot upload skipped (storage not configured)',
  };
}

// Widget-initiated session report: the content script already gathered the recording, network, DOM
// snapshot, and identity; the SW adds the cover screenshot, uploads everything in one mint call, and
// files the bug. Every step is best-effort — the bug still files (with whatever succeeded) on failure.
export async function reportSession(boardUrl: string, token: string, tab: chrome.tabs.Tab | undefined, payload: SessionReportPayload) {
  const pageUrl = tab?.url || payload.pageUrl || '';
  const shot = await captureScreenshot(tab?.windowId);
  const network = Array.isArray(payload.network) ? payload.network : [];

  const artifacts: Artifact[] = [];
  if (shot) artifacts.push({ slot: 'screenshot', name: 'screenshot.png', blob: shot, type: 'image/png' });
  artifacts.push({ slot: 'session', name: 'session.json', blob: jsonBlob(payload.session), type: 'application/json' });
  if (network.length > 0) artifacts.push({ slot: 'network', name: 'network.json', blob: jsonBlob(network), type: 'application/json' });
  if (payload.dom != null) artifacts.push({ slot: 'dom', name: 'dom.json', blob: jsonBlob(payload.dom), type: 'application/json' });

  const keys = await uploadArtifacts(boardUrl, token, artifacts);
  const keyBySlot: Partial<Record<Artifact['slot'], string | null>> = {};
  artifacts.forEach((a, i) => {
    keyBySlot[a.slot] = keys[i];
  });

  const identity = mergeIdentity(await readIdentity(pageUrl), payload.identity ?? null);

  const bug = await fileBug(fetch, boardUrl, token, {
    pageUrl,
    title: payload.form.title || tab?.title || 'Untitled bug',
    description: payload.form.description || '',
    severity: payload.form.severity || 'medium',
    screenshotKey: keyBySlot.screenshot ?? null,
    sessionKey: keyBySlot.session ?? null,
    networkKey: keyBySlot.network ?? null,
    domKey: keyBySlot.dom ?? null,
    identity,
    meta: payload.meta ?? {},
  });
  return {
    ok: true,
    bug: bug.bug,
    warning: keyBySlot.session ? undefined : 'session upload skipped (storage not configured)',
  };
}
