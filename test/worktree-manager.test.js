import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import {
  slugify,
  worktreeBranch,
  worktreePath,
  resolveBaseRef,
  ensureWorktree,
  removeWorktree,
} from '../src/executor/worktree.js';

// --- test helpers -----------------------------------------------------------

function git(dir, args) {
  return String(
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  ).trim();
}

// Create a fresh git repo with a single base commit so there is a branch to
// build worktrees from. Returns the repo root plus a cleanup fn.
function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'be10x-wt-'));
  execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
  git(repoRoot, ['config', 'user.email', 'test@be10x.local']);
  git(repoRoot, ['config', 'user.name', 'be10x test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoRoot, 'README.md'), '# be10x worktree test\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'init']);
  return { repoRoot, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

// --- pure helpers -----------------------------------------------------------

test('slugify lowercases, dashes non-alphanumerics, and trims', () => {
  assert.equal(slugify('Add Login Flow!'), 'add-login-flow');
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('Foo/Bar_Baz'), 'foo-bar-baz');
  assert.equal(slugify('Task 123'), 'task-123');
  assert.equal(slugify('---weird---'), 'weird');
  assert.equal(slugify(''), '');
});

test('worktreeBranch builds a be10x/<id>-<slug> name and caps the slug', () => {
  assert.equal(worktreeBranch('T-1', 'Add login flow'), 'be10x/T-1-add-login-flow');

  const branch = worktreeBranch('T-2', 'x'.repeat(200));
  const slug = branch.slice('be10x/T-2-'.length);
  assert.ok(slug.length <= 40, `slug length ${slug.length} should be <= 40`);
  assert.ok(!slug.endsWith('-'), 'capped slug should not end with a dash');
});

test('worktreePath is absolute and flattens the branch slash to __', () => {
  const wp = worktreePath('/repo/root', 'be10x/T-1-add-login-flow');
  assert.ok(isAbsolute(wp));
  assert.equal(wp, resolve('/repo/root', '.be10x/worktrees/be10x__T-1-add-login-flow'));
});

test('resolveBaseRef prefers configured, else detects branch, else falls back to main', () => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    // configured value wins verbatim
    assert.equal(resolveBaseRef(repoRoot, 'develop'), 'develop');

    // no config -> the repo's actual current branch
    const current = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.equal(resolveBaseRef(repoRoot), current);

    // git errors are swallowed -> 'main'
    const nonRepo = mkdtempSync(join(tmpdir(), 'be10x-nonrepo-'));
    try {
      assert.equal(resolveBaseRef(nonRepo), 'main');
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// --- worktree lifecycle -----------------------------------------------------

test('ensureWorktree/removeWorktree: create, reuse, recreate, remove', async (t) => {
  const { repoRoot, cleanup } = makeRepo();
  try {
    const branch = worktreeBranch('T-1', 'Add login flow');
    const baseRef = resolveBaseRef(repoRoot);
    let wtPath;

    await t.test('(1) creates the worktree dir + branch, reused:false', async () => {
      const r = await ensureWorktree(repoRoot, { branch, baseRef });
      wtPath = r.path;

      assert.equal(r.reused, false);
      assert.equal(r.branch, branch);
      assert.equal(r.baseRef, baseRef);
      assert.equal(r.path, worktreePath(repoRoot, branch));

      // the path is a real, valid git worktree checked out on `branch`
      assert.ok(existsSync(wtPath));
      assert.equal(git(wtPath, ['rev-parse', '--is-inside-work-tree']), 'true');
      assert.equal(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);
    });

    await t.test('(2) a second call reuses the same path, reused:true', async () => {
      const r = await ensureWorktree(repoRoot, { branch, baseRef });
      assert.equal(r.reused, true);
      assert.equal(r.path, wtPath);
      assert.ok(isValidWorktreeOnDisk(wtPath));
    });

    await t.test('(3) recreates the worktree after its dir is deleted on disk', async () => {
      rmSync(wtPath, { recursive: true, force: true });
      assert.equal(existsSync(wtPath), false);

      const r = await ensureWorktree(repoRoot, { branch, baseRef });
      assert.equal(r.reused, false);
      assert.equal(r.path, wtPath);
      assert.ok(existsSync(wtPath));
      assert.equal(git(wtPath, ['rev-parse', '--is-inside-work-tree']), 'true');
    });

    await t.test('(4) removeWorktree removes it and is safe to call twice', async () => {
      removeWorktree(repoRoot, wtPath);
      assert.equal(existsSync(wtPath), false);
      // second call must not throw even though it is already gone
      assert.doesNotThrow(() => removeWorktree(repoRoot, wtPath));
    });

    await t.test('concurrent ensureWorktree calls resolve to one shared worktree', async () => {
      const branch2 = worktreeBranch('T-9', 'Parallel work');
      const results = await Promise.all([
        ensureWorktree(repoRoot, { branch: branch2, baseRef }),
        ensureWorktree(repoRoot, { branch: branch2, baseRef }),
        ensureWorktree(repoRoot, { branch: branch2, baseRef }),
      ]);
      const paths = new Set(results.map((r) => r.path));
      assert.equal(paths.size, 1, 'all concurrent calls target the same path');
      // exactly one call created it; the rest reused it
      assert.equal(results.filter((r) => r.reused === false).length, 1);
      removeWorktree(repoRoot, results[0].path);
    });
  } finally {
    cleanup();
  }
});

// Mirror of the module's validity check, used only for assertions here.
function isValidWorktreeOnDisk(wtPath) {
  if (!existsSync(wtPath)) return false;
  try {
    git(wtPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}
