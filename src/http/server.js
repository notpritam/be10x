// ABOUTME: Zero-dependency HTTP front door — REST over the core + serves the buildless web board.
// ABOUTME: Session-cookie auth for humans. createApp(db) returns an http.Server; startServer runs it.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, basename } from 'node:path';
import { openDb } from '../db/db.js';
import { createUser, getUserByEmail, getUserById, searchUsers, recentCollaborators } from '../auth/users.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, getSession, deleteSession } from '../auth/sessions.js';
import { createToken, listTokens, revokeToken, getTokenOwner, verifyToken } from '../auth/tokens.js';
import { createDeviceCode, getByUserCode, approveDeviceCode, denyDeviceCode, pollDeviceToken } from '../auth/device.js';
import { getTool } from '../mcp/tools.js';
import { dispatchBugTool } from '../mcp/bug-tools.js';
import { createTeam, deleteTeam } from '../teams/teams.js';
import { listMembers, addMember, setRole, removeMember } from '../teams/memberships.js';
import { assertCan, assertCanAccessTask, canAccessProject, assertCanAccessBug } from '../authz/authz.js';
import { createTask, getTask, listTasksForUser, setResearch, setPlan, updateContent, transition, retryTask, rateTask, archiveTask, resolveTaskId } from '../tasks/tasks.js';
import { listEvents, appendEvent } from '../tasks/events.js';
import { createBug, getBug as getBugById, getBugByHumanId, listBugs, updateBugStatus, setBugAssignee, setBugLlmAnalysis, setBugGithubIssue, addBugComment, listBugEvents, bugStatsForUser, linkBugToTask, listBugsForTask, unlinkBugFromTask, linkedBugSummary } from '../bugs/bugs.js';
import { handoffBugToTask } from '../bugs/handoff.js';
import { analyzeBug } from '../bugs/analyze.js';
import { llmAnalyzeBug } from '../bugs/llm-analyze.js';
import { createGithubIssue } from '../bugs/github-export.js';
import { notifyBugFiled } from '../bugs/notify.js';
import { mintUploadUrls, signAccessUrl } from '../bugs/uploadthing.js';
import { requestReview, submitReview } from '../reviews/reviews.js';
import { requestInput, answerInput, getOpenInputRequest, getRequestTaskId } from '../tasks/input_requests.js';
import { addComment, listComments } from '../tasks/comments.js';
import { enqueueWake, getWake, claimNextWakeForKeys } from '../executor/wake.js';
import { listRunsForTask, createRun, finishRun, setRunSession, getLatestRunForTask } from '../executor/runs.js';
import { prepareWake, settleWake } from '../runner/runner.js';
import { taskDebug } from '../tasks/debug.js';
import { listProjectsForUser, registerProject, detectProjectKey, getProject } from '../projects/projects.js';
import { createShareLink, listShareLinksForTask, revokeShareLink, getActiveShareLinkByToken, shareView } from '../share/share.js';
import { createBugShareLink, listBugShareLinksForBug, revokeBugShareLink, getActiveBugShareByToken, bugShareView } from '../share/bug-share.js';
import { listPlanVersions, getPlanVersion } from '../plans/versions.js';
import { recordTelemetryBatch } from '../telemetry/store.js';
import { adminOverview, listUsersForAdmin, userDetailForAdmin } from '../admin/admin.js';
import { leaderboard, startOfCurrentMonthMs } from '../leaderboard/leaderboard.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
const MCP_SERVER_PATH = resolve(here, '..', 'mcp', 'server.js');
// The board's own version (from package.json) — served publicly at /api/version so a connector can tell when
// its CLI is behind and prompt `be10x update`.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// Append "; Secure" to the session cookie in HTTPS deploys (behind a TLS-terminating proxy like Caddy).
// Off by default so http://localhost dev keeps working; set GFA_SECURE_COOKIES=1 in any hosted deploy.
const SECURE_COOKIE = process.env.GFA_SECURE_COOKIES ? '; Secure' : '';

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

// The board's own public origin, honoring a TLS-terminating proxy (Render/Caddy set x-forwarded-*). Used to
// build the `be10x login` approve URL so the CLI opens the right host (e.g. https://be10x.notpritam.in),
// whether the board runs on localhost or behind a proxy.
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}

// Bearer-token auth for the agent/runner API (/api/agent/*). An agent running on a MEMBER's own machine
// authenticates with a personal access token (minted by `be10x token` / the dashboard) instead of the
// human session cookie. Returns the auth ctx { userId, tokenId } — the same shape the stdio MCP server
// hands each tool handler — or null.
function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}
function agentAuth(db, req) {
  const tok = bearerToken(req);
  return tok ? verifyToken(db, tok) : null;
}

// Gate for the internal telemetry-viewer endpoint below: a single shared secret (GFA_ADMIN_TOKEN),
// not a per-user account — there's no platform "admin" role, and this data (which can include
// task content) is meant to be visible only to whoever holds that secret. Unset entirely by
// default, so the endpoint is off unless someone deliberately turns it on. A timing-safe compare
// (constant-time regardless of where the strings first differ) since this guards a real secret.
function validAdminToken(req) {
  const configured = process.env.GFA_ADMIN_TOKEN;
  if (!configured) return false;
  const provided = bearerToken(req);
  if (!provided) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
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
  const isHead = req.method === 'HEAD';
  let rel = new URL(req.url, 'http://x').pathname;
  if (rel === '/') rel = '/index.html';
  let fp = normalize(join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!existsSync(fp)) {
    // SPA fallback: client-side routes (no file extension, e.g. /t/<id>) get index.html so deep links and
    // refreshes work; a missing path that has an extension is a real 404 (with an explicit Content-Type so
    // a browser never mis-sniffs the miss as a stylesheet/script).
    if (rel.includes('.')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(isHead ? undefined : 'not found'); }
    fp = join(PUBLIC, 'index.html');
  }
  const ext = fp.slice(fp.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  // HEAD (proxies, preloaders, uptime checks) gets the same headers with no body.
  res.end(isHead ? undefined : readFileSync(fp));
}

// A bug_shares row (snake_case, from bug-share.js) mapped to the camelCase shape the web client consumes.
function toBugShare(r) {
  return { id: r.id, token: r.token, createdAt: r.created_at, revokedAt: r.revoked_at, createdBy: r.created_by };
}

// Resolve a bug reference the way a human pastes it — a raw uuid or a human id (BUG-009) — to the hydrated
// bug, or null. Used by the task↔bug attach routes so a person can link `BUG-9` without knowing the uuid.
function resolveBugRef(db, ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (!s) return null;
  if (/^BUG-\d+$/i.test(s)) return getBugByHumanId(db, s);
  return getBugById(db, s);
}

// Route table: [method, pattern, needsAuth, handler(ctx)] where ctx = { db, req, res, params, body, user }
const ROUTES = [
  ['POST', '/api/auth/signup', false, async ({ db, res, body }) => {
    const user = createUser(db, { email: body.email, displayName: body.displayName, password: body.password });
    const s = createSession(db, user.id);
    res.setHeader('Set-Cookie', `gfa_sid=${s.id}; HttpOnly; SameSite=Lax; Path=/${SECURE_COOKIE}`);
    send(res, 200, { user });
  }],
  ['POST', '/api/auth/login', false, async ({ db, res, body }) => {
    const row = getUserByEmail(db, body.email || '');
    if (!row || !verifyPassword(body.password || '', row.passwordHash)) throw new Error('BAD_CREDENTIALS');
    const s = createSession(db, row.id);
    res.setHeader('Set-Cookie', `gfa_sid=${s.id}; HttpOnly; SameSite=Lax; Path=/${SECURE_COOKIE}`);
    send(res, 200, { user: { id: row.id, email: row.email, displayName: row.displayName } });
  }],
  ['POST', '/api/auth/logout', false, async ({ db, req, res }) => {
    const sid = cookies(req).gfa_sid;
    if (sid) deleteSession(db, sid);
    res.setHeader('Set-Cookie', `gfa_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE}`);
    send(res, 200, { ok: true });
  }],
  ['GET', '/api/version', false, async ({ res }) => send(res, 200, { version: VERSION })],
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
  ['GET', '/api/tasks', true, async ({ db, req, res, user }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { tasks: listTasksForUser(db, user.id, { scope: q.get('scope') || undefined, teamId: q.get('teamId') || undefined, status: q.get('status') || undefined }) });
  }],
  ['GET', '/api/projects', true, async ({ db, res, user }) => send(res, 200, { projects: listProjectsForUser(db, user.id) })],
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
    // Personal by default; an explicit teamId (the "Add a repository" flow passes the current team view)
    // shares it with that team instead — the caller must already be at least a member there.
    let p = String(body.path || '').trim();
    if (!p) throw new Error('MISSING_FIELD:path');
    if (p.startsWith('~')) p = homedir() + p.slice(1);
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error('NO_SUCH_PATH');
    if (!existsSync(join(abs, '.git'))) throw new Error('NOT_A_GIT_REPO');
    const teamId = body.teamId || null;
    if (teamId) assertCan(db, user.id, 'task.create', { teamId });
    const { key, rootPath, defaultBranch } = detectProjectKey(abs);
    const project = registerProject(db, { key, name: body.name || basename(rootPath), rootPath, defaultBranch, ownerId: user.id, teamId });
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
    const teamId = body.teamId || null;
    if (teamId) assertCan(db, user.id, 'task.create', { teamId });
    const projectId = body.projectId || null;
    if (projectId && !canAccessProject(db, user.id, getProject(db, projectId))) throw new Error('FORBIDDEN');
    const content = { ...(body.content || {}) };
    if (body.isolation) content.isolation = body.isolation;
    // Optional: attach existing filed bug(s) to the new task (uuid or BUG-009). Resolve + authorize each
    // BEFORE creating, so a bad/forbidden id never leaves an orphaned task; then link them after create.
    const bugsToLink = (Array.isArray(body.bugIds) ? body.bugIds : []).map((ref) => {
      const bug = resolveBugRef(db, ref);
      if (!bug) throw new Error('NOT_FOUND');
      assertCanAccessBug(db, user.id, bug);
      return bug;
    });
    let task = createTask(db, {
      type: body.type, scope: body.scope, title: body.title, ownerId: user.id,
      content, teamId, projectId, severity: body.severity || 'medium',
    });
    for (const bug of bugsToLink) linkBugToTask(db, bug.id, task.id, user.id);
    if (body.handOff) {
      transition(db, task.id, 'researching', user.id, { handOff: true });
      enqueueWake(db, task.id, 'plan');
      task = getTask(db, task.id);
    }
    send(res, 200, { task });
  }],
  ['GET', '/api/tasks/:id', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t);
    send(res, 200, { task: t });
  }],
  ['GET', '/api/tasks/:id/events', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t);
    send(res, 200, { events: listEvents(db, params.id) });
  }],
  // --- task ↔ bug links (attach an extension-filed bug to a task, from the TASK side) --------------------
  // List the bugs linked to a task (read access), attach one (task.update + the bug must be visible to the
  // caller), or detach one. Attach accepts a uuid or a human id (BUG-009). Segment counts keep these apart
  // under match(): /api/tasks/:id/bugs (5) vs /api/tasks/:id/bugs/:bugId (6), both distinct from the other
  // task sub-routes by the literal "bugs" segment.
  ['GET', '/api/tasks/:id/bugs', true, async ({ db, res, params, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, task);
    send(res, 200, { bugs: listBugsForTask(db, params.id) });
  }],
  ['POST', '/api/tasks/:id/bugs', true, async ({ db, res, params, body, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, task, 'task.update');
    const bug = resolveBugRef(db, body.bugId);
    if (!bug) throw new Error('NOT_FOUND');
    assertCanAccessBug(db, user.id, bug);
    send(res, 200, { bug: linkBugToTask(db, bug.id, params.id, user.id) });
  }],
  ['DELETE', '/api/tasks/:id/bugs/:bugId', true, async ({ db, res, params, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, task, 'task.update');
    const bug = resolveBugRef(db, params.bugId);
    // Only detach a bug that is actually linked to THIS task — otherwise it's a 404 (not linked here).
    if (!bug || bug.taskId !== params.id) throw new Error('NOT_FOUND');
    send(res, 200, { bug: unlinkBugFromTask(db, bug.id, user.id) });
  }],
  ['GET', '/api/tasks/:id/runs', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t);
    send(res, 200, { runs: listRunsForTask(db, params.id) });
  }],
  // A consolidated raw snapshot behind the debug button: live agent status, runs, wake queue, events.
  ['GET', '/api/tasks/:id/debug', true, async ({ db, res, params, user }) => {
    const dbg = taskDebug(db, params.id);
    if (!dbg) return send(res, 404, { error: 'NO_SUCH_TASK' });
    assertCanAccessTask(db, user.id, dbg.task);
    send(res, 200, dbg);
  }],
  ['POST', '/api/tasks/:id/transition', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    const task = transition(db, params.id, body.to, user.id);
    // A drag that hands the task to the agent (→researching) or approves it (→ready_to_work) wakes it.
    if (body.to === 'researching') enqueueWake(db, params.id, 'plan');
    else if (body.to === 'ready_to_work') enqueueWake(db, params.id, 'execute');
    send(res, 200, { task });
  }],
  // Soft-archive a task from any stage. The row is kept (bug links + history survive) — only the status
  // flips to 'archived'. Disk GC does NOT happen here: a hosted board can't reach the connector's disk, so
  // the returned `worktrees` (the real run paths+branches) travel back for the CLI/connector to reclaim
  // (see gcTaskWorktrees). Modeled on the transition route: load, authorize with 'task.update', mutate.
  ['POST', '/api/tasks/:id/archive', true, async ({ db, res, params, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    const { task, worktrees } = archiveTask(db, params.id, user.id);
    send(res, 200, { task, worktrees });
  }],
  ['POST', '/api/tasks/:id/plan', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: setPlan(db, params.id, body.plan, user.id) });
  }],
  // Plan history: list past snapshots (newest-first), or restore one (re-sets it as the current plan,
  // which itself snapshots a fresh version).
  ['GET', '/api/tasks/:id/plan-versions', true, async ({ db, res, params, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing);
    send(res, 200, { versions: listPlanVersions(db, params.id) });
  }],
  ['POST', '/api/tasks/:id/plan-versions/:versionId/restore', true, async ({ db, res, params, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    const version = getPlanVersion(db, params.versionId);
    if (!version) throw new Error('NOT_FOUND');
    send(res, 200, { task: setPlan(db, params.id, version.plan, user.id) });
  }],
  ['POST', '/api/tasks/:id/research', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: setResearch(db, params.id, body.research, user.id) });
  }],
  ['POST', '/api/tasks/:id/content', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: updateContent(db, params.id, body.patch || {}, user.id) });
  }],
  ['POST', '/api/tasks/:id/rate', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: rateTask(db, params.id, body.rating, user.id) });
  }],
  ['POST', '/api/tasks/:id/retry', true, async ({ db, res, params, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: retryTask(db, params.id, user.id) });
  }],
  ['POST', '/api/tasks/:id/review/request', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { task: requestReview(db, params.id, body.reviewerId, user.id) });
  }],
  ['POST', '/api/tasks/:id/review/submit', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    // The rank-based check isn't the right gate here — only the specific person tagged as reviewer may
    // submit that review, not just any team member with sufficient rank.
    if (existing.reviewerId !== user.id) throw new Error('FORBIDDEN');
    const review = submitReview(db, params.id, user.id, body.verdict, body.comment || '');
    // Approval wakes the agent to implement; requested changes wake it to revise the plan.
    if (review.verdict === 'approved') enqueueWake(db, params.id, 'execute', { review: 'approved' });
    else enqueueWake(db, params.id, 'revise', { verdict: 'changes_requested', comment: body.comment || '' });
    send(res, 200, { review });
  }],
  ['GET', '/api/reviews/pending', true, async ({ db, res, user }) => send(res, 200, { tasks: listTasksForUser(db, user.id, { status: 'plan_review' }).filter((t) => t.reviewerId === user.id) })],
  ['POST', '/api/tasks/:id/hand-to-agent', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t, 'task.update');
    if (t.status === 'backlog') transition(db, params.id, 'researching', user.id, { handOff: true });
    enqueueWake(db, params.id, 'plan');
    send(res, 200, { task: getTask(db, params.id) });
  }],
  ['POST', '/api/tasks/:id/pick-up-now', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t, 'task.update');
    send(res, 200, { ok: true, wake: enqueueWake(db, params.id, 'pick_up_now') });
  }],
  ['GET', '/api/tasks/:id/comments', true, async ({ db, res, params, user }) => {
    const t = getTask(db, params.id);
    if (!t) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, t);
    send(res, 200, { comments: listComments(db, params.id) });
  }],
  ['POST', '/api/tasks/:id/comments', true, async ({ db, res, params, body, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, task, 'task.update');
    const comment = addComment(db, params.id, { author: user.id, body: body.body, anchor: body.anchor });
    // A comment wakes the agent to address it — in every active state (revise the plan under review,
    // otherwise pick it up). Only genuinely-closed states (backlog awaiting hand-off, done/terminal) skip.
    if (['plan_review', 'researching', 'ready_to_work', 'in_progress', 'needs_input', 'verifying'].includes(task.status)) {
      enqueueWake(db, params.id, task.status === 'plan_review' ? 'revise' : 'pick_up_now', { comment: body.body });
    }
    send(res, 200, { comment });
  }],
  ['POST', '/api/tasks/:id/input/request', true, async ({ db, res, params, body, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing, 'task.update');
    send(res, 200, { inputRequest: requestInput(db, params.id, body.question, { choices: body.choices || null, allowCustom: body.allowCustom !== false }, user.id) });
  }],
  ['GET', '/api/tasks/:id/input', true, async ({ db, res, params, user }) => {
    const existing = getTask(db, params.id);
    if (!existing) throw new Error('NO_TASK');
    assertCanAccessTask(db, user.id, existing);
    send(res, 200, { inputRequest: getOpenInputRequest(db, params.id) });
  }],
  ['POST', '/api/input/:reqId/answer', true, async ({ db, res, params, body, user }) => {
    const taskId = getRequestTaskId(db, params.reqId);
    if (taskId) {
      const existing = getTask(db, taskId);
      if (existing) assertCanAccessTask(db, user.id, existing, 'task.update');
    }
    answerInput(db, params.reqId, body.answer, user.id);
    if (taskId) enqueueWake(db, taskId, 'input_answer', { answer: body.answer }); // resume the paused agent
    send(res, 200, { ok: true });
  }],

  // --- Shareable, permissioned plan-review links --------------------------------------------------
  // Owner-only (authRequired): mint / list / revoke a task's share links. Strictly the task's owner, not
  // just any team member — a share link hands an outsider real access (up to running the agent).
  ['POST', '/api/tasks/:id/share', true, async ({ db, res, params, body, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    if (task.ownerId !== user.id) throw new Error('FORBIDDEN');
    const share = createShareLink(db, { taskId: params.id, permission: body.permission, createdBy: user.id });
    send(res, 200, { share });
  }],
  ['GET', '/api/tasks/:id/shares', true, async ({ db, res, params, user }) => {
    const task = getTask(db, params.id);
    if (!task) throw new Error('NO_TASK');
    if (task.ownerId !== user.id) throw new Error('FORBIDDEN');
    send(res, 200, { shares: listShareLinksForTask(db, params.id) });
  }],
  ['DELETE', '/api/share/:token', true, async ({ db, res, params, user }) => {
    const link = getActiveShareLinkByToken(db, params.token);
    if (!link) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    const task = getTask(db, link.task_id);
    if (!task || task.ownerId !== user.id) throw new Error('FORBIDDEN');
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
  // --- device authorization (`be10x login`) ---------------------------------------------------------------
  // The CLI mints a code (public — it has no session yet); the user approves the short code in the board UI
  // (session-authed, so the token binds to their account); the CLI polls for the token holding the
  // unguessable device_code. Mirrors OAuth device flow so login is a paste-free browser round-trip.
  ['POST', '/api/device/code', false, async ({ db, req, res, body }) => {
    const { deviceCode, userCode, expiresAt, interval } = createDeviceCode(db, {
      label: body.label ? String(body.label).slice(0, 80) : null,
    });
    const origin = originOf(req);
    send(res, 200, {
      deviceCode,
      userCode,
      interval,
      expiresIn: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
      verificationUri: origin + '/connect',
      verificationUriComplete: origin + '/connect?code=' + encodeURIComponent(userCode),
    });
  }],
  ['POST', '/api/device/token', false, async ({ db, res, body }) => {
    if (!body.deviceCode) throw new Error('MISSING_FIELD:deviceCode');
    send(res, 200, pollDeviceToken(db, String(body.deviceCode)));
  }],
  // The approve screen fetches this to show WHAT is asking (machine label) before the user authorizes.
  ['GET', '/api/device/pending', true, async ({ db, req, res }) => {
    const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
    const row = getByUserCode(db, code);
    if (!row) throw new Error('NOT_FOUND');
    send(res, 200, {
      userCode: row.user_code,
      label: row.label,
      status: row.expires_at < Date.now() ? 'expired' : row.status,
      createdAt: row.created_at,
    });
  }],
  ['POST', '/api/device/approve', true, async ({ db, res, body, user }) =>
    send(res, 200, approveDeviceCode(db, { userCode: body.code || body.userCode, userId: user.id }))],
  ['POST', '/api/device/deny', true, async ({ db, res, body, user }) =>
    send(res, 200, denyDeviceCode(db, { userCode: body.code || body.userCode, userId: user.id }))],
  ['GET', '/api/agent-config', true, async ({ res }) => send(res, 200, { mcpServerPath: MCP_SERVER_PATH, dbPath: process.env.GFA_DB_PATH || './gfa.db' })],

  // Opt-in CLI telemetry (see docs/superpowers/specs/2026-07-03-cli-telemetry-consent-design.md).
  // Public — a fresh CLI install has no session — and deliberately not tied to a platform
  // account; installId is a random per-machine id the CLI generates locally.
  ['POST', '/api/telemetry', false, async ({ db, res, body }) => {
    const result = recordTelemetryBatch(db, body);
    send(res, 200, { ok: true, ...result });
  }],
  // Internal viewer for the collected telemetry — off unless GFA_ADMIN_TOKEN is set on this
  // deploy, and even then requires that exact bearer token. Returns a bare 404 (not 401/403) on
  // any auth failure so an unauthenticated caller can't tell the route exists at all.
  ['GET', '/api/telemetry', false, async ({ db, req, res }) => {
    if (!validAdminToken(req)) return send(res, 404, { error: 'NOT_FOUND' });
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 500);
    const installId = q.get('installId');
    // received_at is shared by every event in one batch, so it alone can't order events recorded
    // together — occurred_at (the CLI's own timestamp for each event) breaks the tie.
    const sql =
      'SELECT id, install_id AS installId, event, cli_version AS cliVersion, os, node_version AS nodeVersion, payload_json AS payloadJson, occurred_at AS occurredAt, received_at AS receivedAt FROM telemetry_events' +
      (installId ? ' WHERE install_id = ?' : '') +
      ' ORDER BY received_at DESC, occurred_at DESC LIMIT ?';
    const rows = installId ? db.prepare(sql).all(installId, limit) : db.prepare(sql).all(limit);
    send(res, 200, {
      events: rows.map(({ payloadJson, ...row }) => {
        let payload;
        try {
          payload = JSON.parse(payloadJson);
        } catch {
          payload = {};
        }
        return { ...row, ...payload };
      }),
    });
  }],

  // --- admin dashboard (see docs/superpowers/specs/2026-07-03-admin-dashboard-leaderboard-design.md) ---
  // Same GFA_ADMIN_TOKEN gate as the telemetry viewer above — a bare 404 on any auth failure.
  ['GET', '/api/admin/overview', false, async ({ db, req, res }) => {
    if (!validAdminToken(req)) return send(res, 404, { error: 'NOT_FOUND' });
    send(res, 200, adminOverview(db));
  }],
  ['GET', '/api/admin/users', false, async ({ db, req, res }) => {
    if (!validAdminToken(req)) return send(res, 404, { error: 'NOT_FOUND' });
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { users: listUsersForAdmin(db, { q: q.get('q') || '', limit: q.get('limit') }) });
  }],
  ['GET', '/api/admin/users/:id', false, async ({ db, req, res, params }) => {
    if (!validAdminToken(req)) return send(res, 404, { error: 'NOT_FOUND' });
    const detail = userDetailForAdmin(db, params.id);
    if (!detail) return send(res, 404, { error: 'NOT_FOUND' });
    send(res, 200, detail);
  }],

  // Public leaderboard — always-on platform data (tasks completed + tokens through be10x), not
  // gated behind the opt-in CLI telemetry flag (see the design doc). scope=all needs no session;
  // scope=team:<id> does, so an outsider can't probe a team's roster by guessing its id.
  // period=month|all (default all) additionally scopes the ranking to the current calendar month.
  ['GET', '/api/leaderboard', false, async ({ db, req, res, user }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const scope = q.get('scope') || 'all';
    const period = q.get('period') === 'month' ? 'month' : 'all';
    const sinceMs = period === 'month' ? startOfCurrentMonthMs() : null;
    if (scope.startsWith('team:')) {
      const teamId = scope.slice('team:'.length);
      if (!user) return send(res, 401, { error: 'NO_SESSION' });
      assertCan(db, user.id, 'team.read', { teamId });
      return send(res, 200, { scope, period, rows: leaderboard(db, { teamId, sinceMs }) });
    }
    send(res, 200, { scope: 'all', period, rows: leaderboard(db, { sinceMs }) });
  }],

  // --- QA bug capture (dashboard side; session auth) ------------------------------------------------
  // A bug is filed by the extension over the Bearer /api/agent/bugs route below; these session routes are
  // how the human dashboard browses and resolves them. `/api/bugs/stats` MUST precede `/api/bugs/:id`
  // (match() compares segment counts only, so `:id` would otherwise capture the literal "stats").
  ['GET', '/api/bugs', true, async ({ db, req, res }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { bugs: listBugs(db, { status: q.get('status') || undefined, reporterId: q.get('reporterId') || undefined }) });
  }],
  ['GET', '/api/bugs/stats', true, async ({ db, res, user }) => send(res, 200, { stats: bugStatsForUser(db, user.id) })],
  ['GET', '/api/bugs/:id', true, async ({ db, res, params }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    send(res, 200, {
      bug,
      events: listBugEvents(db, params.id),
      analysis: analyzeBug(bug),
      llmAvailable: !!process.env.GFA_LLM_KEY,
      githubAvailable: !!(process.env.GFA_GITHUB_TOKEN && process.env.GFA_GITHUB_REPO),
    });
  }],
  ['POST', '/api/bugs/:id/status', true, async ({ db, res, params, body, user }) => {
    send(res, 200, { bug: updateBugStatus(db, params.id, body.status, user.id, { resolution: body.resolution }) });
  }],
  ['POST', '/api/bugs/:id/comment', true, async ({ db, res, params, body, user }) => {
    send(res, 200, { event: addBugComment(db, params.id, user.id, body.body) });
  }],
  // Hand a bug off to the agent board: create a code-issue task composed from the capture (symptom, suspected
  // component/source, repro, test login) + seed its RCA artifact, and link the bug ⇄ task. Re-posting a bug
  // that's already linked returns the existing link (alreadyLinked) instead of spawning a duplicate task.
  ['POST', '/api/bugs/:id/handoff', true, async ({ db, res, params, body, user }) => {
    send(res, 200, handoffBugToTask(db, { bugId: params.id, actorId: user.id, projectId: body?.projectId ?? null, teamId: body?.teamId ?? null }));
  }],
  // Assign / unassign a bug to a teammate (assigneeId null clears it). 404 for an unknown assignee.
  ['POST', '/api/bugs/:id/assign', true, async ({ db, res, params, body, user }) => {
    const assigneeId = body?.assigneeId ?? null;
    if (assigneeId && !getUserById(db, assigneeId)) throw new Error('USER_NOT_FOUND');
    send(res, 200, { bug: setBugAssignee(db, params.id, assigneeId, user.id) });
  }],
  // Optional LLM-backed root-cause analysis — 409 (with a clear message) when no GFA_LLM_KEY is set; else run
  // it (best-effort enriched with network failures), cache it on the bug, and return it. Credentials/auth are
  // never sent to the model (see buildRcaPrompt). Inert by default: without a key this route always 409s.
  ['POST', '/api/bugs/:id/analyze', true, async ({ db, res, params }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    if (!process.env.GFA_LLM_KEY) {
      return send(res, 409, { error: 'NO_LLM_KEY', message: 'Set GFA_LLM_KEY on the board to enable AI analysis.' });
    }
    let networkFailures = [];
    try {
      if (bug.networkKey) {
        const r = await fetch(signAccessUrl(bug.networkKey));
        const raw = await r.json();
        const entries = Array.isArray(raw) ? raw : raw.entries || [];
        networkFailures = entries
          .filter((e) => e.status === 0 || e.status >= 400)
          .slice(0, 20)
          .map((e) => ({ method: e.method, url: e.url, status: e.status }));
      }
    } catch {
      /* best-effort enrichment — the heuristic + console/picked signals still drive the prompt */
    }
    const llm = await llmAnalyzeBug(bug, { heuristic: analyzeBug(bug), networkFailures });
    send(res, 200, { llmAnalysis: llm, bug: setBugLlmAnalysis(db, params.id, llm) });
  }],
  // Optional GitHub issue export — 409 when GFA_GITHUB_TOKEN + GFA_GITHUB_REPO aren't configured; else file the
  // issue (credentials never included), cache its URL on the bug, and return it. Inert by default.
  ['POST', '/api/bugs/:id/github-issue', true, async ({ db, res, params, req }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    if (!process.env.GFA_GITHUB_TOKEN || !process.env.GFA_GITHUB_REPO) {
      return send(res, 409, { error: 'NO_GITHUB_CONFIG', message: 'Set GFA_GITHUB_TOKEN and GFA_GITHUB_REPO (owner/repo) on the board to enable GitHub export.' });
    }
    const { url } = await createGithubIssue(bug, { bugUrl: originOf(req) });
    send(res, 200, { url, bug: setBugGithubIssue(db, params.id, url) });
  }],
  // Hand the dashboard a short-lived signed UploadThing read URL for one captured artifact. kind picks the
  // key column (screenshot|dom|network|session); 404 when the bug or that particular key is absent. Six path
  // segments, so match() never confuses this with `/api/bugs/:id` (four) or `/api/bugs/:id/status` (five).
  ['GET', '/api/bugs/:id/artifact/:kind', true, async ({ db, res, params }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    const key = { screenshot: 'screenshotKey', dom: 'domKey', network: 'networkKey', session: 'sessionKey', source: 'sourceKey' }[params.kind];
    const fileKey = key ? bug[key] : null;
    if (!fileKey) throw new Error('NOT_FOUND');
    send(res, 200, { url: signAccessUrl(fileKey) });
  }],

  // --- Public, view-only bug share links ------------------------------------------------------------
  // Mirror the task-share routes above, but for a captured QA bug and with NO permission tiers — a public
  // link is always read-only and exposes the FULL raw bug (screenshot / DOM / network / rrweb session),
  // deliberately un-redacted (the product owner's explicit choice). Any authenticated member can mint /
  // list / revoke: bugs are a shared triage surface, and the dashboard bug routes above are member-wide
  // too (no per-reporter gate), so a per-reporter gate here would be inconsistent.
  ['POST', '/api/bugs/:id/share', true, async ({ db, res, params, user }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    const share = createBugShareLink(db, { bugId: params.id, createdBy: user.id });
    send(res, 200, { share: toBugShare(share) });
  }],
  ['GET', '/api/bugs/:id/shares', true, async ({ db, res, params }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    send(res, 200, { shares: listBugShareLinksForBug(db, params.id).map(toBugShare) });
  }],
  ['DELETE', '/api/bug-share/:token', true, async ({ db, res, params }) => {
    if (!revokeBugShareLink(db, params.token)) return send(res, 404, { error: 'NO_SUCH_SHARE' });
    send(res, 200, { ok: true });
  }],
  // Public (no session): the bearer of the token is the credential. The view returns the whole bug; the
  // artifact sub-route hands back a short-lived signed UploadThing read URL, authorized by the share token
  // instead of a session (mirrors the authed /api/bugs/:id/artifact/:kind). Segment counts keep these apart
  // under match(): /api/bug-share/:token (four) vs /api/bug-share/:token/artifact/:kind (six), and both use
  // the literal `bug-share` segment, distinct from the task `/api/share/:token` and from `/api/bugs/:id`.
  ['GET', '/api/bug-share/:token', false, async ({ db, res, params }) => {
    const v = bugShareView(db, params.token);
    if (!v) return send(res, 404, { error: 'NOT_FOUND' });
    send(res, 200, { bug: v, analysis: analyzeBug(v) });
  }],
  ['GET', '/api/bug-share/:token/artifact/:kind', false, async ({ db, res, params }) => {
    const share = getActiveBugShareByToken(db, params.token);
    if (!share) return send(res, 404, { error: 'NOT_FOUND' });
    const bug = getBugById(db, share.bug_id);
    if (!bug) return send(res, 404, { error: 'NOT_FOUND' });
    const key = { screenshot: 'screenshotKey', dom: 'domKey', network: 'networkKey', session: 'sessionKey', source: 'sourceKey' }[params.kind];
    const fileKey = key ? bug[key] : null;
    if (!fileKey) return send(res, 404, { error: 'NO_ARTIFACT' });
    send(res, 200, { url: signAccessUrl(fileKey) });
  }],
];

// The agent/runner API — token (Bearer) authenticated, transport-agnostic. This is how an agent running on
// a MEMBER's OWN machine reaches a hosted board: the HTTP MCP transport (src/mcp/http-server.js) forwards
// every gfa_* call to /rpc, and a `be10x connect` runner claims/reports wakes here. Each handler receives
// { db, req, res, params, body, auth } where auth = { userId, tokenId }. Dispatched separately from the
// human/session ROUTES above (see createApp).
const AGENT_ROUTES = [
  // The universal gfa_* gateway: dispatch { tool, args } through the SAME registry the stdio MCP server
  // uses (src/mcp/tools.js), so every agent tool works over HTTP with zero duplication. Domain errors the
  // handler throws (NO_TASK, MISSING_FIELD:*, …) propagate to createApp's catch and map to a status.
  ['POST', '/api/agent/rpc', async ({ db, res, body, auth }) => {
    const tool = getTool(body.tool);
    if (!tool) throw new Error('UNKNOWN_TOOL');
    const result = tool.handler(db, auth, body.args ?? {});
    send(res, 200, { result: result ?? null });
  }],

  // The bug-context gateway for a REMOTE agent (the be10x-bugs sibling of /api/agent/rpc): dispatch
  // { tool, args } through the SHARED bug-tools registry (src/mcp/bug-tools.js) against the board db, so a
  // member's `connect` agent gets the same be10x-bugs capture tools the local stdio server has. Unlike that
  // single-tenant server, this enforces per-account bug access (dispatchBugTool → canAccessBug), so a token
  // can't read another account's bug. Domain errors (UNKNOWN_TOOL, FORBIDDEN, NO_BUG, NO_ARTIFACT:*) map via
  // statusFor. Handlers may be async, so the dispatch is awaited.
  ['POST', '/api/agent/bug-rpc', async ({ db, res, body, auth }) => {
    const result = await dispatchBugTool(db, auth, body.tool, body.args ?? {});
    send(res, 200, { result: result ?? null });
  }],

  // The QA capture extension files a bug. Bearer-authed, so the reporter is the token's user. The payload is
  // UploadThing keys + small metadata only — the screenshot/DOM/network binaries go straight to UploadThing,
  // never through here (so this stays well under readJson's 2 MB cap).
  ['POST', '/api/agent/bugs', async ({ db, req, res, body, auth }) => {
    const bug = createBug(db, {
      reporterId: auth.userId,
      pageUrl: body.pageUrl,
      title: body.title,
      description: body.description,
      severity: body.severity,
      projectId: body.projectId,
      teamId: body.teamId,
      tags: body.tags,
      screenshotKey: body.screenshotKey,
      domKey: body.domKey,
      networkKey: body.networkKey,
      sessionKey: body.sessionKey,
      sourceKey: body.sourceKey,
      identity: body.identity || {},
      meta: body.meta || {},
    });
    // Fire-and-forget team notification (inert unless GFA_BUG_WEBHOOK is set) — never blocks or fails ingest.
    void notifyBugFiled(bug, { boardOrigin: originOf(req) });
    send(res, 200, { bug });
  }],

  // The extension asks for signed URLs, then PUTs each artifact (screenshot/DOM/network) directly to
  // UploadThing — so the multi-MB bytes never traverse this server. Body is just [{ name, size, type }].
  ['POST', '/api/agent/bugs/upload-urls', async ({ res, body }) => {
    const files = Array.isArray(body.files) ? body.files : [];
    send(res, 200, { uploads: mintUploadUrls(files) });
  }],

  // The extension's team/project pickers. The human dashboard reads these from the session routes
  // GET /api/teams and /api/projects, but the extension authenticates with a Bearer token, so it needs
  // these agent-side twins — same response shapes, resolved for the token's user (auth.userId).
  ['GET', '/api/agent/teams', async ({ db, res, auth }) => send(res, 200, { teams: teamsForUser(db, auth.userId) })],
  ['GET', '/api/agent/projects', async ({ db, res, auth }) => send(res, 200, { projects: listProjectsForUser(db, auth.userId) })],

  // A connector declares a repo it serves so tasks can target it and `claim` can match it. The project is
  // path-less on a hosted board (the repo lives on the member's machine, not the server). Idempotent.
  ['POST', '/api/agent/projects', async ({ db, res, body, auth }) => {
    const key = String(body.key || '').trim();
    if (!key) throw new Error('MISSING_FIELD:key');
    // Personal to the token's owner — a connector declares repos for itself, not a team (no team concept
    // travels through `be10x connect` today). Scoped so two different accounts' connectors declaring the
    // same key (e.g. the same folder name with no git remote) never collide onto one shared project.
    const project = registerProject(db, { key, name: body.name || key, rootPath: null, ownerId: auth.userId });
    send(res, 200, { project });
  }],

  // Token (Bearer) twin of the session archive route, so a connector's CLI (`be10x archive <id>`) on a
  // HOSTED board can soft-archive by uuid OR GFA-123 human id (it has no local db to resolve it). Same
  // authz gate as the session route. Returns { task, worktrees } so the CLI can GC the worktrees that live
  // on ITS disk (the board can't reach them).
  ['POST', '/api/agent/tasks/:id/archive', async ({ db, res, params, auth }) => {
    const id = resolveTaskId(db, params.id);
    if (!id) throw new Error('NO_TASK');
    assertCanAccessTask(db, auth.userId, getTask(db, id), 'task.update');
    const { task, worktrees } = archiveTask(db, id, auth.userId);
    send(res, 200, { task, worktrees });
  }],

  // Hand the next wake to a member's connector. Scoped to the repos (project keys) the connector serves,
  // this runs the SAME prepareWake the in-process runner does (lifecycle claim + delta gather), opens a run
  // row (so the board shows "agent running" and holds a resume record), and returns everything the remote
  // executor needs to build the prompt and --resume the prior session. Comments are left unseen until the
  // connector reports back, so a failed run re-delivers them.
  ['POST', '/api/agent/claim', async ({ db, res, body, auth }) => {
    const projectKeys = Array.isArray(body.projectKeys) ? body.projectKeys : [];
    const workerId = body.workerId || 'connect:' + auth.userId;
    const wake = claimNextWakeForKeys(db, { projectKeys, workerId, userId: auth.userId });
    if (!wake) return send(res, 200, { wake: null });
    const task = getTask(db, wake.taskId);
    if (!task) return send(res, 200, { wake: null }); // orphaned wake row; nothing to run
    // The prior run's session (fetch BEFORE opening this run row, or we'd read the one we just created).
    const resumeSessionId = getLatestRunForTask(db, task.id)?.sessionId || null;
    const { mode, staged, comments } = prepareWake(db, { wake, task, workerId });
    const run = createRun(db, { taskId: staged.id, projectId: staged.projectId });
    const project = getProject(db, staged.projectId);
    send(res, 200, {
      wake: { id: wake.id, reason: wake.reason, context: wake.context },
      runId: run.id,
      projectKey: project ? project.key : null, // so the connector maps the task to its local checkout
      // Full task: content + plan + linkedBugs travel so the connector builds the prompt (incl. the linked-bug
      // block) without another call — the remote executor has no board db to look them up.
      task: { ...staged, linkedBugs: listBugsForTask(db, staged.id).map(linkedBugSummary) },
      mode,
      resume: wake.context?.retry ? true : undefined,
      resumeSessionId,
      comments: comments.map((c) => ({ id: c.id, anchor: c.anchor, author: c.author, body: c.body })),
      commentIds: comments.map((c) => c.id),
    });
  }],

  // Take a run's outcome back from the connector. Closes the run row and applies the durability tail via
  // the SAME settleWake the in-process runner uses (auto-retry env failures, execute→verifying hand-off,
  // mark the delivered comments seen, blocked/gave-up). commentIds identify exactly the set delivered.
  ['POST', '/api/agent/report', async ({ db, res, body, auth }) => {
    const wake = getWake(db, body.wakeId);
    if (!wake) throw new Error('NOT_FOUND');
    const task = getTask(db, wake.taskId);
    if (!task) throw new Error('NO_TASK');
    const summary = body.summary || {};
    const workerId = body.workerId || 'connect:' + auth.userId;
    if (body.runId) {
      if (summary.sessionId) setRunSession(db, body.runId, summary.sessionId);
      finishRun(
        db,
        body.runId,
        summary.ok === false
          ? { status: 'failed', result: summary, error: summary.error, usage: summary.usage }
          : { status: 'done', result: summary, usage: summary.usage }
      );
    }
    const commentIds = Array.isArray(body.commentIds) ? body.commentIds : [];
    const result = settleWake(db, {
      wake,
      task,
      workerId,
      mode: summary.mode,
      comments: commentIds.map((id) => ({ id })),
      summary,
    });
    send(res, 200, { ok: true, retrying: result.retrying || null });
  }],
];

export function createApp(db) {
  return http.createServer(async (req, res) => {
    try {
      // CORS + Private Network Access. Chrome (Local Network Access, 130+) sends a preflight carrying
      // `Access-Control-Request-Private-Network: true` before any fetch to a loopback/private address —
      // including an extension service worker with host_permissions — and BLOCKS the real request unless
      // the target ACKs it here. Bearer-token auth (not cookies) means an echoed/`*` origin is safe. This
      // is inert on public HTTPS deploys: browsers only enforce PNA when the target is a private address.
      const origin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, content-type',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }
      const pathname = new URL(req.url, 'http://x').pathname;
      if (!pathname.startsWith('/api/')) { if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res); res.writeHead(404); return res.end(); }
      // Agent/runner API: token (Bearer) auth, dispatched before the human/session routes.
      if (pathname.startsWith('/api/agent/')) {
        for (const [method, pattern, handler] of AGENT_ROUTES) {
          if (req.method !== method) continue;
          const params = match(pattern, pathname);
          if (!params) continue;
          const auth = agentAuth(db, req);
          if (!auth) return send(res, 401, { error: 'BAD_TOKEN' });
          const body = method === 'GET' ? {} : await readJson(req);
          return await handler({ db, req, res, params, body, auth });
        }
        return send(res, 404, { error: 'NOT_FOUND' });
      }
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
