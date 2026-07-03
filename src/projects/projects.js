// ABOUTME: Project registration — gives a repo a stable identity (`key`) derived from its git remote so
// ABOUTME: the same repo maps to the same project everywhere. Pure core (db first arg); no HTTP/CLI here.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';

// Turn a git remote URL into a stable, comparable key. Strips scheme, userinfo/auth, port, and a trailing
// .git, folds scp syntax (git@host:org/repo) into host/org/repo, and lowercases — so the https and ssh
// forms of the same remote collapse to one key. e.g. github.com/org/repo
export function keyFromRemote(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme://
  const at = s.lastIndexOf('@'); // strip user@ / user:pass@ (scp + http auth)
  if (at !== -1) s = s.slice(at + 1);
  s = s.replace(/:(\d+)(?=\/|$)/, ''); // strip :port
  s = s.replace(':', '/'); // scp host:path -> host/path
  s = s.replace(/\.git$/i, ''); // strip trailing .git
  s = s.replace(/\/+$/, ''); // strip trailing slashes
  s = s.replace(/\/+/g, '/'); // collapse duplicate slashes
  return s.toLowerCase();
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo'
  );
}

// Run a git command in `cwd`, swallowing any error (not a repo, git missing, no remote) into ''.
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Derive a project's identity from a working directory: its key (from remote.origin.url, else local:<slug>),
// the resolved absolute path, and the current branch (falling back to 'main').
export function detectProjectKey(cwd = process.cwd()) {
  const rootPath = resolve(cwd);
  const remote = git(rootPath, ['config', '--get', 'remote.origin.url']);
  const key = remote ? keyFromRemote(remote) : 'local:' + slugify(basename(rootPath));
  let defaultBranch = git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!defaultBranch || defaultBranch === 'HEAD') defaultBranch = 'main';
  return { key, rootPath, defaultBranch };
}

function hydrate(row) {
  return row
    ? {
        id: row.id,
        key: row.key,
        name: row.name,
        defaultBranch: row.default_branch,
        rootPath: row.root_path,
        ownerId: row.owner_id,
        teamId: row.team_id,
        createdAt: row.created_at,
      }
    : null;
}

// Insert a project keyed by `key`, scoped to a team (shared with every member) or, when teamId is omitted,
// personal to ownerId. Idempotent WITHIN that scope: re-registering the same key for the same team (or the
// same owner) returns the existing row unchanged. A DIFFERENT owner/team registering the same key (two
// accounts linking repos that happen to share a key — the same git remote, or just the same folder name
// with no remote at all) gets its OWN row: project identity is scoped, never shared across accounts/teams,
// so one can't see or collide with the other's tasks/wakes. Every HTTP-facing caller passes a real ownerId
// (the authenticated user); trusted internal/test code may omit both, which registers (and dedupes
// against) an ownerless/teamless row — the same "legacy" shape pre-scoping data has (see db.js
// migrateProjectsTable), visible to everyone rather than a private accident.
export function registerProject(db, { key, name, rootPath = null, defaultBranch = null, ownerId = null, teamId = null }) {
  const existing = getProjectByKey(db, key, { ownerId, teamId });
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO projects (id, key, name, default_branch, root_path, owner_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, key, name || key, defaultBranch, rootPath, ownerId, teamId, Date.now());
  return getProjectByKey(db, key, { ownerId, teamId });
}

// `scope` is optional: omit it entirely for a trusted, single-tenant lookup (the local CLI acting directly
// on its own db — `be10x work` / `list` / `adopt` — where "first match by key" is what always worked).
// Pass { ownerId, teamId } to resolve within one account's/team's own registrations; passing neither
// resolves the ownerless/teamless "legacy" row, if any.
export function getProjectByKey(db, key, scope) {
  if (!scope) return hydrate(db.prepare('SELECT * FROM projects WHERE key = ?').get(key));
  if (scope.teamId) return hydrate(db.prepare('SELECT * FROM projects WHERE key = ? AND team_id = ?').get(key, scope.teamId));
  if (scope.ownerId) return hydrate(db.prepare('SELECT * FROM projects WHERE key = ? AND team_id IS NULL AND owner_id = ?').get(key, scope.ownerId));
  return hydrate(db.prepare('SELECT * FROM projects WHERE key = ? AND team_id IS NULL AND owner_id IS NULL').get(key));
}

export function getProject(db, id) {
  return hydrate(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

// Unscoped — every registered project, regardless of owner/team. For trusted local-CLI use only
// (`be10x list`); the HTTP API uses listProjectsForUser instead.
export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all().map(hydrate);
}

// Projects visible to userId: their own personal projects, projects of any team they belong to, and
// legacy rows predating this scoping (owner_id/team_id both NULL — see db.js migrateProjectsTable) which
// stay visible to everyone rather than silently vanishing for accounts that already relied on them.
export function listProjectsForUser(db, userId) {
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN memberships m ON m.team_id = p.team_id AND m.user_id = ?
       WHERE p.owner_id = ?
          OR m.user_id IS NOT NULL
          OR (p.owner_id IS NULL AND p.team_id IS NULL)
       ORDER BY p.created_at, p.rowid`
    )
    .all(userId, userId)
    .map(hydrate);
}
