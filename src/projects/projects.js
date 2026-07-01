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
        createdAt: row.created_at,
      }
    : null;
}

// Insert a project keyed by `key`. Idempotent: if the key already exists, the existing row is returned
// unchanged (registration never clobbers an established project).
export function registerProject(db, { key, name, rootPath = null, defaultBranch = null }) {
  const existing = getProjectByKey(db, key);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO projects (id, key, name, default_branch, root_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, key, name || key, defaultBranch, rootPath, Date.now());
  return getProjectByKey(db, key);
}

export function getProjectByKey(db, key) {
  return hydrate(db.prepare('SELECT * FROM projects WHERE key = ?').get(key));
}

export function getProject(db, id) {
  return hydrate(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all().map(hydrate);
}
