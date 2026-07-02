import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeRemoteExecutor } from '../src/connect/remote-executor.js';

// The member-side executor spawns the member's OWN claude locally and RESOLVES a summary (never throws) for
// the connector to report. spawn/ensureWorktree are injected, so this needs no real CLI or git repo.

const TASK = { id: 't1', humanId: 'GFA-1', title: 'Fix the bug', content: { description: 'broken' }, type: 'code-issue' };
const REPO = { rootPath: '/repo', defaultBranch: 'main' };
const WT = '/repo/.be10x/worktrees/be10x__GFA-1-fix-the-bug';

function fakeSpawn({ stdout = [], stderr = '', exitCode = 0 }) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = { data: '', write(s) { this.data += s; }, end() { this.ended = true; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (const line of stdout) child.stdout.emit('data', Buffer.from(line + '\n'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

function fakeEnsure() {
  const calls = [];
  const fn = async (repoRoot, opts) => {
    calls.push({ repoRoot, ...opts });
    return { path: WT, branch: opts.branch, baseRef: 'main', reused: false };
  };
  fn.calls = calls;
  return fn;
}

const J = (o) => JSON.stringify(o);

test('a successful remote run resolves ok/done with the scraped session id, in the LOCAL worktree', async () => {
  const spawn = fakeSpawn({
    stdout: [
      J({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-4-8' }),
      J({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'planning' }] } }),
      J({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' }),
    ],
    exitCode: 0,
  });
  const ensureWorktree = fakeEnsure();
  const execute = makeRemoteExecutor(REPO, { bin: 'claude', spawn, ensureWorktree });

  const summary = await execute(TASK, { mode: 'plan' });

  assert.equal(summary.ok, true);
  assert.equal(summary.done, true);
  assert.equal(summary.sessionId, 'sess-1');
  assert.equal(summary.mode, 'plan');
  assert.equal(spawn.calls[0].options.cwd, WT, 'claude runs in the member local worktree');
  assert.equal(ensureWorktree.calls[0].repoRoot, '/repo');
  // A fresh plan carries the be10x system prompt and does NOT resume.
  assert.ok(spawn.calls[0].args.includes('--append-system-prompt-file'));
  assert.ok(!spawn.calls[0].args.includes('--resume'));
});

test('a resume mode (+ resumeSessionId from the board claim) passes --resume and drops the fresh system prompt', async () => {
  const spawn = fakeSpawn({
    stdout: [J({ type: 'result', subtype: 'success', session_id: 'sess-prev', result: 'ok' })],
    exitCode: 0,
  });
  const execute = makeRemoteExecutor(REPO, { bin: 'claude', spawn, ensureWorktree: fakeEnsure() });

  const summary = await execute(TASK, { mode: 'revise', resumeSessionId: 'sess-prev' });

  assert.equal(summary.ok, true);
  const args = spawn.calls[0].args;
  const i = args.indexOf('--resume');
  assert.ok(i !== -1, 'resumes the prior session');
  assert.equal(args[i + 1], 'sess-prev');
  assert.ok(!args.includes('--append-system-prompt-file'), 'resumed session already has the instructions cached');
});

test('a lost-auth failure resolves ok:false with the real error and failureKind auth (board will retry)', async () => {
  const spawn = fakeSpawn({
    stdout: [J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })],
    exitCode: 1,
  });
  const execute = makeRemoteExecutor(REPO, { bin: 'claude', spawn, ensureWorktree: fakeEnsure() });

  const summary = await execute(TASK, { mode: 'plan' });

  assert.equal(summary.ok, false);
  assert.equal(summary.done, false);
  assert.equal(summary.failureKind, 'auth');
  assert.match(summary.error, /Not logged in/);
});

test('a worktree staging failure resolves as a retryable crash summary, never throws', async () => {
  const spawn = fakeSpawn({ stdout: [], exitCode: 0 });
  const ensureWorktree = async () => {
    throw new Error('git worktree add failed');
  };
  const execute = makeRemoteExecutor(REPO, { bin: 'claude', spawn, ensureWorktree });

  const summary = await execute(TASK, { mode: 'plan' });

  assert.equal(summary.ok, false);
  assert.equal(summary.failureKind, 'crash');
  assert.match(summary.error, /could not create worktree/);
  assert.equal(spawn.calls.length, 0, 'never spawned claude — staging failed first');
});
