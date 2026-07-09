// ABOUTME: MV3 service worker — owns auth, screenshot, upload, and bug filing. Message router for the popup.
// ABOUTME: All board/UploadThing egress runs here (CORS-exempt via host_permissions), never a content script.
import { deviceStart, devicePoll } from '../lib/board';
import { getConfig, setConfig, clearAuth } from '../storage';
import { reportCurrentTab } from './capture';

async function connect(boardUrl: string): Promise<{ ok: boolean; error?: string }> {
  boardUrl = boardUrl.replace(/\/$/, '');
  const label = 'Chrome extension';
  const start = await deviceStart(fetch, boardUrl, label);
  await chrome.tabs.create({ url: start.verificationUriComplete });
  const deadline = Date.now() + (start.expiresIn ?? 600) * 1000;
  const intervalMs = Math.max(1, start.interval ?? 2) * 1000;
  // Poll until approved/denied/expired. setTimeout keeps the SW alive across the await chain.
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const r = await devicePoll(fetch, boardUrl, start.deviceCode);
    if (r.status === 'approved') {
      await setConfig({ boardUrl, token: r.token, user: r.user ?? undefined });
      return { ok: true };
    }
    if (r.status === 'denied') return { ok: false, error: 'denied' };
  }
  return { ok: false, error: 'expired' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'connect') {
    connect(msg.boardUrl).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
  if (msg?.type === 'status') {
    getConfig().then((c) => sendResponse({ connected: !!c.token, boardUrl: c.boardUrl, user: c.user }));
    return true;
  }
  if (msg?.type === 'report') {
    getConfig().then((c) => {
      if (!c.token || !c.boardUrl) return sendResponse({ ok: false, error: 'not_connected' });
      return reportCurrentTab(c.boardUrl, c.token, msg).then(sendResponse);
    }).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === 'disconnect') {
    clearAuth().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
