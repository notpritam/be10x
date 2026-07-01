// Per-task git-worktree manager for be10x.
//
// Gives each task its own isolated checkout on a dedicated branch, mirroring
// the behaviour of paperclip's workspace-runtime and vibe-kanban's
// WorktreeManager: deterministic branch/path derivation, an idempotent
// per-path lock-guarded `ensureWorktree`, and a tolerant `removeWorktree`.
//
// Node built-ins only. Git is always invoked through `execFileSync` with an
// explicit argument array (never a shell string) so task titles and paths can
// never be interpolated into a command line.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SLUG_MAX = 40;

// --- git helpers ------------------------------------------------------------

// Run `git -C <dir> <...args>`, returning trimmed stdout. Throws on non-zero
// exit (the thrown error carries stderr for diagnostics).
function runGit(dir, args) {
  const out = execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out).trim();
}

// Run git, swallowing any failure. Returns true on success, false otherwise.
function tryGit(dir, args) {
  try {
    runGit(dir, args);
    return true;
  } catch {
    return false;
  }
}

function branchExists(repoRoot, branch) {
  return tryGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

// A path is a live worktree when the directory exists AND git, run from inside
// it, confirms it is a work tree.
function isValidWorktree(wtPath) {
  return existsSync(wtPath) && tryGit(wtPath, ['rev-parse', '--is-inside-work-tree']);
}

// --- pure derivation --------------------------------------------------------

// Lowercase, collapse every run of non-alphanumerics to a single `-`, then
// trim leading/trailing dashes.
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// `be10x/<humanId>-<slug>` with the slug capped to ~SLUG_MAX chars (trailing
// dash trimmed so a mid-word cut never leaves a dangling separator).
export function worktreeBranch(humanId, title) {
  const slug = slugify(title).slice(0, SLUG_MAX).replace(/-+$/, '');
  return `be10x/${humanId}-${slug}`;
}

// Absolute path `<repoRoot>/.be10x/worktrees/<branch>` with `/` in the branch
// flattened to `__` so the branch maps to a single directory component.
export function worktreePath(repoRoot, branch) {
  const safe = String(branch).replace(/\//g, '__');
  return resolve(repoRoot, '.be10x', 'worktrees', safe);
}

// `configured` wins when provided; otherwise use the repo's current branch,
// falling back to 'main'. All git errors (and a detached HEAD) fall back too.
export function resolveBaseRef(repoRoot, configured) {
  if (configured) return configured;
  try {
    const branch = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch && branch !== 'HEAD') return branch;
  } catch {
    // fall through to the default
  }
  return 'main';
}

// --- per-path lock ----------------------------------------------------------

// In-process serialization keyed by worktree path. Concurrent calls for the
// same path run one after another; a failing call never poisons the chain, and
// the map entry is dropped once the tail settles so it cannot grow unbounded.
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const guard = run.catch(() => {});
  locks.set(key, guard);
  guard.finally(() => {
    if (locks.get(key) === guard) locks.delete(key);
  });
  return run;
}

// --- public API -------------------------------------------------------------

// Ensure a worktree for `branch` exists, reusing a valid one if present.
// Idempotent and guarded per worktree path against concurrent calls.
export async function ensureWorktree(repoRoot, { branch, baseRef } = {}) {
  const wtPath = worktreePath(repoRoot, branch);
  return withLock(wtPath, () => {
    const ref = resolveBaseRef(repoRoot, baseRef);

    // Already a valid worktree -> reuse as-is.
    if (isValidWorktree(wtPath)) {
      return { path: wtPath, branch, baseRef: ref, reused: true };
    }

    // A directory is here but it is not a worktree -> clear it out first.
    if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
    }

    // Drop stale worktree metadata (e.g. the dir was deleted out from under
    // git) so `worktree add` does not trip over an already-registered path or
    // an "already checked out" branch.
    tryGit(repoRoot, ['worktree', 'prune']);

    mkdirSync(dirname(wtPath), { recursive: true });

    if (branchExists(repoRoot, branch)) {
      runGit(repoRoot, ['worktree', 'add', wtPath, branch]);
    } else {
      runGit(repoRoot, ['worktree', 'add', '-b', branch, wtPath, ref]);
    }

    return { path: wtPath, branch, baseRef: ref, reused: false };
  });
}

// Remove a worktree and prune its metadata. Tolerates errors (e.g. it is
// already gone) so it is safe to call repeatedly.
export function removeWorktree(repoRoot, wtPath) {
  tryGit(repoRoot, ['worktree', 'remove', '--force', wtPath]);
  tryGit(repoRoot, ['worktree', 'prune']);
}
