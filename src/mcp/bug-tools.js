// ABOUTME: Pure, transport-agnostic MCP tool registry for DEBUGGING a filed QA bug — the agent-facing front
// ABOUTME: door behind "paste a bug link and the agent sorts it out". Resolves a bug from an id/BUG-id/URL/
// ABOUTME: share-token, then exposes its full capture: console, network, DOM, picked elements, drawings,
// ABOUTME: credentials, environment, markers, replay events, DOM-at-time, and a heuristic root-cause analysis.
import { getBug, getBugByHumanId, listBugs } from '../bugs/bugs.js';
import { bugShareView } from '../share/bug-share.js';
import { signAccessUrl } from '../bugs/uploadthing.js';
import { analyzeBug } from '../bugs/analyze.js';
import { handoffBugToTask } from '../bugs/handoff.js';

// --- bug resolution -------------------------------------------------------------
// Accept whatever a human pastes: a raw uuid, a human id (BUG-009), a dashboard URL, or a public share URL
// (/b/<64-hex-token>). Returns the hydrated bug or throws NO_BUG.
function resolveBug(db, ref) {
  if (!ref || typeof ref !== 'string') throw new Error('MISSING_FIELD:bug');
  let token = ref.trim();

  if (/^https?:\/\//i.test(token)) {
    try {
      const u = new URL(token);
      const share = u.pathname.match(/\/b\/([0-9a-f]{16,})/i);
      if (share) {
        const b = bugShareView(db, share[1]);
        if (b) return b;
      }
      // Otherwise treat the last path segment as an id/human-id (…/bugs/<id>, …/BUG-009).
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length) token = segs[segs.length - 1];
    } catch {
      /* not a parseable URL — fall through to the plain-token lookups */
    }
  }

  if (/^BUG-\d+$/i.test(token)) {
    const b = getBugByHumanId(db, token.toUpperCase());
    if (b) return b;
  }
  const byId = getBug(db, token);
  if (byId) return byId;
  const byShare = bugShareView(db, token);
  if (byShare) return byShare;
  throw new Error('NO_BUG');
}

// --- artifact fetch -------------------------------------------------------------
const ARTIFACT_KEY_FIELD = { dom: 'domKey', network: 'networkKey', session: 'sessionKey', screenshot: 'screenshotKey' };

// Sign + fetch a captured artifact JSON (dom/network/session) from UploadThing. Needs UPLOADTHING_TOKEN in the
// MCP process env (to sign the read URL); without it the sync tools still work — only these degrade.
async function fetchArtifact(bug, kind) {
  const field = ARTIFACT_KEY_FIELD[kind];
  if (!field) throw new Error('BAD_ARTIFACT_KIND:' + kind);
  const key = bug[field];
  if (!key) throw new Error('NO_ARTIFACT:' + kind + ' (this bug has no ' + kind + ' capture)');
  let url;
  try {
    url = signAccessUrl(key);
  } catch {
    throw new Error('ARTIFACT_UNAVAILABLE: set UPLOADTHING_TOKEN in the MCP server env to fetch the ' + kind + ' artifact.');
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('ARTIFACT_FETCH_FAILED:' + kind + ':' + resp.status);
  return resp.json();
}

// session.json may be `{ events, startedAt, endedAt }` or (defensively) a bare events array.
function extractEvents(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.events)) return raw.events;
  return [];
}
// network.json is a NetEntry[]; tolerate a `{ entries }` wrapper.
function extractEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

// --- shaping helpers ------------------------------------------------------------
// A tiny header of a bug, for lists + the top of a get. Never includes artifact bodies.
function bugHeader(bug) {
  return {
    id: bug.id,
    humanId: bug.humanId,
    title: bug.title,
    status: bug.status,
    severity: bug.severity,
    pageUrl: bug.pageUrl,
    tags: bug.tags,
    createdAt: bug.createdAt,
    errorCount: bug.meta?.errorCount ?? 0,
    hasReplay: !!bug.sessionKey,
    hasNetwork: !!bug.networkKey,
    hasDom: !!bug.domKey,
  };
}

const RRWEB_TYPE = { 0: 'DomContentLoaded', 1: 'Load', 2: 'FullSnapshot', 3: 'IncrementalSnapshot', 4: 'Meta', 5: 'Custom', 6: 'Plugin' };
const recStart = (bug) => bug.meta?.recording?.startedAt ?? bug.meta?.markers?.[0]?.t ?? 0;

// A compact one-line view of a network entry (no headers/bodies) for the list shape.
function netSummary(e, i) {
  return {
    index: i,
    method: e.method,
    url: e.url,
    status: e.status,
    kind: e.kind ?? e.type,
    durationMs: e.durationMs,
    reqBytes: e.requestBodyBytes,
    respBytes: e.responseBodyBytes,
    failed: e.status === 0 || e.status >= 400,
  };
}

// The registry. Every entry: { name, description, inputSchema, handler(db, ctx, args) } — handlers may be
// async (artifact tools fetch from UploadThing); the server awaits them.
const BUG_ARG = { bug: { type: 'string', description: 'The bug: a uuid, a human id (BUG-009), a dashboard URL, or a public share URL (/b/<token>).' } };

export const BUG_TOOLS = [
  {
    name: 'bug_list',
    description: 'List filed QA bugs (newest first) with a one-line header each — id, human id, title, status, severity, page, tags, and error count. Filter by status and cap with limit.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: open | in_progress | resolved | not_a_bug | wont_fix.' },
        limit: { type: 'number', description: 'Max bugs to return (default 30).' },
      },
      additionalProperties: false,
    },
    handler: (db, _ctx, args = {}) => {
      const bugs = listBugs(db, { status: args.status });
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 30;
      return { count: bugs.length, bugs: bugs.slice(0, limit).map(bugHeader) };
    },
  },
  {
    name: 'bug_get',
    description: 'Resolve a bug (from an id / BUG-id / dashboard URL / share URL) and return the full record: header, description, QA notes, identity, environment, error count, marker/visit counts, and which captures (replay/network/dom) are available. Start here.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const m = bug.meta ?? {};
      return {
        ...bugHeader(bug),
        description: bug.description,
        notes: m.notes ?? null,
        identity: bug.identity ?? null,
        environment: m.environment ?? null,
        credentials: m.credentials ? { username: m.credentials.username ?? null, hasPassword: !!m.credentials.password, notes: m.credentials.notes ?? null } : null,
        recording: m.recording ?? null,
        counts: {
          console: (m.console ?? []).length,
          errors: m.errorCount ?? 0,
          markers: (m.markers ?? []).length,
          visits: (m.visits ?? []).length,
          pickedElements: (m.pickedElements ?? []).length,
          drawings: (m.drawings ?? []).length,
        },
        reportedAt: bug.createdAt,
        updatedAt: bug.updatedAt,
        resolution: bug.resolution ?? null,
      };
    },
  },
  {
    name: 'bug_analyze',
    description: 'A heuristic root-cause analysis of the bug from its captured signals — error console lines, error markers, picked component/source, and the QA notes. Returns a suspected cause, supporting evidence, suggested repro steps, and the suspected file/component when known. Deterministic; no external model.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => analyzeBug(resolveBug(db, args.bug)),
  },
  {
    name: 'bug_console',
    description: "The page console output captured around the bug, in time order. Filter by level (error/warn/info/log/debug) and cap with limit. Each entry has ts (epoch ms), offsetMs (from recording start), level, and text.",
    inputSchema: {
      type: 'object',
      properties: {
        ...BUG_ARG,
        level: { type: 'string', description: 'Only this level (error | warn | info | log | debug).' },
        limit: { type: 'number', description: 'Max entries (default 200).' },
      },
      required: ['bug'],
      additionalProperties: false,
    },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const start = recStart(bug);
      let rows = (bug.meta?.console ?? []).map((c) => ({ ...c, offsetMs: c.ts - start }));
      if (args.level) rows = rows.filter((c) => c.level === args.level);
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(1000, args.limit)) : 200;
      return { total: rows.length, errors: (bug.meta?.console ?? []).filter((c) => c.level === 'error').length, entries: rows.slice(0, limit) };
    },
  },
  {
    name: 'bug_picked_elements',
    description: 'The elements the QA reporter pinpointed on the page — CSS selector, XPath, tag/text/geometry, the reporter\'s note on why it matters, and (for React pages) the owning component name, props, and source file. The strongest pointer to the buggy code.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      return { elements: bug.meta?.pickedElements ?? [] };
    },
  },
  {
    name: 'bug_markers',
    description: 'Moments pinned on the replay clock — the reporter\'s "this is the bug" marks (kind:user) and auto-markers at captured error moments (kind:error). Each has offsetMs from recording start.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const start = recStart(bug);
      return { markers: (bug.meta?.markers ?? []).map((m) => ({ ...m, offsetMs: m.t - start })), visits: bug.meta?.visits ?? [] };
    },
  },
  {
    name: 'bug_drawings',
    description: 'The freehand annotations the reporter drew over the page while recording — one entry per stroke with its color, timing (offsetMs from start), and a normalized bounding box (0..1 of the viewport) so you know WHERE on the screen they were pointing.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const start = recStart(bug);
      const r4 = (n) => Math.round(n * 1e4) / 1e4; // normalized coords — 4dp is plenty and drops fp noise
      const strokes = (bug.meta?.drawings ?? []).map((s) => {
        const xs = s.points.map((p) => p.x);
        const ys = s.points.map((p) => p.y);
        return {
          offsetMs: s.ts - start,
          color: s.color,
          points: s.points.length,
          bbox: xs.length
            ? { x: r4(Math.min(...xs)), y: r4(Math.min(...ys)), w: r4(Math.max(...xs) - Math.min(...xs)), h: r4(Math.max(...ys) - Math.min(...ys)) }
            : null,
        };
      });
      return { strokes };
    },
  },
  {
    name: 'bug_credentials',
    description: 'The test login the reporter was using when they hit the bug (username + password + notes), so you can reproduce with the same account. Captured raw by the product owner\'s choice. Returns null when none was supplied.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      return { credentials: bug.meta?.credentials ?? null };
    },
  },
  {
    name: 'bug_environment',
    description: 'The reporter\'s device / browser / page-load environment — userAgent + parsed brands, platform, screen + DPR, timezone, language, CPU/memory, network, and navigation timing (TTFB/FCP/DOMContentLoaded/Load).',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      return { environment: bug.meta?.environment ?? null, viewport: bug.meta?.viewport ?? null, pageTitle: bug.meta?.pageTitle ?? null };
    },
  },
  {
    name: 'bug_network',
    description: 'The captured network timeline (fetch/XHR/WebSocket) synced to the replay clock. By default returns compact one-line summaries; pass index to get ONE full entry with request/response headers + bodies; pass failuresOnly to keep only status 0 or >=400. Needs UPLOADTHING_TOKEN in the MCP env.',
    inputSchema: {
      type: 'object',
      properties: {
        ...BUG_ARG,
        index: { type: 'number', description: 'Return the full entry at this index (headers + bodies) instead of the summary list.' },
        failuresOnly: { type: 'boolean', description: 'Keep only failed requests (status 0 or >= 400).' },
        limit: { type: 'number', description: 'Max summaries to return (default 100).' },
      },
      required: ['bug'],
      additionalProperties: false,
    },
    handler: async (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const entries = extractEntries(await fetchArtifact(bug, 'network'));
      if (Number.isFinite(args.index)) {
        const e = entries[args.index];
        if (!e) throw new Error('NO_SUCH_REQUEST:' + args.index);
        return e;
      }
      let list = entries.map(netSummary);
      if (args.failuresOnly) list = list.filter((e) => e.failed);
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 100;
      return { total: entries.length, failed: entries.filter((e) => e.status === 0 || e.status >= 400).length, requests: list.slice(0, limit) };
    },
  },
  {
    name: 'bug_dom',
    description: 'The static DOM snapshot captured at report time (rrweb-snapshot JSON tree) — the page markup as it was when the bug was filed. Large; prefer bug_picked_elements for the specific node, or bug_dom_at for the DOM at a replay moment. Needs UPLOADTHING_TOKEN.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: async (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      return fetchArtifact(bug, 'dom');
    },
  },
  {
    name: 'bug_replay_events',
    description: 'A structured index of the rrweb replay event stream — total count, a histogram by event type, the recording duration, and a per-event list of { index, type, typeName, offsetMs }. Use this to see the shape of the session, then bug_dom_at to reconstruct the DOM at a moment. Needs UPLOADTHING_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        ...BUG_ARG,
        limit: { type: 'number', description: 'Max event index rows to return (default 300).' },
      },
      required: ['bug'],
      additionalProperties: false,
    },
    handler: async (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const events = extractEvents(await fetchArtifact(bug, 'session'));
      if (events.length === 0) return { total: 0, histogram: {}, events: [] };
      const start = events[0].timestamp ?? recStart(bug);
      const end = events[events.length - 1].timestamp ?? start;
      const histogram = {};
      for (const e of events) {
        const name = RRWEB_TYPE[e.type] ?? String(e.type);
        histogram[name] = (histogram[name] ?? 0) + 1;
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(2000, args.limit)) : 300;
      const rows = events.slice(0, limit).map((e, i) => ({ index: i, type: e.type, typeName: RRWEB_TYPE[e.type] ?? String(e.type), offsetMs: (e.timestamp ?? start) - start }));
      return { total: events.length, durationMs: end - start, histogram, events: rows };
    },
  },
  {
    name: 'bug_dom_at',
    description: 'Reconstruct the DOM at a replay moment WITHOUT a browser: returns the last full rrweb snapshot at or before the target time plus the incremental mutation events between that snapshot and the target, so you can see the page state when something went wrong. Give atMs (offset from recording start) or atEpoch. Needs UPLOADTHING_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        ...BUG_ARG,
        atMs: { type: 'number', description: 'Target time as an offset in ms from recording start.' },
        atEpoch: { type: 'number', description: 'Target time as an absolute epoch-ms timestamp (alternative to atMs).' },
      },
      required: ['bug'],
      additionalProperties: false,
    },
    handler: async (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      const events = extractEvents(await fetchArtifact(bug, 'session'));
      if (events.length === 0) throw new Error('NO_REPLAY');
      const start = events[0].timestamp ?? recStart(bug);
      const target = Number.isFinite(args.atEpoch) ? args.atEpoch : start + (Number.isFinite(args.atMs) ? args.atMs : Number.MAX_SAFE_INTEGER);
      // Last FullSnapshot (type 2) at or before target, and its preceding Meta (type 4) for viewport context.
      let snapIdx = -1;
      for (let i = 0; i < events.length; i++) {
        if ((events[i].timestamp ?? start) > target) break;
        if (events[i].type === 2) snapIdx = i;
      }
      if (snapIdx < 0) throw new Error('NO_SNAPSHOT_BEFORE_TARGET');
      const meta = events.slice(0, snapIdx).reverse().find((e) => e.type === 4) ?? null;
      const mutations = [];
      for (let i = snapIdx + 1; i < events.length; i++) {
        const e = events[i];
        if ((e.timestamp ?? start) > target) break;
        if (e.type === 3) mutations.push(e);
      }
      return {
        note: 'Apply the incremental mutations (in order) onto fullSnapshot to reach the DOM at the target time. Node ids are stable across the stream.',
        targetOffsetMs: target - start,
        snapshotOffsetMs: (events[snapIdx].timestamp ?? start) - start,
        meta: meta ? meta.data : null,
        fullSnapshot: events[snapIdx].data,
        mutationsSince: mutations.map((e) => ({ offsetMs: (e.timestamp ?? start) - start, source: e.data?.source, data: e.data })),
        mutationCount: mutations.length,
      };
    },
  },
  {
    name: 'bug_handoff',
    description: 'Hand this bug off to the agent board to be FIXED: create a code-issue task composed from the capture (symptom, suspected component/source, repro steps, test login) with the heuristic RCA seeded as its artifact, and link the bug ⇄ task. Returns the created task. If the bug was already handed off, returns the existing link (alreadyLinked) without creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        ...BUG_ARG,
        projectId: { type: 'string', description: 'File the task under this project id (scope=project).' },
        teamId: { type: 'string', description: 'File the task under this team id (scope=team).' },
      },
      required: ['bug'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      const bug = resolveBug(db, args.bug);
      return handoffBugToTask(db, { bugId: bug.id, actorId: ctx.userId, projectId: args.projectId ?? null, teamId: args.teamId ?? null });
    },
  },
  {
    name: 'bug_screenshot_url',
    description: 'A short-lived signed URL to the cover screenshot captured when the bug was filed — hand it to a multimodal step to actually look at what the reporter saw. Needs UPLOADTHING_TOKEN.',
    inputSchema: { type: 'object', properties: { ...BUG_ARG }, required: ['bug'], additionalProperties: false },
    handler: (db, _ctx, args) => {
      const bug = resolveBug(db, args.bug);
      if (!bug.screenshotKey) throw new Error('NO_ARTIFACT:screenshot');
      try {
        return { url: signAccessUrl(bug.screenshotKey), expiresInMinutes: 60 };
      } catch {
        throw new Error('ARTIFACT_UNAVAILABLE: set UPLOADTHING_TOKEN in the MCP server env to sign the screenshot URL.');
      }
    },
  },
];

// Convenience lookup shared by the server wiring and tests.
export function getBugTool(name) {
  return BUG_TOOLS.find((t) => t.name === name) ?? null;
}

// Exposed for tests.
export { resolveBug };
