# QA Bug Capture — browser extension + a `bugs` module in be10x

- **Date:** 2026-07-09
- **Status:** Approved design (pre-implementation)
- **Owner:** notpritam
- **Related:** `2026-07-01-git-for-agents-v1-design.md`, `2026-07-03-admin-dashboard-leaderboard-design.md`

---

## 1. Problem & goal

Internal QA/test developers, working on **company-owned test machines**, need a friction-free way to report a bug with *everything a developer needs to reproduce it already attached* — no copy-paste, no tab-switching, no "can you send me the console/network/URL".

When QA hits a bug they click one button and the tool captures, at that exact moment:

- a **screenshot** of what was on screen,
- the **exact DOM/HTML** at that instant (rebuildable, styles inlined),
- the **network activity** leading up to it (requests, response headers, bodies, and the `Authorization` tokens in play),
- the **page URL + timestamp**, and
- the **identity context** — which account they were logged into the app as (email / token), or that they were logged **out**.

That becomes a tracked **bug ticket** inside the existing **be10x** board/dashboard. A developer opens it, sees the exact state, fixes it, and sets its status right there (`open → in_progress → resolved / not_a_bug / wont_fix`). The team gets one durable, filterable list of every bug ever reported, rolled up **per tester** on their profile.

Because the machines are internal and company-owned, capturing tokens / auth / full request bodies is acceptable and expected. Data sensitivity is handled by keeping capture artifacts **private** (see §6).

### Non-goals (for this design)

- Continuous session replay / "DVR" recording. Capture is **point-in-time**, triggered on report. (A rolling network buffer exists only to give the moment its lead-up context.)
- A separate/standalone dashboard. Bugs live **inside be10x**.
- New authentication. We **reuse** be10x's existing accounts + token system.
- Public / external / multi-tenant SaaS hardening. This is an internal tool.

---

## 2. Architecture — only one piece is greenfield

Everything ships **inside the be10x repo** (`/Volumes/X9/Documents/skills/git-for-agents/`) and deploys with the existing Render service.

| Piece | New? | What |
| --- | --- | --- |
| `extension/` | **New (from scratch)** | MV3 browser extension: capture engine + report UI. The only greenfield build. |
| `src/bugs/` + routes in `src/http/server.js` | New module, existing patterns | Pure-core `bugs` repository module + thin HTTP routes (ingest, list, detail, stats, status). Plain ESM JS. |
| `web/src/components/bugs/` + `ProfilePage` hook | New page, existing patterns | Bugs list + detail viewers in the dashboard; a "bugs reported/resolved" card on the profile. TSX + Tailwind + existing shadcn UI. |

**be10x stack (confirmed):** zero-runtime-dependency Node `node:http` server (plain JS, ESM) + `better-sqlite3`, serving a prebuilt React 19 / Vite / Tailwind v4 SPA from `public/`. Deployed on Render via Docker with a 1 GB persistent disk at `/data`.

---

## 3. Data flow (the whole loop)

1. QA hits a bug → clicks **🐞 Report** (floating in-page widget).
2. Widget freezes the page and lets QA **click the broken element** (records its CSS selector + highlights it), then shows a small form (title, description, severity).
3. Extension **captures**:
   - **Screenshot** — viewport PNG via `chrome.tabs.captureVisibleTab`.
   - **DOM snapshot** — `rrweb-snapshot` JSON (rebuildable, styles/resources inlined), plus the picked element's selector.
   - **Network bundle** — the rolling fetch/XHR buffer (see §7), optionally augmented by a `chrome.debugger` deep-capture if that tab has deep mode on.
   - **Identity** — cookies (`chrome.cookies`) + `localStorage`/`sessionStorage` snapshot + a best-effort "logged in as" (decoded from a JWT or a `/me`-type response in the buffer), or an explicit logged-**out** marker.
   - **URL + timestamp**.
4. Extension requests **signed UploadThing upload URLs** from be10x (`POST /api/agent/bugs/upload-urls`) and **`PUT`s the three artifacts (screenshot, DOM JSON, network JSON) directly to UploadThing.** The large bytes never pass through be10x — this deliberately sidesteps be10x's **~2 MB request-body cap** and its lack of blob storage.
5. Extension **`POST`s a small JSON** (UploadThing keys + title + description + severity + page URL + identity summary + element selector) to `POST /api/agent/bugs`, authenticated with a `Bearer gfa_…` token. be10x creates the bug row; **reporter = the token's user**.
6. Bug appears in the **dashboard** (list + detail). Detail view renders the screenshot, the rebuilt DOM, a network viewer, and the identity panel — pulling artifacts from UploadThing via short-lived signed URLs.
7. Developer sets **status** + writes a resolution; history is recorded. Per-tester rollups appear on the **profile**; the full list is browsable/filterable.

---

## 4. Authentication — reuse, build nothing

The extension authenticates exactly like the be10x CLI/agent does today:

- **Device-authorization flow** (already implemented): extension `POST`s `/api/device/code` (public) → user, already signed into the board, opens `/connect?code=<userCode>` and clicks **Authorize** (`POST /api/device/approve`, session-authed) → extension polls `POST /api/device/token` and collects a personal **`gfa_` token** once.
  - Server refs: `src/http/server.js` device routes (~`:526`–`:557`), `src/auth/device.js`, web approve page `web/src/components/agent/DeviceApprovePage.tsx`.
- Extension stores the token in `chrome.storage` and sends `Authorization: Bearer gfa_…` on all board calls. `agentAuth` (`src/http/server.js` ~`:104`–`:111`) resolves it via `verifyToken` (`src/auth/tokens.js`) to `{ userId, tokenId }` — the reporter identity, for free.
- **All board calls run from the extension's service worker.** With `host_permissions` for the board origin, service-worker `fetch` is **CORS-exempt**, so **no CORS/OPTIONS handling needs to be added to be10x** (it has none today). Content scripts must *not* call the board directly (they'd be subject to page CORS).

No admin role is required to file a bug (any authenticated user can). The board has no per-user admin flag anyway — the AdminDashboard is gated by the shared `GFA_ADMIN_TOKEN`; bug **viewing/resolving** is available to any signed-in user via the session-cookie routes.

---

## 5. Storage — UploadThing (no new server dependency)

All three artifacts are stored as **private** UploadThing files.

- be10x holds the UploadThing key (`UPLOADTHING_TOKEN` in the Render env — the one new piece of config). It mints **signed upload URLs** by calling UploadThing's REST `prepareUpload` endpoint with plain `fetch` — **no `uploadthing` SDK dependency**, preserving be10x's zero-runtime-dependency server ethos. (Local HMAC-SHA256 signed-URL construction is an alternative if we want to drop the round-trip; REST `prepareUpload` is simpler and chosen for v1.)
- The extension `PUT`s each file (as `FormData`) to the returned `*.ingest.uploadthing.com` URL.
- For viewing, be10x issues short-lived access URLs via `generateSignedURL(fileKey, { expiresIn })` — appropriate because bundles contain tokens/cookies. Files are **not** public-read.
- be10x's DB stores only the **keys + metadata**, never the binaries.

This keeps the SQLite DB and the 1 GB Render disk lean, and means the ingest `POST` body stays far under the 2 MB cap — **so `readJson` (the 2 MB cap at `src/http/server.js` ~`:67`–`:73`) does not need changing.**

---

## 6. Data model — a dedicated `bugs` table

Chosen over shoehorning bugs into `tasks(type='bug')` to keep the agent task-board semantics (runs, wake_queue, scope/human_id constraints) uncontaminated. Bugs have their own purpose-built columns; the dashboard/profile get small new queries.

Appended to `src/db/schema.sql` (applied idempotently on boot; all timestamps `INTEGER` epoch-ms, matching existing tables):

```sql
CREATE TABLE IF NOT EXISTS bugs (
  id             TEXT PRIMARY KEY,
  human_id       TEXT NOT NULL UNIQUE,          -- e.g. BUG-1042, shown in UI
  reporter_id    TEXT NOT NULL REFERENCES users(id),
  project_id     TEXT,                           -- loose string, mirrors tasks.project_id
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL,
  page_url       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','resolved','not_a_bug','wont_fix')),
  severity       TEXT NOT NULL DEFAULT 'medium'
                   CHECK (severity IN ('low','medium','high','critical')),
  assignee_id    TEXT REFERENCES users(id),
  resolution     TEXT,                           -- dev's closing note
  screenshot_key TEXT,                           -- UploadThing key
  dom_key        TEXT,                           -- UploadThing key (rrweb-snapshot JSON)
  network_key    TEXT,                           -- UploadThing key (network bundle JSON)
  identity_json  TEXT NOT NULL DEFAULT '{}',     -- { loggedIn, email, tokenPreview, ... }
  meta_json      TEXT NOT NULL DEFAULT '{}',     -- { selector, viewport, userAgent, capturedAt, deepCapture }
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bugs_reporter ON bugs (reporter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bugs_status   ON bugs (status, created_at);

CREATE TABLE IF NOT EXISTS bug_events (
  id           TEXT PRIMARY KEY,
  bug_id       TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,                    -- user id or display name
  kind         TEXT NOT NULL,                    -- 'status' | 'comment' | 'assign' | 'created'
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bug_events_bug ON bug_events (bug_id, created_at);
```

*(Schema is created on every boot via `db.exec(schema.sql)`; there is no migration runner. Additive column changes to existing tables would go through `COLUMN_MIGRATIONS` in `src/db/db.js`, but these are brand-new tables, so appending to `schema.sql` is sufficient.)*

---

## 7. Extension design (the new build)

**Stack:** Manifest V3, TypeScript, React (popup + injected report widget), built with Vite + CRXJS.

**Components:**

- **Content script — MAIN world, `document_start`:** injects a `fetch`/`XMLHttpRequest` wrapper that records a **rolling ring buffer** (last N requests) of `{ url, method, requestHeaders (incl. Authorization), requestBody, status, responseHeaders, responseBody (size-capped), startedAt, durationMs }`. Same-origin responses expose full headers; cross-origin are limited to CORS-exposed headers (tokens live in *request* headers, so they're captured reliably). Also performs the on-demand `rrweb-snapshot` DOM capture and hosts the freeze/element-pick overlay.
- **Service worker:** owns device-auth, the UploadThing upload orchestration, the bug `POST`, and (optional) `chrome.debugger` deep-capture attach/detach for a tab. All board/UploadThing network egress happens here (CORS-exempt).
- **Report widget (injected UI):** floating **🐞 Report** button → freeze page → **click the broken element** (records selector, draws a highlight) → small form (title, description, severity) → submit → progress + success toast with a link to the bug in be10x. *(Freeform drawing/annotation is deferred.)*
- **Popup:** sign-in status ("Authorized as …"), the active board URL, a deep-capture toggle, and recent reports.

**Hybrid network capture (as decided):** JS interception runs always-on for the rolling buffer (no banner, all-day friendly). `chrome.debugger` deep-capture is an **opt-in per-tab toggle** for when true DevTools-Network fidelity is needed (accepts the Chrome debugging banner while active).

**Permissions (manifest):** `activeTab`, `scripting`, `tabs` (for `captureVisibleTab`), `cookies`, `storage`, `debugger` (deep mode), and `host_permissions` for `<all_urls>` (capture on any site) + the board origin.

---

## 8. Dashboard integration (be10x `web/`)

be10x uses **no react-router**: hard routes are sniffed in `web/src/App.tsx`, and in-app pages are state-driven views + full-page overlay booleans in `AppShell`.

- **Bugs page** — new `web/src/components/bugs/BugsPage.tsx` (list + filters: status, reporter, severity, project) and `BugDetail.tsx`. Follow the fetch+render + card styling of `LeaderboardPage.tsx` / `ProfilePage.tsx` (`rounded-[8px] border border-border/60 bg-card p-5 shadow-card`, shadcn `ui/` components, `lucide` icons, `sonner` toasts, `cn()`).
- **Detail viewers:** screenshot image; a **DOM viewer** (render the rebuilt rrweb snapshot in a sandboxed `<iframe>`, or a collapsible HTML tree); a **network viewer** (table of requests → expandable headers/body); an **identity panel** (logged-in email/token-preview or logged-out). Artifacts fetched via be10x-issued signed UploadThing URLs.
- **Nav:** add an `onBugs` callback + a `<NavRow>` in `web/src/components/shell/Sidebar.tsx` (Views section) and a `showBugs` overlay branch in `web/src/components/shell/AppShell.tsx` (mirroring `showProfile` / `showLeaderboard`).
- **Profile rollup:** add a "Bugs reported / resolved" `<Card>` to `web/src/components/user/ProfilePage.tsx` and a `api.bugStats()` call in its `Promise.all`.
- **API client:** add `listBugs`, `getBug`, `updateBugStatus`, `bugStats` to the `api` object in `web/src/lib/api.ts` (session-cookie, same-origin `request()` wrapper), and `Bug` / `BugEvent` types to `web/src/lib/types.ts`.
- **Build:** `npm run --prefix web build` emits to the committed `public/` (the Docker image ships prebuilt static assets); the new page must be built and `public/` committed.

---

## 9. Server changes (summary)

All server code is plain ESM JS, following be10x's **pure-core module + thin HTTP adapter** boundary and `// ABOUTME:` header convention.

- `src/db/schema.sql` — append `bugs` + `bug_events` (§6).
- `src/bugs/bugs.js` *(new)* — pure repository: `createBug`, `getBug`, `listBugs`, `updateBugStatus`, `addBugEvent`, `bugStatsForUser`. `db`-first args, `hydrate()` snake→camel, prepared statements, `randomUUID()` + `Date.now()` (mirror `src/executor/runs.js`, `src/tasks/tasks.js`).
- `src/bugs/uploadthing.js` *(new)* — thin `fetch` wrapper over UploadThing REST: `mintUploadUrls(files)`, `signAccessUrl(key)`. No SDK.
- `src/http/server.js` —
  - **`AGENT_ROUTES`** (Bearer): `POST /api/agent/bugs/upload-urls` (mint UT URLs), `POST /api/agent/bugs` (ingest → `createBug`, reporter = `auth.userId`).
  - **`ROUTES`** (session): `GET /api/bugs`, `GET /api/bugs/:id`, `POST /api/bugs/:id/status`, `POST /api/bugs/:id/comment`, `GET /api/bugs/:id/artifact/:kind` (redirect/proxy to a signed UT URL), `GET /api/bugs/stats`.
- `test/bugs.test.js` *(new)* — `node --test`, `openDb(':memory:')` unit tests for `src/bugs/bugs.js`, plus HTTP coverage via `createApp(db)` + a minted `gfa_` token, in the `withServer` style of `test/http.test.js`.

---

## 10. MVP scope & build order

- **M1 — Server bugs module + auth + storage.** `bugs`/`bug_events` tables, `src/bugs/*`, ingest + list/detail/status/stats routes, UploadThing signed-URL mint, tests. *Verifiable end-to-end with `curl` + a real UploadThing bucket (mint URL → PUT a file → POST a bug → GET it back).*
- **M2 — Extension capture + report.** Device-auth, screenshot + DOM + network + identity capture, direct upload, bug `POST`. *Verifiable live: install the extension, authorize, report a bug on any site, see it appear in be10x.*
- **M3 — Dashboard.** Bugs list + detail viewers (screenshot / DOM / network / identity), status + resolution workflow, Sidebar nav; rebuild + commit `public/`.
- **M4 — Profile rollup + filters.** Per-tester "reported/resolved" card + list filtering.

**Deferred:** freeform screenshot annotation/drawing; deep-capture UX polish; attachment retention/cleanup policy; richer identity decoding; full-page (beyond-viewport) screenshots; console-log capture.

---

## 11. Constraints honored & risks

**Honored:**

- **2 MB body cap** — avoided entirely by uploading binaries to UploadThing and sending only keys to be10x.
- **No blob storage in be10x** — solved by UploadThing; nothing large hits SQLite or `/data`.
- **Zero-runtime-dependency server** — UploadThing accessed via plain `fetch`, no SDK.
- **Conventions** — `// ABOUTME:` headers, pure-core modules, TDD with `node --test` + in-memory DB, prebuilt-and-committed `public/`.
- **No new auth** — reuses device-auth + `gfa_` tokens; service-worker egress dodges the missing CORS layer.

**Risks / open items:**

- **UploadThing REST specifics** (exact `prepareUpload` request/response shape, region host, HMAC details, per-file size limits) to be pinned during M1 against current UploadThing docs.
- **Cross-origin response bodies/headers** are partially opaque to the JS interceptor; deep-capture (`chrome.debugger`) is the escape hatch when full fidelity is required.
- **rrweb-snapshot fidelity** for canvas / cross-origin iframes / shadow DOM is imperfect; acceptable for v1 (screenshot covers the visual truth).
- **Sensitive data leaves the box** — capture bundles (tokens, cookies, bodies) are stored on UploadThing. Acceptable per the internal-only, company-device constraint; mitigated by private files + short-lived signed access URLs. Revisit if the tool ever leaves internal use.
- **Data volume** — many testers × multi-MB bundles will accumulate on UploadThing; a retention/cleanup policy is deferred but noted.

---

## 12. Verification approach

Following be10x conventions (not mocked): unit tests over the pure `bugs` module against a real in-memory SQLite DB; HTTP tests against a real `createApp(db)` server with a real minted token; and live end-to-end verification for the extension (real site → real UploadThing upload → real bug row → real dashboard render). Storybook/mocked routes are not treated as completion evidence.
