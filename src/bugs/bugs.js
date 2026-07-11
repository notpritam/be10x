// ABOUTME: The QA bug store — bug tickets filed by the capture extension, over SQLite. Every mutation
// ABOUTME: bumps updated_at and appends a bug_events row. Pure core; no HTTP. Mirrors src/tasks/tasks.js.
import { randomUUID } from 'node:crypto';

export const VALID_STATUS = ['open', 'in_progress', 'resolved', 'not_a_bug', 'wont_fix'];
export const VALID_SEVERITY = ['low', 'medium', 'high', 'critical'];
// The "closed" statuses — a bug in one of these no longer counts as open on a reporter's rollup.
const CLOSED_STATUS = ['resolved', 'not_a_bug', 'wont_fix'];

// Tags are free-form triage labels stored as a JSON array of strings. Caps keep a malformed or hostile
// payload from bloating the row: at most MAX_TAGS labels, each trimmed and clipped to MAX_TAG_LEN chars.
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

// Coerce whatever the caller sends into a clean array of trimmed, non-empty strings (drops non-strings and
// blanks, clips length, caps count). Always returns an array — [] for anything that isn't a usable list.
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_TAG_LEN));
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Parse the stored tags column back into an array. NULL (older bug, pre-tags) and any malformed/non-array
// JSON both hydrate to [] so callers never have to null-check or type-guard the field.
function parseTags(raw) {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hydrate(row) {
  return {
    id: row.id,
    humanId: row.human_id,
    reporterId: row.reporter_id,
    projectId: row.project_id,
    teamId: row.team_id,
    pageUrl: row.page_url,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    assigneeId: row.assignee_id,
    resolution: row.resolution,
    screenshotKey: row.screenshot_key,
    domKey: row.dom_key,
    networkKey: row.network_key,
    sessionKey: row.session_key,
    tags: parseTags(row.tags),
    identity: JSON.parse(row.identity_json),
    meta: JSON.parse(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextBugHumanId(db) {
  const c = db.prepare('SELECT COUNT(*) AS c FROM bugs').get().c;
  return 'BUG-' + String(c + 1).padStart(3, '0');
}

export function appendBugEvent(db, bugId, actor, kind, payload = {}) {
  if (!bugId) throw new Error('NOT_FOUND');
  const id = randomUUID();
  db.prepare(
    'INSERT INTO bug_events (id, bug_id, actor, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, bugId, actor, kind, JSON.stringify(payload), Date.now());
  return { id, bugId, actor, kind, payload };
}

export function createBug(db, spec = {}) {
  const {
    reporterId,
    pageUrl,
    title,
    description = '',
    severity = 'medium',
    projectId = null,
    teamId = null,
    screenshotKey = null,
    domKey = null,
    networkKey = null,
    sessionKey = null,
    tags = [],
    identity = {},
    meta = {},
  } = spec;
  if (!reporterId) throw new Error('MISSING_FIELD:reporterId');
  if (!pageUrl) throw new Error('MISSING_FIELD:pageUrl');
  if (!title) throw new Error('MISSING_FIELD:title');
  if (!VALID_SEVERITY.includes(severity)) throw new Error('INVALID_SEVERITY');
  const id = randomUUID();
  const humanId = nextBugHumanId(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO bugs (id, human_id, reporter_id, project_id, team_id, page_url, title, description,
       status, severity, screenshot_key, dom_key, network_key, session_key, tags, identity_json, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, humanId, reporterId, projectId, teamId, pageUrl, title, description,
    severity, screenshotKey, domKey, networkKey, sessionKey, JSON.stringify(sanitizeTags(tags)), JSON.stringify(identity), JSON.stringify(meta), now, now
  );
  appendBugEvent(db, id, reporterId, 'created', { title, severity, pageUrl });
  return getBug(db, id);
}

export function getBug(db, id) {
  const row = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

// Look a bug up by its human id (e.g. "BUG-009") — the id a person pastes from the dashboard. Case-insensitive.
export function getBugByHumanId(db, humanId) {
  if (!humanId) return null;
  const row = db.prepare('SELECT * FROM bugs WHERE human_id = ? COLLATE NOCASE').get(String(humanId));
  return row ? hydrate(row) : null;
}

export function listBugs(db, { status, reporterId } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (reporterId) { where.push('reporter_id = ?'); args.push(reporterId); }
  // rowid DESC breaks the tie when two bugs land in the same millisecond (created_at alone is ambiguous),
  // guaranteeing a stable newest-first order — same reason listEvents orders by rowid.
  const sql =
    'SELECT * FROM bugs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, rowid DESC';
  return db.prepare(sql).all(...args).map(hydrate);
}

export function updateBugStatus(db, id, status, actor, { resolution } = {}) {
  const bug = getBug(db, id);
  if (!bug) throw new Error('NOT_FOUND');
  if (!VALID_STATUS.includes(status)) throw new Error('INVALID_STATUS');
  const now = Date.now();
  if (resolution !== undefined) {
    db.prepare('UPDATE bugs SET status = ?, resolution = ?, updated_at = ? WHERE id = ?').run(status, resolution, now, id);
  } else {
    db.prepare('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }
  appendBugEvent(db, id, actor, 'status', { from: bug.status, to: status, resolution: resolution ?? null });
  return getBug(db, id);
}

export function addBugComment(db, id, actor, body) {
  if (!getBug(db, id)) throw new Error('NOT_FOUND');
  db.prepare('UPDATE bugs SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  return appendBugEvent(db, id, actor, 'comment', { body: String(body ?? '') });
}

export function listBugEvents(db, id) {
  return db
    .prepare('SELECT id, actor, kind, payload_json AS payload, created_at AS createdAt FROM bug_events WHERE bug_id = ? ORDER BY rowid')
    .all(id)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function bugStatsForUser(db, userId) {
  const placeholders = CLOSED_STATUS.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS reported,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
         SUM(CASE WHEN status IN (${placeholders}) THEN 0 ELSE 1 END) AS open
       FROM bugs WHERE reporter_id = ?`
    )
    .get(...CLOSED_STATUS, userId);
  return { reported: row.reported, resolved: row.resolved || 0, open: row.open || 0 };
}
