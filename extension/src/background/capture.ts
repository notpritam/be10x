// ABOUTME: Walking-skeleton capture — screenshot + URL + coarse identity for the active tab, uploaded to
// ABOUTME: UploadThing (best-effort) then filed as a bug. Full DOM/network capture arrives in M2b.
import { mintUploadUrls, fileBug } from '../lib/board';

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error('NO_ACTIVE_TAB');
  return tab;
}

// data: URL -> Blob, for the multipart PUT to UploadThing.
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return await (await fetch(dataUrl)).blob();
}

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

async function uploadScreenshot(boardUrl: string, token: string, blob: Blob): Promise<string | null> {
  try {
    const { uploads } = await mintUploadUrls(fetch, boardUrl, token, [
      { name: 'screenshot.png', size: blob.size, type: 'image/png' },
    ]);
    const u = uploads[0];
    const fd = new FormData();
    fd.append('file', blob, 'screenshot.png');
    const put = await fetch(u.uploadUrl, { method: 'PUT', body: fd });
    if (!put.ok) return null;
    return u.key;
  } catch {
    return null; // storage not configured (e.g. no UPLOADTHING_TOKEN yet) — degrade, don't lose the bug
  }
}

export async function reportCurrentTab(
  boardUrl: string, token: string,
  meta: { title: string; description?: string; severity?: string }
) {
  const tab = await activeTab();
  const pageUrl = tab.url || '';
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  const blob = await dataUrlToBlob(dataUrl);
  const screenshotKey = await uploadScreenshot(boardUrl, token, blob);
  const identity = await readIdentity(pageUrl);
  const bug = await fileBug(fetch, boardUrl, token, {
    pageUrl,
    title: meta.title || tab.title || 'Untitled bug',
    description: meta.description || '',
    severity: meta.severity || 'medium',
    screenshotKey,
    identity,
    meta: { pageTitle: tab.title, userAgent: navigator.userAgent, capturedAt: Date.now() },
  });
  return { ok: true, bug: bug.bug, warning: screenshotKey ? undefined : 'screenshot upload skipped (storage not configured)' };
}
