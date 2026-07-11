# be10x QA capture

An end-to-end QA bug-capture system built into the be10x board: a browser extension records exactly what a
tester saw and did, files it as a **bug**, and the dashboard (plus an MCP + AI + integrations) turns that
capture into something a developer — or an agent — can debug and fix.

---

## The pieces

### 1. Capture extension (MV3, `extension/`)

An always-on rolling recorder mounts a floating widget on every page. On **Report** it packages a bug from
everything it saw:

- **Session replay** — rrweb recording (rolling 2-min buffer + explicit Start/Stop), scrubbable on the dashboard.
- **Network** — fetch / XHR / WebSocket timeline (headers, capped bodies, timing), synced to the replay clock.
- **Console** — every `console.*` call, timestamped; uncaught errors + unhandled rejections captured too.
- **DOM snapshot** — rrweb-snapshot of the page at report time.
- **Page source** — rendered HTML + inline `<script>`/`<style>` text + external refs + a
  PerformanceResourceTiming manifest (`source.json`).
- **Picked elements** — the tester crosshairs elements → robust CSS selector + XPath + React
  component/props/source, each with an optional **note**.
- **Drawings** — freehand annotations drawn over the page (replayed as a synced overlay).
- **Test credentials** — the login the tester was using (so a dev can reproduce). Entered by hand; masked in the UI.
- **Environment** — browser/OS, screen + DPR, timezone, locale, CPU/memory, network, and page-load timing.
- **Markers** — "this is the bug" pins; error moments are auto-marked in red.
- **Triage** — team / project / tags chosen at report time.

Reporter niceties: single-letter widget shortcuts (**R** record · **M** mark · **P** pick · **D** draw ·
**N** notes, active only while the widget is focused), a copyable last-picked selector, and a "capture
health" line showing what the report will contain.

Binary artifacts (screenshot / DOM / network / session / source) upload directly to **UploadThing**; the
board only ever stores the keys and signs short-lived read URLs.

### 2. Dashboard (`web/`, served from `public/`)

- **Bug list** — free-text search (title / id / URL / tags), keyboard nav (`/` focus, ↑/↓ move, ↵ open),
  "Assigned to me" / "Reported by me" toggles, a status-distribution strip, filters, and inline status
  quick-actions.
- **Bug detail** — the scrubbable replay ⇄ snapshot, a playhead-synced network panel (with **HAR export**),
  the source panel, per-artifact **Downloads**, the **Environment** and **Test credentials** cards, the
  **root-cause** card, a **Triage** card (assignee + status), comments/timeline, **Copy summary** (Markdown),
  **Share**, **Send to an agent**, and **GitHub issue** actions.
- **Public share links** — `/b/<token>` serves the full read-only capture to anyone with the link.

### 3. Bug-debugging MCP (`src/mcp/bug-server.js`)

Paste a bug id / `BUG-009` / dashboard URL / share URL and an agent scrubs the whole capture itself.
See the tool list below.

### 4. Agent + AI + integrations

- **Bug → task handoff** — "Send to an agent to fix" composes a code-issue task from the capture (suspected
  component/source + repro + login), seeds the RCA as an artifact, and links the bug ⇄ task.
- **Root-cause analysis** — a deterministic heuristic always runs; an optional **LLM** upgrade layers on when
  a key is configured (credentials are never sent to the model).
- **GitHub issue export** — file the bug as an issue in a configured repo.
- **New-bug webhook** — POST a Slack-compatible notification when a bug is filed.

---

## Run & link

```bash
# Boot the board (serves the dashboard + the API). GFA_DB_PATH isolates the SQLite file.
GFA_DB_PATH=/path/to/be10x.db node bin/be10x.js serve --port 4611

# In a project repo: link it — writes .be10x/mcp.json with two MCP servers (be10x + be10x-bugs).
be10x link
```

`be10x link` writes an MCP config a coding agent picks up automatically:

- **`be10x`** — the task/board tools (`gfa_*`).
- **`be10x-bugs`** — the bug-debugging tools (below). Add `UPLOADTHING_TOKEN` to its `env` to enable the
  artifact-body tools (network/dom/replay/source); the rest work without it.

Load the extension from `extension/dist` (unpacked) and connect it to the board from its popup.

---

## Environment variables

All optional except `UPLOADTHING_TOKEN` (needed for artifact storage). Use real values only in the running
process's env — never commit them.

| Variable | Enables | Example |
| --- | --- | --- |
| `UPLOADTHING_TOKEN` | Artifact storage (screenshot/DOM/network/session/source) | `<PLACEHOLDER>` |
| `GFA_DB_PATH` | SQLite file location | `/data/be10x.db` |
| `GFA_LLM_KEY` | AI root-cause analysis (Anthropic) | `<PLACEHOLDER>` |
| `GFA_LLM_MODEL` | Model for AI RCA (default `claude-haiku-4-5-20251001`) | `claude-haiku-4-5-20251001` |
| `GFA_GITHUB_TOKEN` | GitHub issue export | `<PLACEHOLDER>` |
| `GFA_GITHUB_REPO` | Target repo for issue export (`owner/name`) | `acme/app` |
| `GFA_BUG_WEBHOOK` | New-bug notification (Slack incoming webhook or any receiver) | `<PLACEHOLDER>` |

Without a given key, that feature is **inert**: the route returns a clear 409 (or the webhook simply doesn't
fire) and the UI hides the affordance — nothing degrades.

---

## `be10x-bugs` MCP tools

| Tool | What it returns |
| --- | --- |
| `bug_list` | Filed bugs (newest first) — id, title, status, severity, page, tags, error count |
| `bug_get` | Full record for a bug (id / `BUG-009` / dashboard URL / share URL) — counts + capability flags |
| `bug_analyze` | Heuristic root cause — suspected cause/component/source, evidence, repro, confidence |
| `bug_console` | Console output (filter by level), with offsets from recording start |
| `bug_picked_elements` | Picked elements — selector/xpath/text/geometry + note + React component/props/source |
| `bug_markers` | Marked moments (user + auto error markers) + navigations, with offsets |
| `bug_drawings` | Freehand annotations — color, timing, normalized bounding box |
| `bug_credentials` | The test login the reporter supplied |
| `bug_environment` | Device / browser / page-load environment |
| `bug_network` | Network timeline (summaries, or one full entry; `failuresOnly`) — needs `UPLOADTHING_TOKEN` |
| `bug_dom` | Static DOM snapshot — needs `UPLOADTHING_TOKEN` |
| `bug_replay_events` | rrweb event index (type histogram, per-event offsets) — needs `UPLOADTHING_TOKEN` |
| `bug_dom_at` | DOM at a replay moment (last full snapshot + mutations, pure JS) — needs `UPLOADTHING_TOKEN` |
| `bug_source` | Page source bundle (`part`: resources/scripts/styles/html/external/meta) — needs `UPLOADTHING_TOKEN` |
| `bug_screenshot_url` | Signed URL to the cover screenshot — needs `UPLOADTHING_TOKEN` |
| `bug_handoff` | File a fix task from the bug (returns the created task; idempotent) |

---

## Capture data model (`bugs.meta`)

`meta_json` is stored verbatim, so capture fields never need a schema change:

| Field | Meaning |
| --- | --- |
| `markers` | Pins on the replay clock; `kind: "user" \| "error"` |
| `visits` | Navigations during the recording |
| `recording` | The recording window + mode (rolling / explicit) |
| `console` | Timestamped console entries |
| `errorCount` | Error-level console entries in the window |
| `pickedElements` | Picked elements (selector, geometry, React info, `note`) |
| `drawings` | Freehand strokes (viewport-normalized points, color, timing) |
| `credentials` | Test login (username / password / notes) |
| `environment` | Device / browser / page-load environment |
| `viewport`, `pageTitle`, `userAgent`, `notes` | Misc capture metadata + QA notes |
| `llmAnalysis` | Cached AI root-cause (once run) |
| `githubIssueUrl` | Exported GitHub issue (once created) |

Dedicated columns: `screenshot_key`, `dom_key`, `network_key`, `session_key`, `source_key`, `tags`,
`assignee_id`, `task_id`.
