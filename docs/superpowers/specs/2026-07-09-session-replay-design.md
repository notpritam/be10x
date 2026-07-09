# QA Bug Capture — Session Replay (prod-grade) design + contract

- **Date:** 2026-07-09
- **Status:** Approved — build
- **Supersedes** the point-in-time snapshot capture for the *primary* flow (the quick popup snapshot stays as a fallback).

## Goal

Turn the extension from "one frozen moment" into a **scrubbable session recording**: QA records what the user actually did (DOM mutations, clicks, input, scroll, navigation) plus a timestamped **network timeline**, marks the moment(s) the bug happens, and the dashboard plays it back on a real timeline (rrweb-player) with the markers pinned and a DevTools-style network panel synced to the playhead.

**Engine:** `rrweb` (`record()`) in the extension → `rrweb-player` in the dashboard. Built for exactly this.

**Recording model (both):** an always-on **rolling buffer** (keeps ~the last 2 minutes so surprise bugs still have lead-up) **and** explicit **Start/Stop** for a deliberate longer repro. Marks work in either mode.

**Combined replay + snapshot:** every bug keeps BOTH — the scrubbable session recording AND a static rrweb-snapshot of the marked moment — surfaced via a **view toggle (Replay ⇄ Snapshot)** in the dashboard with a clear indicator of which you're viewing.

**Visits timeline:** capture every navigation during the recording (SPA route change + full page load) as a **visits** list `{ t, url, title }[]` (in `meta.visits`), shown on the timeline so you can see and jump between the pages the user moved through.

**Enterprise bar (non-negotiable):** this is intended to ship as a sellable, enterprise-grade product. Hold every part to that standard — never break or measurably slow the host page; handle large recordings without jank; polished, accessible, themed UI; complete loading / empty / error states; sane teardown and memory bounds; no rough edges or dev-only affordances left in.

---

## Data contract (authoritative — both halves build to this)

### Artifacts (uploaded to UploadThing; the bug row stores the keys)
- **`session.json`** → `sessionKey` — `{ "events": RrwebEvent[], "startedAt": number, "endedAt": number }`. `events` is rrweb's `eventWithTime[]` straight from `record()`. This is what `rrweb-player` replays.
- **`network.json`** → `networkKey` — `NetEntry[]`, timestamped so it syncs to the replay clock:
  ```ts
  type NetEntry = {
    id: string; url: string; method: string;
    requestHeaders: Record<string,string>; requestBody: string | null;
    status: number; statusText?: string;
    responseHeaders: Record<string,string>; responseBody: string | null; // bodies capped (req 10KB, resp 50KB)
    startedAt: number; endedAt: number; durationMs: number; // epoch ms
    type?: string; // 'fetch' | 'xhr'
  };
  ```
- **`screenshot.png`** → `screenshotKey` — cover image (visible tab at report time).
- (optional) **`dom.json`** → `domKey` — a single rrweb-snapshot for a static fallback view. Not required if `sessionKey` is present.

### Bug ingest payload → `POST /api/agent/bugs` (unchanged transport; new fields)
```jsonc
{
  "pageUrl": "...", "title": "...", "description": "...", "severity": "high",
  "screenshotKey": "...", "sessionKey": "...", "networkKey": "...", "domKey": null,
  "identity": { "loggedIn": true, "email": "buyer@x.co", "source": "/api/me" },
  "meta": {
    "markers": [ { "t": 1783619469393, "label": "This is the bug" } ],  // epoch ms on the session clock
    "recording": { "startedAt": 1783619400000, "endedAt": 1783619470000, "durationMs": 70000, "mode": "rolling|explicit" },
    "pageTitle": "...", "userAgent": "...", "viewport": { "w": 1440, "h": 900 }
  }
}
```

### Server (small, additive)
- `bugs` table gains **`session_key TEXT`**: add to `src/db/schema.sql` (fresh DBs) **and** a `COLUMN_MIGRATIONS` entry in `src/db/db.js` (existing DBs self-heal): `{ table:'bugs', column:'session_key', ddl:"ALTER TABLE bugs ADD COLUMN session_key TEXT" }`.
- `createBug` accepts `sessionKey`; `hydrate` returns `sessionKey`; the Bearer ingest route passes it; `GET /api/bugs/:id/artifact/:kind` supports **`kind='session'`** → `session_key`. Markers + recording metadata ride in `meta_json` (no column needed).

---

## Extension (recorder) — responsibilities
- Add `rrweb` (record). Extend the existing MAIN-world `net-hook` to emit **timestamped** `NetEntry` (startedAt/endedAt/durationMs) and keep a rolling window aligned with the session buffer.
- **Rolling buffer:** always-on `record()` into a capped in-memory ring (drop events older than ~120s using rrweb `checkoutEveryNms` full-snapshots so a trimmed buffer still replays). Lives in the ISOLATED content script (has the DOM); coordinates with net-hook for the network timeline.
- **In-page recorder widget** (Shadow DOM so host CSS can't touch it; injected on `<all_urls>`): a small floating control —
  - **● Start / ■ Stop** (explicit deliberate recording; while stopped, the rolling buffer still runs),
  - **⚑ Mark** ("This is the bug" — prompts an optional label, pushes `{t: Date.now(), label}`),
  - **Report** → opens a compact form (title, severity, description) → on submit, package `{events, startedAt, endedAt}` + `network` + `markers` + a `captureVisibleTab` cover screenshot, upload all via the existing `mintUploadUrls` (one call, best-effort), and `POST /api/agent/bugs` with the new fields. Graceful: still files with whatever uploaded.
- **Prod-grade:** never throw into / visibly slow the host page; wrap all rrweb/hooks in try/catch; cap buffer memory; tear down cleanly on navigation; the widget must be unobtrusive, keyboard-dismissible, and not capture itself (exclude the widget subtree from rrweb via `blockClass`). Internal-use default = **capture full fidelity** (do NOT mask inputs — they want the real data), but leave a `maskAllInputs` flag wired for later.
- The popup keeps its current quick "Report this page" snapshot as a fallback; the widget is the primary flow.

## Dashboard (replay) — responsibilities
- Add `rrweb-player` (+ its CSS) to `web/`. In `BugDetail`, when `sessionKey` is present: fetch `session.json` via `bugArtifactUrl(id,'session')` and mount `rrweb-player` → **scrub/play/pause/seek** the whole session.
- **Markers on the scrubber:** overlay `meta.markers` as clickable pins on the player timeline (seek to marker on click); list them beside the player.
- **Synced network panel:** fetch `network.json`; render a DevTools-style table (method, URL, status, duration, a mini waterfall); **highlight the rows in-flight at the current playhead time**, and clicking a row expands request/response headers + bodies. Keep the raw-JSON "Open" as a secondary affordance.
- Screenshot stays as the cover/poster. Prod-grade, themed, matches the existing be10x UI; renders gracefully when `sessionKey`/`networkKey` are absent (older bugs).

## Verification
- Extension: vitest for pure logic (rolling-buffer trim, marker ordering, NetEntry mapping), tsc clean, build emits loadable content scripts (respect the U+FEFF escape pass). Live Chrome: record a session on a real app, mark, report; replay scrubs; network panel syncs.
- Dashboard: `node --test` stays green (+ artifact `session` kind test); `web` tsc+vite build clean; live: open a recorded bug, scrub, click markers + network rows.
- Server: `node --test` covers the `session_key` column + artifact kind.
