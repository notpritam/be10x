import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcTaskWorktrees } from '../src/executor/worktree.js';

// A fake git runner recording every (dir, args) invocation, so GC is fully exercised WITHOUT ever touching a
// real worktree on disk. `throwOn(dir, args)` lets a test simulate git failing (e.g. a branch that's already
// gone) to prove tolerance.
function fakeExec({ throwOn } = {}) {
  const calls = [];
  const fn = (dir, args) => {
    calls.push({ dir, args });
    if (throwOn && throwOn(dir, args)) throw new Error('fatal: not found');
    return '';
  };
  fn.calls = calls;
  fn.argsList = () => calls.map((c) => c.args);
  return fn;
}

const WT = { path: '/repo/.be10x/worktrees/be10x__GFA-1-x', branch: 'be10x/GFA-1-x' };

test('gcTaskWorktrees removes a managed worktree + its branch, and skips the repo root', async () => {
  const exec = fakeExec();
  const res = await gcTaskWorktrees({ rootPath: '/repo' }, [WT, { path: '/repo', branch: 'main' }], { exec });

  // The managed worktree is removed; the repo-root entry is skipped (never deleted).
  assert.deepEqual(res.removed, [WT]);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].path, '/repo');
  assert.equal(res.skipped[0].reason, 'repo-root');

  // Exact git sequence for the eligible worktree: remove --force, prune, then branch -D.
  assert.deepEqual(exec.argsList(), [
    ['worktree', 'remove', '--force', WT.path],
    ['worktree', 'prune'],
    ['branch', '-D', WT.branch],
  ]);
  // Every git op ran from the repo root, and NONE targeted the repo root as a worktree to remove.
  assert.ok(exec.calls.every((c) => c.dir === '/repo'));
  assert.ok(!exec.calls.some((c) => c.args.includes('remove') && c.args.includes('/repo')));
});

test('gcTaskWorktrees is tolerant: a missing branch (branch -D fails) does not throw', async () => {
  const exec = fakeExec({ throwOn: (_dir, args) => args[0] === 'branch' });
  const res = await gcTaskWorktrees({ rootPath: '/repo' }, [WT], { exec });
  // The worktree is still considered reclaimed even though branch -D failed.
  assert.deepEqual(res.removed, [WT]);
});

test('gcTaskWorktrees is tolerant: an already-gone worktree (every git op fails) does not throw', async () => {
  const exec = fakeExec({ throwOn: () => true });
  const res = await gcTaskWorktrees({ rootPath: '/repo' }, [WT], { exec });
  assert.deepEqual(res.removed, [WT]);
});

test('gcTaskWorktrees never deletes a path outside <root>/.be10x/worktrees', async () => {
  const exec = fakeExec();
  const res = await gcTaskWorktrees({ rootPath: '/repo' }, [{ path: '/repo/src', branch: 'b' }], { exec });
  assert.equal(res.removed.length, 0);
  assert.equal(res.skipped[0].reason, 'outside-worktrees');
  assert.equal(exec.calls.length, 0, 'no git ops for an out-of-tree path');
});

test('gcTaskWorktrees never runs branch -D on the default branch', async () => {
  const exec = fakeExec();
  await gcTaskWorktrees(
    { rootPath: '/repo', defaultBranch: 'main' },
    [{ path: '/repo/.be10x/worktrees/w', branch: 'main' }],
    { exec }
  );
  assert.ok(exec.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'), 'worktree still removed');
  assert.ok(!exec.calls.some((c) => c.args[0] === 'branch'), 'default branch is never force-deleted');
});

test('gcTaskWorktrees skips path-less entries and a missing repo root', async () => {
  const exec = fakeExec();
  const noPath = await gcTaskWorktrees({ rootPath: '/repo' }, [{ path: null, branch: 'b' }], { exec });
  assert.equal(noPath.skipped[0].reason, 'no-path');

  const noRoot = await gcTaskWorktrees({}, [WT], { exec });
  assert.equal(noRoot.removed.length, 0);
  assert.equal(noRoot.skipped[0].reason, 'no-root');
  assert.equal(exec.calls.length, 0);
});

test('gcTaskWorktrees is idempotent: a second pass over already-removed worktrees is a clean no-throw', async () => {
  const exec = fakeExec({ throwOn: () => true }); // simulate everything already gone
  const first = await gcTaskWorktrees({ rootPath: '/repo' }, [WT], { exec });
  const second = await gcTaskWorktrees({ rootPath: '/repo' }, [WT], { exec });
  assert.deepEqual(first.removed, [WT]);
  assert.deepEqual(second.removed, [WT]);
});
