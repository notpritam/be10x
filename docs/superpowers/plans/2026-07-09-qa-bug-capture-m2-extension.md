# QA Bug Capture — M2 (Browser Extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome (MV3) extension that connects to a be10x board via the device-auth flow, then lets a QA tester file a bug on the current page — screenshot + page URL + identity — with the artifacts uploaded directly to UploadThing and the ticket created through `POST /api/agent/bugs`. This is the **walking skeleton**: the whole pipe (auth → capture → upload → ingest) working end-to-end with the simplest capture. Richer in-page capture (full DOM snapshot, network buffer, element-pick, the floating widget) is M2b; deep-capture + resilience is M2c — each gets its own plan.

**Architecture:** Vite + CRXJS + React 19 + TypeScript. Three runtime surfaces: (1) a **service worker** (`src/background/`) that owns auth, screenshot capture, UploadThing upload, and the bug POST — all board/UploadThing network egress runs here so it is CORS-exempt via `host_permissions`; (2) a **popup** (`src/popup/`) for connect + "report this page"; (3) shared **pure libraries** (`src/lib/`) — a board API client and a storage wrapper — that are unit-tested with injected `fetch`, no Chrome APIs. Content scripts arrive in M2b.

**Tech Stack:** Vite 6, `@crxjs/vite-plugin`, React 19, TypeScript 5, `vitest` (unit tests for pure libs). Chrome MV3 (`chrome.*` APIs: `storage`, `tabs.captureVisibleTab`, `cookies`, `runtime`).

## Global Constraints

- **Location:** everything under `extension/` in the be10x repo. It is its OWN npm package (own `package.json`, `node_modules`, build) — NOT wired into the board's `package.json`. The board never imports it.
- **The extension MAY have runtime dependencies** (React, rrweb-snapshot later). The zero-dependency rule applies only to the board server (`src/`), not here.
- **File header:** every source file starts with two `// ABOUTME:` lines.
- **All board + UploadThing network calls happen in the service worker.** Never `fetch` the board from a content script (page-origin CORS would block it; the board sets no CORS headers).
- **Board URL is configured, never hardcoded.** Store `{ boardUrl, token, user }` in `chrome.storage.local`. Default the input to `https://be10x.notpritam.in`.
- **Auth:** `Authorization: Bearer <gfa_ token>` obtained via the board's device flow (`POST /api/device/code` → user approves at `<boardUrl>/connect?code=` → `POST /api/device/token`).
- **Graceful degradation:** if an artifact upload fails (e.g. `UPLOADTHING_TOKEN` not yet set on the board → `upload-urls` 400s), still file the bug with the metadata and surface a non-blocking warning. A capture must never be lost because storage is misconfigured.
- **Manifest V3, Chrome first.** Firefox is out of scope for M2.

## File Structure

```
extension/
  package.json            # own package; scripts: dev, build, test
  vite.config.ts          # CRXJS plugin + React
  tsconfig.json
  src/
    manifest.ts           # MV3 manifest (CRXJS consumes this)
    storage.ts            # typed chrome.storage.local wrapper: getConfig/setConfig/clear
    lib/
      board.ts            # pure board API client (fetch injected): deviceStart, devicePoll, mintUploadUrls, fileBug
      board.test.ts       # vitest unit tests for board.ts
    background/
      service-worker.ts   # wires chrome.* to lib/board + capture: connect(), reportCurrentTab()
    popup/
      index.html
      main.tsx
      Popup.tsx           # connect + "report this page" UI
  test/                   # (vitest picks up *.test.ts anywhere under src)
```

---

### Task 1: Extension scaffold that builds and loads

**Files:**
- Create: `extension/package.json`, `extension/vite.config.ts`, `extension/tsconfig.json`, `extension/src/manifest.ts`, `extension/src/popup/index.html`, `extension/src/popup/main.tsx`, `extension/src/popup/Popup.tsx`, `extension/src/background/service-worker.ts`

**Interfaces:**
- Produces: a buildable extension. `npm run build` (in `extension/`) emits `dist/` loadable via chrome://extensions → Load unpacked.

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "be10x-bug-capture",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0",
    "@types/chrome": "^0.0.287",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "types": ["chrome", "vite/client"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `extension/src/manifest.ts`**

```ts
// ABOUTME: MV3 manifest for the be10x QA bug-capture extension. CRXJS consumes this at build time.
import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'be10x Bug Capture',
  version: '0.1.0',
  description: 'File QA bugs into be10x with screenshot, DOM, network, and identity attached.',
  action: { default_popup: 'src/popup/index.html', default_title: 'Report a bug to be10x' },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  permissions: ['storage', 'tabs', 'cookies', 'activeTab', 'scripting'],
  // <all_urls> so QA can capture on any internal app; the board origin is reached from the SW (CORS-exempt).
  host_permissions: ['<all_urls>'],
});
```

- [ ] **Step 4: Create `extension/vite.config.ts`**

```ts
// ABOUTME: Vite build for the extension — CRXJS bundles the MV3 manifest, service worker, and popup.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
```

- [ ] **Step 5: Create the popup shell**

`extension/src/popup/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>body { width: 320px; margin: 0; font: 13px system-ui, sans-serif; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`extension/src/popup/main.tsx`:

```tsx
// ABOUTME: Popup React entry — mounts the Popup component into the extension action popup.
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
```

`extension/src/popup/Popup.tsx` (placeholder until Task 3):

```tsx
// ABOUTME: Popup UI — connect to a board and report the current page. Filled in across Tasks 3-4.
export function Popup() {
  return <div style={{ padding: 16 }}>be10x Bug Capture</div>;
}
```

- [ ] **Step 6: Create a no-op service worker (filled in Task 3)**

`extension/src/background/service-worker.ts`:

```ts
// ABOUTME: MV3 service worker — owns auth, screenshot, upload, and bug filing. Message router for the popup.
chrome.runtime.onInstalled.addListener(() => {
  console.log('[be10x] bug-capture installed');
});
```

- [ ] **Step 7: Install and build**

Run:
```bash
cd extension && npm install && npm run build
```
Expected: `extension/dist/` created with `manifest.json`, the service worker, and the popup bundle. No build errors.

- [ ] **Step 8: Manual load check**

In Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/dist`. Expected: the extension appears, clicking its icon shows "be10x Bug Capture". (Add `extension/dist` and `extension/node_modules` to `.gitignore`.)

- [ ] **Step 9: Commit**

```bash
printf '\ndist/\nnode_modules/\n' >> extension/.gitignore 2>/dev/null || printf 'dist/\nnode_modules/\n' > extension/.gitignore
git add extension/package.json extension/vite.config.ts extension/tsconfig.json extension/src extension/.gitignore
git commit -m "feat(extension): MV3 scaffold — manifest, popup, service worker, Vite/CRXJS build"
```

---

### Task 2: Board API client (`src/lib/board.ts`) — pure, unit-tested

**Files:**
- Create: `extension/src/lib/board.ts`, `extension/src/lib/board.test.ts`

**Interfaces:**
- Produces (all take a `fetch`-like `f` so they are testable without Chrome/network):
  - `deviceStart(f, boardUrl, label) -> { deviceCode, userCode, verificationUriComplete, interval, expiresIn }`
  - `devicePoll(f, boardUrl, deviceCode) -> { status: 'pending' } | { status: 'approved', token: string } | { status: 'denied' }`
  - `mintUploadUrls(f, boardUrl, token, files) -> { uploads: { key, uploadUrl, fileUrl, name }[] }`
  - `fileBug(f, boardUrl, token, payload) -> { bug }`
  - `getMe(f, boardUrl, token) -> { user } | null` (via `GET /api/me` is session-only; use the bug list's 401 semantics instead — SEE NOTE). For identity display we read the user from the approve step; `getMe` is omitted.

- [ ] **Step 1: Write the failing test**

`extension/src/lib/board.test.ts`:

```ts
// ABOUTME: Unit tests for the pure board API client using a stub fetch — no Chrome, no network.
import { describe, it, expect } from 'vitest';
import { deviceStart, devicePoll, mintUploadUrls, fileBug } from './board';

function stub(routes: Record<string, any>) {
  return async (url: string, opts?: any) => {
    const key = (opts?.method || 'GET') + ' ' + new URL(url).pathname;
    const entry = routes[key];
    if (!entry) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
    return { ok: true, status: 200, json: async () => entry(opts) };
  };
}

describe('board client', () => {
  it('deviceStart posts a label and returns the codes', async () => {
    const f = stub({
      'POST /api/device/code': (o) => {
        expect(JSON.parse(o.body).label).toBe('Chrome on QA-laptop');
        return { deviceCode: 'dc', userCode: 'WXYZ', verificationUriComplete: 'https://b/connect?code=WXYZ', interval: 2, expiresIn: 600 };
      },
    });
    const r = await deviceStart(f as any, 'https://b', 'Chrome on QA-laptop');
    expect(r.userCode).toBe('WXYZ');
  });

  it('devicePoll maps pending / approved', async () => {
    const pending = stub({ 'POST /api/device/token': () => ({ status: 'pending' }) });
    expect((await devicePoll(pending as any, 'https://b', 'dc')).status).toBe('pending');
    const approved = stub({ 'POST /api/device/token': () => ({ token: 'gfa_x', status: 'approved' }) });
    const r = await devicePoll(approved as any, 'https://b', 'dc');
    expect(r).toEqual({ status: 'approved', token: 'gfa_x' });
  });

  it('mintUploadUrls sends the bearer token and files, returns uploads', async () => {
    const f = stub({
      'POST /api/agent/bugs/upload-urls': (o) => {
        expect(o.headers.Authorization).toBe('Bearer gfa_x');
        expect(JSON.parse(o.body).files[0].name).toBe('shot.png');
        return { uploads: [{ key: 'K', uploadUrl: 'https://ut/K', fileUrl: 'https://f/K', name: 'shot.png' }] };
      },
    });
    const r = await mintUploadUrls(f as any, 'https://b', 'gfa_x', [{ name: 'shot.png', size: 1, type: 'image/png' }]);
    expect(r.uploads[0].key).toBe('K');
  });

  it('fileBug posts the payload with the bearer token', async () => {
    const f = stub({
      'POST /api/agent/bugs': (o) => {
        expect(o.headers.Authorization).toBe('Bearer gfa_x');
        return { bug: { id: 'b1', humanId: 'BUG-001' } };
      },
    });
    const r = await fileBug(f as any, 'https://b', 'gfa_x', { pageUrl: 'p', title: 't' });
    expect(r.bug.humanId).toBe('BUG-001');
  });

  it('throws a useful error on a non-ok response', async () => {
    const f = async () => ({ ok: false, status: 400, json: async () => ({ error: 'MISSING_FIELD:UPLOADTHING_TOKEN' }) });
    await expect(mintUploadUrls(f as any, 'https://b', 'gfa_x', [])).rejects.toThrow('MISSING_FIELD:UPLOADTHING_TOKEN');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run src/lib/board.test.ts`
Expected: FAIL — `./board` has no exports.

- [ ] **Step 3: Write the client**

`extension/src/lib/board.ts`:

```ts
// ABOUTME: Pure board API client — thin typed wrappers over be10x REST. `f` is fetch (injected for tests);
// ABOUTME: no Chrome APIs here, so it unit-tests without a browser. The service worker supplies real fetch.
export type Fetch = typeof fetch;

async function post(f: Fetch, url: string, body: unknown, token?: string) {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && (json as any).error) || `HTTP_${res.status}`);
  return json as any;
}

export async function deviceStart(f: Fetch, boardUrl: string, label: string) {
  return post(f, boardUrl + '/api/device/code', { label });
}

export async function devicePoll(f: Fetch, boardUrl: string, deviceCode: string) {
  const r = await post(f, boardUrl + '/api/device/token', { deviceCode });
  if (r && r.token) return { status: 'approved' as const, token: r.token as string };
  if (r && r.status === 'denied') return { status: 'denied' as const };
  return { status: 'pending' as const };
}

export async function mintUploadUrls(
  f: Fetch, boardUrl: string, token: string,
  files: { name: string; size: number; type: string }[]
) {
  return post(f, boardUrl + '/api/agent/bugs/upload-urls', { files }, token);
}

export async function fileBug(f: Fetch, boardUrl: string, token: string, payload: Record<string, unknown>) {
  return post(f, boardUrl + '/api/agent/bugs', payload, token);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npx vitest run src/lib/board.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/board.ts extension/src/lib/board.test.ts
git commit -m "feat(extension): pure board API client (device auth, upload-urls, fileBug) + tests"
```

---

### Task 3: Storage + service-worker connect + popup connect UI

**Files:**
- Create: `extension/src/storage.ts`
- Modify: `extension/src/background/service-worker.ts`, `extension/src/popup/Popup.tsx`

**Interfaces:**
- `storage.ts`: `getConfig() -> Promise<{ boardUrl?: string; token?: string; userCode?: string }>`, `setConfig(patch) -> Promise<void>`, `clearAuth() -> Promise<void>`.
- Service worker message API (via `chrome.runtime.onMessage`): `{ type: 'connect', boardUrl }` → drives device flow, opens the approve tab, polls to completion, stores the token, resolves `{ ok, error? }`. `{ type: 'status' }` → `{ connected, boardUrl }`.

- [ ] **Step 1: Write `extension/src/storage.ts`**

```ts
// ABOUTME: Typed wrapper over chrome.storage.local for the extension's config (board URL + auth token).
export type Config = { boardUrl?: string; token?: string };

export async function getConfig(): Promise<Config> {
  return (await chrome.storage.local.get(['boardUrl', 'token'])) as Config;
}
export async function setConfig(patch: Config): Promise<void> {
  await chrome.storage.local.set(patch);
}
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(['token']);
}
```

- [ ] **Step 2: Implement connect in the service worker**

Replace `extension/src/background/service-worker.ts`:

```ts
// ABOUTME: MV3 service worker — owns auth, screenshot, upload, and bug filing. Message router for the popup.
import { deviceStart, devicePoll } from '../lib/board';
import { getConfig, setConfig } from '../storage';

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
      await setConfig({ boardUrl, token: r.token });
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
    getConfig().then((c) => sendResponse({ connected: !!c.token, boardUrl: c.boardUrl }));
    return true;
  }
  return false;
});
```

- [ ] **Step 3: Build the popup connect UI**

Replace `extension/src/popup/Popup.tsx`:

```tsx
// ABOUTME: Popup UI — connect to a board (device auth) and report the current page. Report lands in Task 4.
import { useEffect, useState } from 'react';

const DEFAULT_BOARD = 'https://be10x.notpritam.in';

export function Popup() {
  const [boardUrl, setBoardUrl] = useState(DEFAULT_BOARD);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'status' }, (s) => {
      if (s?.connected) { setConnected(true); if (s.boardUrl) setBoardUrl(s.boardUrl); }
    });
  }, []);

  async function connect() {
    setBusy(true); setMsg('Opening approval tab…');
    chrome.runtime.sendMessage({ type: 'connect', boardUrl }, (r) => {
      setBusy(false);
      if (r?.ok) { setConnected(true); setMsg('Connected ✓'); }
      else setMsg('Connect failed: ' + (r?.error || 'unknown'));
    });
  }

  return (
    <div style={{ padding: 16, display: 'grid', gap: 8 }}>
      <strong>be10x Bug Capture</strong>
      {connected ? (
        <div style={{ color: 'green' }}>Connected to {boardUrl}</div>
      ) : (
        <>
          <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} placeholder="https://your-board" />
          <button onClick={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect to board'}</button>
        </>
      )}
      {msg && <div style={{ fontSize: 12, opacity: 0.8 }}>{msg}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Build + manual verify**

Run: `cd extension && npm run build`
Then reload the unpacked extension and:
1. Sign into your board in the browser first.
2. Open the popup → Connect → an approval tab opens at `<boardUrl>/connect?code=…` → click Authorize.
3. Popup shows "Connected ✓". Reopen the popup — it still shows connected (token persisted).

Expected: a `gfa_` token is stored (verify in the service-worker console: `chrome.storage.local.get(console.log)`).

- [ ] **Step 5: Commit**

```bash
git add extension/src/storage.ts extension/src/background/service-worker.ts extension/src/popup/Popup.tsx
git commit -m "feat(extension): device-auth connect flow (service worker + popup)"
```

---

### Task 4: Report the current page (screenshot + identity → file a bug)

**Files:**
- Create: `extension/src/background/capture.ts`
- Modify: `extension/src/background/service-worker.ts`, `extension/src/popup/Popup.tsx`

**Interfaces:**
- `capture.ts`: `reportCurrentTab(boardUrl, token, { title, description, severity }) -> { ok, bug?, warning? }`. Captures the visible tab as PNG, reads cookies for the tab's origin as coarse identity, uploads the screenshot to UploadThing (best-effort), and calls `fileBug`.
- Service-worker message: `{ type: 'report', title, description, severity }` → `reportCurrentTab(...)`.

- [ ] **Step 1: Write the capture orchestration**

`extension/src/background/capture.ts`:

```ts
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
```

- [ ] **Step 2: Route the `report` message in the service worker**

Add to the `onMessage` listener in `service-worker.ts` (import `reportCurrentTab` and `getConfig` at top):

```ts
  if (msg?.type === 'report') {
    getConfig().then((c) => {
      if (!c.token || !c.boardUrl) return sendResponse({ ok: false, error: 'not_connected' });
      return reportCurrentTab(c.boardUrl, c.token, msg).then(sendResponse);
    }).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
```

(Import line: `import { reportCurrentTab } from './capture';`.)

- [ ] **Step 3: Add the report form to the popup**

Extend `Popup.tsx`'s connected branch with a minimal form:

```tsx
// inside Popup(), add state:
const [title, setTitle] = useState('');
const [severity, setSeverity] = useState('medium');

async function report() {
  setBusy(true); setMsg('Capturing…');
  chrome.runtime.sendMessage({ type: 'report', title, severity }, (r) => {
    setBusy(false);
    if (r?.ok) setMsg(`Filed ${r.bug.humanId}${r.warning ? ' — ' + r.warning : ''}`);
    else setMsg('Report failed: ' + (r?.error || 'unknown'));
  });
}

// replace the connected <div> with:
<div style={{ display: 'grid', gap: 8 }}>
  <div style={{ color: 'green', fontSize: 12 }}>Connected to {boardUrl}</div>
  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's broken?" />
  <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
    <option value="low">low</option><option value="medium">medium</option>
    <option value="high">high</option><option value="critical">critical</option>
  </select>
  <button onClick={report} disabled={busy}>{busy ? 'Filing…' : 'Report this page'}</button>
</div>
```

- [ ] **Step 4: Build + manual end-to-end verify**

Run: `cd extension && npm run build`, reload the extension, then:
1. On any site, open the popup → type a title → **Report this page**.
2. Expect "Filed BUG-00N" (plus the "screenshot upload skipped" note until `UPLOADTHING_TOKEN` is set on the board).
3. In be10x, `GET /api/bugs` (or the dashboard once M3 lands) shows the bug with the correct `pageUrl`, title, and identity.
4. Once `UPLOADTHING_TOKEN` is configured, re-report and confirm `screenshotKey` is set and the image is retrievable.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/capture.ts extension/src/background/service-worker.ts extension/src/popup/Popup.tsx
git commit -m "feat(extension): report current page — screenshot + identity → file a bug"
```

---

## Later slices (own plans)

- **M2b — In-page capture + widget:** content script (MAIN world) wrapping fetch/XHR into a rolling network buffer; `rrweb-snapshot` DOM capture; a shadow-root floating "🐞 Report" widget with element-pick (records the clicked selector + highlight); richer identity (localStorage/JWT decode). The service worker gains a `collect` round-trip to the content script; `reportCurrentTab` uploads three artifacts (screenshot + DOM JSON + network JSON) instead of one.
- **M2c — Deep capture + resilience:** `chrome.debugger` opt-in per-tab deep network capture; upload retries/backoff; offline queue; token-expiry re-auth.

## Verification approach

- **Pure libs** (`board.ts`, and in M2b the network buffer + payload assembly): `vitest` unit tests with injected `fetch` — real logic, no mocks of our own code.
- **Chrome glue** (service worker, popup, capture): manual load-unpacked verification against a real be10x board, culminating in a real bug row (Task 4 Step 4). This is live verification, not mocked.
- The board side is already covered by M1's 344-test suite + live curl loop; M2 proves the extension half of the same contract.

## Self-review

- **Spec coverage:** device-auth reuse → Task 3; screenshot + identity + URL capture → Task 4; direct UploadThing upload with graceful degradation → Task 4 (`uploadScreenshot`); Bearer ingest → Task 4 (`fileBug`). Full DOM/network/element-pick explicitly deferred to M2b (spec §7's richer capture) — noted, not silently dropped.
- **Placeholder scan:** none — every task ships real code + exact commands. Chrome-glue steps are manual-verify by necessity (an unpacked extension can't be unit-tested), not TODOs.
- **Type consistency:** `deviceStart`/`devicePoll`/`mintUploadUrls`/`fileBug` signatures match between `board.ts`, its tests, and the service-worker callers; `getConfig`/`setConfig`/`reportCurrentTab` names match across storage, service worker, and capture.
