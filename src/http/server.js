// ABOUTME: Zero-dependency HTTP front door — REST over the core + serves the buildless web board.
// ABOUTME: Session-cookie auth for humans. createApp(db) returns an http.Server; startServer runs it.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, basename } from 'node:path';
import { openDb } from '../db/db.js';
import { createUser, getUserByEmail, getUserById, searchUsers, recentCollaborators } from '../auth/users.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, getSession, deleteSession } from '../auth/sessions.js';
import { createToken, listTokens, revokeToken, getTokenOwner } from '../auth/tokens.js';
import { createTeam, deleteTeam } from '../teams/teams.js';
import { listMembers, addMember, setRole, removeMember } from '../teams/memberships.js';
import { assertCan } from '../authz/authz.js';
import { createTask, getTask, listTasks, setResearch, setPlan, updateContent, transition, retryTask, rateTask } from '../tasks/tasks.js';
import { listEvents, appendEvent } from '../tasks/events.js';
import { requestReview, submitReview } from '../reviews/reviews.js';
import { requestInput, answerInput, getOpenInputRequest } from '../tasks/input_requests.js';
import { addComment, listComments } from '../tasks/comments.js';
import { enqueueWake, listPendingWakes } from '../executor/wake.js';
import { listRunsForTask } from '../executor/runs.js';
import { taskDebug } from '../tasks/debug.js';
import { listProjects, registerProject, detectProjectKey } from '../projects/projects.js';
import { createShareLink, listShareLinksForTask, revokeShareLink, getActiveShareLinkByToken, shareView } from '../share/share.js';
import { listPlanVersions, getPlanVersion } from '../plans/versions.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
const MCP_SERVER_PATH = resolve(here, '..', 'mcp', 'server.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function statusFor(code) {
  if (code === 'FORBIDDEN') return 403;
  if (code === 'BAD_CREDENTIALS' || code === 'NO_SESSION') return 401;
  if (code === 'EMAIL_TAKEN' || code === 'SLUG_TAKEN' || code === 'ILLEGAL_TRANSITION' || code === 'ALREADY_ANSWERED' || code === 'ALREADY_MEMBER') return 409;
  if (code === 'NO_TASK' || code === 'NO_REQUEST' || code === 'NOT_FOUND' || code === 'USER_NOT_FOUND') return 404;
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
  let fp = normalize(join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!existsSync(fp)) {
    // SPA fallback: client-side routes (no file extension, e.g. /t/<id>) get index.html so deep links and
    // refreshes work; a missing path that has an extension is a real 404.
    if (rel.includes('.')) { res.writeHead(404); return res.end('not found'); }
    fp = join(PUBLIC, 'index.html');
  }
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
  ['GET', '/api/teams/:id/members', true, async ({ db, res, params, user }) => {
    assertCan(db, user.id, 'team.read', { teamId: params.id });
    const members = listMembers(db, params.id).map((m) => {
      const u = getUserById(db, m.userId);
      return { userId: m.userId, displayName: u ? u.displayName : null, email: u ? u.email : null, role: m.role };
    });
    send(res, 200, { members });
  }],
  ['POST', '/api/teams/:id/members', true, async ({ db, res, params, body, user }) => {
    assertCan(db, user.id, 'members.manage', { teamId: params.id });
    // Add by explicit userId (from search / recent quick-add) or fall back to email lookup.
    const invitee = body.userId ? getUserById(db, body.userId) : getUserByEmail(db, body.email || '');
    if (!invitee) throw new Error('USER_NOT_FOUND');
    const m = addMember(db, { teamId: params.id, userId: invitee.id, role: body.role });
    send(res, 200, { member: { userId: m.userId, role: m.role } });
  }],
  ['PATCH', '/api/teams/:id/members/:userId', true, async ({ db, res, params, body, user }) => {
    assertCan(db, user.id, 'members.manage', { teamId: params.id });
    setRole(db, params.id, params.userId, body.role);
    send(res, 200, { ok: true });
  }],
  ['DELETE', '/api/teams/:id/members/:userId', true, async ({ db, res, params, user }) => {
    assertCan(db, user.id, 'members.manage', { teamId: params.id });
    removeMember(db, params.id, params.userId);
    send(res, 200, { ok: true });
  }],
  // Find people already on the platform to add to a team — a live typeahead (email or name). Excludes
  // yourself and, when excludeTeam is given, everyone already on that team.
  ['GET', '/api/users/search', true, async ({ db, req, res, user }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const excludeIds = [user.id];
    const excludeTeam = q.get('excludeTeam');
    if (excludeTeam) for (const m of listMembers(db, excludeTeam)) excludeIds.push(m.userId);
    send(res, 200, { users: searchUsers(db, q.get('q') || '', { excludeIds }) });
  }],
  // People you've recently worked with (share a team with you) — quick-add chips, no typing.
  ['GET', '/api/users/recent', true, async ({ db, req, res, user }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const excludeIds = [];
    const excludeTeam = q.get('excludeTeam');
    if (excludeTeam) for (const m of listMembers(db, excludeTeam)) excludeIds.push(m.userId);
    send(res, 200, { users: recentCollaborators(db, user.id, { excludeIds }) });
  }],
  ['DELETE', '/api/teams/:id', true, async ({ db, res, params, user }) => {
    assertCan(db, user.id, 'team.delete', { teamId: params.id });
    deleteTeam(db, params.id);
    send(res, 200, { ok: true });
  }],
  ['GET', '/api/tasks', true, async ({ db, req, res }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { tasks: listTasks(db, { scope: q.get('scope') || undefined, teamId: q.get('teamId') || undefined, status: q.get('status') || undefined }) });
  }],
  ['GET', '/api/projects', true, async ({ db, res }) => send(res, 200, { projects: listProjects(db) })],
  // Server-side directory browser for the "add a repo" folder picker (the board runs on the user's
  // machine, so browsing the server FS = browsing their folders). Lists subdirectories only, flags git repos.
  ['GET', '/api/fs/dirs', true, async ({ req, res }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    let p = q.get('path') || homedir();
    if (p.startsWith('~')) p = homedir() + p.slice(1);
    p = resolve(p);
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: join(p, d.name), isRepo: existsSync(join(p, d.name, '.git')) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw new Error('NO_SUCH_PATH');
    }
    const parent = dirname(p);
    send(res, 200, { path: p, parent: parent !== p ? parent : null, isRepo: existsSync(join(p, '.git')), entries });
  }],
  ['POST', '/api/projects', true, async ({ db, res, body, user }) => {
    // Register a git repo on this machine from the dashboard (the board's answer to `be10x link`):
    // validate the path, register it, and write its .be10x/mcp.json so the spawned agent gets gfa_* tools.
    let p = String(body.path || '').trim();
    if (!p) throw new Error('MISSING_FIELD:path');
    if (p.startsWith('~')) p = homedir() + p.slice(1);
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error('NO_SUCH_PATH');
    if (!existsSync(join(abs, '.git'))) throw new Error('NOT_A_GIT_REPO');
    const { key, rootPath, defaultBranch } = detectProjectKey(abs);
    const project = registerProject(db, { key, name: body.name || basename(rootPath), rootPath, defaultBranch });
    const { token } = createToken(db, user.id, 'ui:' + key);
    const dir = join(rootPath, '.be10x');
    mkdirSync(dir, { recursive: true });
    const cfg = {
      mcpServers: { be10x: { command: 'node', args: [MCP_SERVER_PATH], env: { GFA_TOKEN: token, GFA_DB_PATH: resolve(process.env.GFA_DB_PATH || './gfa.db') } } },
    };
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify(cfg, null, 2) + '\n');
    send(res, 200, { project });
  }],
  ['POST', '/api/tasks', true, async ({ db, res, body, user }) => {
    // Orchestration inputs: which repo (projectId), isolation (worktree|branch, stored on content so the
    // executor can honor it), and whether to start the agent planning immediately (handOff).
    const content = { ...(body.content || {}) };
    if (body.isolation) content.isolation = body.isolation;
    let task = createTask(db, {
      type: body.type, scope: body.scope, title: body.title, ownerId: user.id,
      content, teamId: body.teamId || null, projectId: body.projectId || null, severity: body.severity || 'medium',
    });
    if (body.handOff) {
      transition(db, task.id, 'researching', user.id, { handOff: true });
      enqueueWake(db, task.id, 'plan');
      task = getTask(db, task.id);
    }
    send(res, 200, { task });
  }],
  ['GET', '/api/tasks/:id', true, async ({ db, res, params }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    send(res, 200, { task: t });
  }],
  ['GET', '/api/tasks/:id/events', true, async ({ db, res, params }) => send(res, 200, { events: listEvents(db, params.id) })],
  ['GET', '/api/tasks/:id/runs', true, async ({ db, res, params }) => send(res, 200, { runs: listRunsForTask(db, params.id) })],
  // A consolidated raw snapshot behind the debug button: live agent status, runs, wake queue, events.
  ['GET', '/api/tasks/:id/debug', true, async ({ db, res, params }) => {
    const dbg = taskDebug(db, params.id);
    if (!dbg) return send(res, 404, { error: 'NO_SUCH_TASK' });
    send(res, 200, dbg);
  }],
  // Pending (unclaimed) wakes for a task — the "queued work" indicator. A lightweight cut of the debug
  // snapshot so the task view can poll it cheaply and show what the agent will pick up on its next run.
  ['GET', '/api/tasks/:id/wakes', true, async ({ db, res, params }) => {
    send(res, 200, { wakes: listPendingWakes(db, params.id).map((w) => ({ ...w, pending: true })) });
  }],
  ['POST', '/api/tasks/:id/transition', true, async ({ db, res, params, body, user }) => {
    const task = transition(db, params.id, body.to, user.id);
    // A drag that hands the task to the agent (→researching) or approves it (→ready_to_work) wakes it.
    if (body.to === 'researching') enqueueWake(db, params.id, 'plan');
    else if (body.to === 'ready_to_work') enqueueWake(db, params.id, 'execute');
    send(res, 200, { task });
  }],
  ['POST', '/api/tasks/:id/plan', true, async ({ db, res, params, body, user }) => send(res, 200, { task: setPlan(db, params.id, body.plan, user.id) })],
  // Plan history: list past snapshots (newest-first), or restore one (re-sets it as the current plan,
  // which itself snapshots a fresh version).
  ['GET', '/api/tasks/:id/plan-versions', true, async ({ db, res, params }) => send(res, 200, { versions: listPlanVersions(db, params.id) })],
  ['POST', '/api/tasks/:id/plan-versions/:versionId/restore', true, async ({ db, res, params, user }) => {
    const version = getPlanVersion(db, params.versionId);
    if (!version) throw new Error('NOT_FOUND');
    send(res, 200, { task: setPlan(db, params.id, version.plan, user.id) });
  }],
  ['POST', '/api/tasks/:id/research', true, async ({ db, res, params, body, user }) => send(res, 200, { task: setResearch(db, params.id, body.research, user.id) })],
  ['POST', '/api/tasks/:id/content', true, async ({ db, res, params, body, user }) => send(res, 200, { task: updateContent(db, params.id, body.patch || {}, user.id) })],
  ['POST', '/api/tasks/:id/rate', true, async ({ db, res, params, body, user }) => send(res, 200, { task: rateTask(db, params.id, body.rating, user.id) })],
  ['POST', '/api/tasks/:id/retry', true, async ({ db, res, params, user }) => send(res, 200, { task: retryTask(db, params.id, user.id) })],
  ['POST', '/api/tasks/:id/review/request', true, async ({ db, res, params, body, user }) => send(res, 200, { task: requestReview(db, params.id, body.reviewerId, user.id) })],
  ['POST', '/api/tasks/:id/review/submit', true, async ({ db, res, params, body, user }) => {
    const review = submitReview(db, params.id, user.id, body.verdict, body.comment || '');
    // Approval wakes the agent to implement; requested changes wake it to revise the plan.
    if (review.verdict === 'approved') enqueueWake(db, params.id, 'execute', { review: 'approved' });
    else enqueueWake(db, params.id, 'revise', { verdict: 'changes_requested', comment: body.comment || '' });
    send(res, 200, { review });
  }],
  ['GET', '/api/reviews/pending', true, async ({ db, res, user }) => send(res, 200, { tasks: listTasks(db, { status: 'plan_review' }).filter((t) => t.reviewerId === user.id) })],
  ['POST', '/api/tasks/:id/hand-to-agent', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    if (t.status === 'backlog') transition(db, params.id, 'researching', user.id, { handOff: true });
    enqueueWake(db, params.id, 'plan');
    send(res, 200, { task: getTask(db, params.id) });
  }],
  ['POST', '/api/tasks/:id/pick-up-now', true, async ({ db, res, params }) => {
    if (!getTask(db, params.id)) throw new Error('NO_TASK');
    send(res, 200, { ok: true, wake: enqueueWake(db, params.id, 'pick_up_now') });
  }],
  ['GET', '/api/tasks/:id/comments', true, async ({ db, res, params }) => send(res, 200, { comments: listComments(db, params.id) })],
  ['POST', '/api/tasks/:id/comments', true, async ({ db, res, params, body, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    const comment = addComment(db, params.id, { author: user.id, body: body.body, anchor: body.anchor });
    // A comment wakes the agent to address it — in every active state (revise the plan under review,
    // otherwise pick it up). Only genuinely-closed states (backlog awaiting hand-off, done/terminal) skip.
    if (['plan_review', 'researching', 'ready_to_work', 'in_progress', 'needs_input', 'verifying'].includes(task.status)) {
      enqueueWake(db, params.id, task.status === 'plan_review' ? 'revise' : 'pick_up_now', { comment: body.body });
    }
    send(res, 200, { comment });
  }],
  ['POST', '/api/tasks/:id/input/request', true, async ({ db, res, params, body, user }) => send(res, 200, { inputRequest: requestInput(db, params.id, body.question, { choices: body.choices || null, allowCustom: body.allowCustom !== false }, user.id) })],
  ['GET', '/api/tasks/:id/input', true, async ({ db, res, params }) => send(res, 200, { inputRequest: getOpenInputRequest(db, params.id) })],
  ['POST', '/api/input/:reqId/answer', true, async ({ db, res, params, body, user }) => {
    const row = db.prepare('SELECT task_id AS taskId FROM input_requests WHERE id = ?').get(params.reqId);
    answerInput(db, params.reqId, body.answer, user.id);
    if (row) enqueueWake(db, row.taskId, 'input_answer', { answer: body.answer }); // resume the paused agent
    send(res, 200, { ok: true });
  }],

  // --- Shareable, permissioned plan-review links --------------------------------------------------
  // Owner-only (authRequired): mint / list / revoke a task's share links.
  ['POST', '/api/tasks/:id/share', true, async ({ db, res, params, body, user }) => {
    if (!getTask(db, params.id)) throw new Error('NO_TASK');
    const share = createShareLink(db, { taskId: params.id, permission: body.permission, createdBy: user.id });
    send(res, 200, { share });
  }],
  ['GET', '/api/tasks/:id/shares', true, async ({ db, res, params }) => send(res, 200, { shares: listShareLinksForTask(db, params.id) })],
  ['DELETE', '/api/share/:token', true, async ({ db, res, params }) => {
    if (!revokeShareLink(db, params.token)) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    send(res, 200, { ok: true });
  }],
  // Public (no session): the bearer of the token is the credential. View is always allowed; comment and
  // review need only a live token; run-agent additionally needs the 'run_agent' permission.
  ['GET', '/api/share/:token', false, async ({ db, res, params }) => {
    const view = shareView(db, params.token);
    if (!view) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    send(res, 200, view);
  }],
  ['POST', '/api/share/:token/comment', false, async ({ db, res, params, body }) => {
    const link = getActiveShareLinkByToken(db, params.token);
    if (!link) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    const comment = addComment(db, link.task_id, { author: body.author || 'guest', body: body.body });
    send(res, 200, { comment });
  }],
  ['POST', '/api/share/:token/review', false, async ({ db, res, params, body }) => {
    const link = getActiveShareLinkByToken(db, params.token);
    if (!link) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    const author = body.author || 'guest';
    appendEvent(db, link.task_id, author, 'review', { verdict: body.verdict, by: author, comment: body.comment, via: 'share' });
    if (body.comment) addComment(db, link.task_id, { author, body: body.comment });
    send(res, 200, { ok: true });
  }],
  ['POST', '/api/share/:token/run-agent', false, async ({ db, res, params, body }) => {
    const link = getActiveShareLinkByToken(db, params.token);
    if (!link) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    if (link.permission !== 'run_agent') return send(res, 403, { error: 'FORBIDDEN' });
    const author = body.author || 'guest';
    if (body.message) addComment(db, link.task_id, { author, body: body.message });
    const wake = enqueueWake(db, link.task_id, 'pick_up_now', { via: 'share', author });
    send(res, 200, { ok: true, wake });
  }],
  ['POST', '/api/tokens', true, async ({ db, res, body, user }) => send(res, 200, { token: createToken(db, user.id, body.name || 'agent') })],
  ['GET', '/api/tokens', true, async ({ db, res, user }) => send(res, 200, { tokens: listTokens(db, user.id) })],
  ['DELETE', '/api/tokens/:id', true, async ({ db, res, params, user }) => {
    if (getTokenOwner(db, params.id) !== user.id) throw new Error('NOT_FOUND');
    revokeToken(db, params.id);
    send(res, 200, { ok: true });
  }],
  ['GET', '/api/agent-config', true, async ({ res }) => send(res, 200, { mcpServerPath: MCP_SERVER_PATH, dbPath: process.env.GFA_DB_PATH || './gfa.db' })],
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

export function startServer({ db, dbPath, port, host } = {}) {
  db = db || openDb(process.env.GFA_DB_PATH || dbPath || './gfa.db');
  const app = createApp(db);
  const p = Number(port || process.env.PORT || 4600);
  // Bind host: 127.0.0.1 (default, local only) or 0.0.0.0 (GFA_HOST / --host) to share on the network.
  const h = host || process.env.GFA_HOST || '127.0.0.1';
  // Fail with a clear, actionable message instead of an unhandled EADDRINUSE stack trace.
  app.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(
        `be10x: port ${p} is already in use (another be10x server is probably running).\n` +
          `  free it:        lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill\n` +
          `  or use another: be10x serve --port ${p + 1}`
      );
    } else {
      console.error('be10x server error: ' + String(err?.message ?? err));
    }
    process.exit(1);
  });
  app.listen(p, h, () => {
    console.log('HTTP_URL=http://' + (h === '0.0.0.0' ? 'localhost' : h) + ':' + p + '/');
    if (h === '0.0.0.0') console.log('  (shared: teammates reach it at http://<this-machine-ip>:' + p + '/)');
  });
  return app;
}
