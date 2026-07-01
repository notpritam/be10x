// ABOUTME: Zero-dependency HTTP front door — REST over the core + serves the buildless web board.
// ABOUTME: Session-cookie auth for humans. createApp(db) returns an http.Server; startServer runs it.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { openDb } from '../db/db.js';
import { createUser, getUserByEmail, getUserById } from '../auth/users.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, getSession, deleteSession } from '../auth/sessions.js';
import { createTeam } from '../teams/teams.js';
import { createTask, getTask, listTasks, setResearch, setPlan, updateContent, transition, retryTask, rateTask } from '../tasks/tasks.js';
import { listEvents } from '../tasks/events.js';
import { requestReview, submitReview } from '../reviews/reviews.js';
import { requestInput, answerInput, getOpenInputRequest } from '../tasks/input_requests.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function statusFor(code) {
  if (code === 'BAD_CREDENTIALS' || code === 'NO_SESSION') return 401;
  if (code === 'EMAIL_TAKEN' || code === 'SLUG_TAKEN' || code === 'ILLEGAL_TRANSITION' || code === 'ALREADY_ANSWERED' || code === 'ALREADY_MEMBER') return 409;
  if (code === 'NO_TASK' || code === 'NO_REQUEST' || code === 'NOT_FOUND') return 404;
  return 400; // MISSING_FIELD:*, UNKNOWN_TYPE, INVALID_*, etc.
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(db, req) {
  const sid = cookies(req).gfa_sid;
  if (!sid) return null;
  const s = getSession(db, sid);
  return s ? getUserById(db, s.userId) : null;
}

function match(pattern, pathname) {
  const pp = pattern.split('/');
  const xp = pathname.split('/');
  if (pp.length !== xp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

function teamsForUser(db, userId) {
  return db
    .prepare('SELECT t.id, t.name, t.slug FROM teams t JOIN memberships m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.created_at')
    .all(userId);
}

function serveStatic(req, res) {
  let rel = new URL(req.url, 'http://x').pathname;
  if (rel === '/') rel = '/index.html';
  const fp = normalize(join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC) || !existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
  const ext = fp.slice(fp.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(fp));
}

// Route table: [method, pattern, needsAuth, handler(ctx)] where ctx = { db, req, res, params, body, user }
const ROUTES = [
  ['POST', '/api/auth/signup', false, async ({ db, res, body }) => {
    const user = createUser(db, { email: body.email, displayName: body.displayName, password: body.password });
    const s = createSession(db, user.id);
    res.setHeader('Set-Cookie', `gfa_sid=${s.id}; HttpOnly; SameSite=Lax; Path=/`);
    send(res, 200, { user });
  }],
  ['POST', '/api/auth/login', false, async ({ db, res, body }) => {
    const row = getUserByEmail(db, body.email || '');
    if (!row || !verifyPassword(body.password || '', row.passwordHash)) throw new Error('BAD_CREDENTIALS');
    const s = createSession(db, row.id);
    res.setHeader('Set-Cookie', `gfa_sid=${s.id}; HttpOnly; SameSite=Lax; Path=/`);
    send(res, 200, { user: { id: row.id, email: row.email, displayName: row.displayName } });
  }],
  ['POST', '/api/auth/logout', false, async ({ db, req, res }) => {
    const sid = cookies(req).gfa_sid;
    if (sid) deleteSession(db, sid);
    res.setHeader('Set-Cookie', 'gfa_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    send(res, 200, { ok: true });
  }],
  ['GET', '/api/me', true, async ({ res, user }) => send(res, 200, { user })],
  ['GET', '/api/teams', true, async ({ db, res, user }) => send(res, 200, { teams: teamsForUser(db, user.id) })],
  ['POST', '/api/teams', true, async ({ db, res, body, user }) => send(res, 200, { team: createTeam(db, { name: body.name, createdBy: user.id }) })],
  ['GET', '/api/tasks', true, async ({ db, req, res }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { tasks: listTasks(db, { scope: q.get('scope') || undefined, teamId: q.get('teamId') || undefined, status: q.get('status') || undefined }) });
  }],
  ['POST', '/api/tasks', true, async ({ db, res, body, user }) => send(res, 200, {
    task: createTask(db, { type: body.type, scope: body.scope, title: body.title, ownerId: user.id, content: body.content || {}, teamId: body.teamId || null, severity: body.severity || 'medium' }),
  })],
  ['GET', '/api/tasks/:id', true, async ({ db, res, params }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    send(res, 200, { task: t });
  }],
  ['GET', '/api/tasks/:id/events', true, async ({ db, res, params }) => send(res, 200, { events: listEvents(db, params.id) })],
  ['POST', '/api/tasks/:id/transition', true, async ({ db, res, params, body, user }) => send(res, 200, { task: transition(db, params.id, body.to, user.id) })],
  ['POST', '/api/tasks/:id/plan', true, async ({ db, res, params, body, user }) => send(res, 200, { task: setPlan(db, params.id, body.plan, user.id) })],
  ['POST', '/api/tasks/:id/research', true, async ({ db, res, params, body, user }) => send(res, 200, { task: setResearch(db, params.id, body.research, user.id) })],
  ['POST', '/api/tasks/:id/content', true, async ({ db, res, params, body, user }) => send(res, 200, { task: updateContent(db, params.id, body.patch || {}, user.id) })],
  ['POST', '/api/tasks/:id/rate', true, async ({ db, res, params, body, user }) => send(res, 200, { task: rateTask(db, params.id, body.rating, user.id) })],
  ['POST', '/api/tasks/:id/retry', true, async ({ db, res, params, user }) => send(res, 200, { task: retryTask(db, params.id, user.id) })],
  ['POST', '/api/tasks/:id/review/request', true, async ({ db, res, params, body, user }) => send(res, 200, { task: requestReview(db, params.id, body.reviewerId, user.id) })],
  ['POST', '/api/tasks/:id/review/submit', true, async ({ db, res, params, body, user }) => send(res, 200, { review: submitReview(db, params.id, user.id, body.verdict, body.comment || '') })],
  ['POST', '/api/tasks/:id/input/request', true, async ({ db, res, params, body, user }) => send(res, 200, { inputRequest: requestInput(db, params.id, body.question, { choices: body.choices || null, allowCustom: body.allowCustom !== false }, user.id) })],
  ['GET', '/api/tasks/:id/input', true, async ({ db, res, params }) => send(res, 200, { inputRequest: getOpenInputRequest(db, params.id) })],
  ['POST', '/api/input/:reqId/answer', true, async ({ db, res, params, body, user }) => { answerInput(db, params.reqId, body.answer, user.id); send(res, 200, { ok: true }); }],
];

export function createApp(db) {
  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      if (!pathname.startsWith('/api/')) { if (req.method === 'GET') return serveStatic(req, res); res.writeHead(404); return res.end(); }
      for (const [method, pattern, needsAuth, handler] of ROUTES) {
        if (req.method !== method) continue;
        const params = match(pattern, pathname);
        if (!params) continue;
        const user = currentUser(db, req);
        if (needsAuth && !user) return send(res, 401, { error: 'NO_SESSION' });
        const body = method === 'GET' ? {} : await readJson(req);
        return await handler({ db, req, res, params, body, user });
      }
      send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      const code = String(e.message || 'ERROR');
      send(res, statusFor(code), { error: code });
    }
  });
}

export function startServer({ dbPath, port } = {}) {
  const db = openDb(process.env.GFA_DB_PATH || dbPath || './gfa.db');
  const app = createApp(db);
  const p = Number(port || process.env.PORT || 4600);
  app.listen(p, '127.0.0.1', () => console.log('HTTP_URL=http://localhost:' + p + '/'));
  return app;
}
