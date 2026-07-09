// ABOUTME: The QA bug store — bug tickets filed by the capture extension, over SQLite. Every mutation
// ABOUTME: bumps updated_at and appends a bug_events row. Pure core; no HTTP. Mirrors src/tasks/tasks.js.
import { randomUUID } from 'node:crypto';

export const VALID_STATUS = ['open', 'in_progress', 'resolved', 'not_a_bug', 'wont_fix'];
export const VALID_SEVERITY = ['low', 'medium', 'high', 'critical'];
// The "closed" statuses — a bug in one of these no longer counts as open on a reporter's rollup.
const CLOSED_STATUS = ['resolved', 'not_a_bug', 'wont_fix'];

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
       status, severity, screenshot_key, dom_key, network_key, identity_json, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, humanId, reporterId, projectId, teamId, pageUrl, title, description,
    severity, screenshotKey, domKey, networkKey, JSON.stringify(identity), JSON.stringify(meta), now, now
  );
  appendBugEvent(db, id, reporterId, 'created', { title, severity, pageUrl });
  return getBug(db, id);
}

export function getBug(db, id) {
  const row = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id);
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
