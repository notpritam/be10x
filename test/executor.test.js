import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db/db.js';
import { getLatestRunForTask } from '../src/executor/runs.js';
import { makeClaudeExecutor, buildPrompt } from '../src/executor/executor.js';

// A task row must exist for recordProgress (UPDATE tasks + appendEvent) to land.
function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('u1', 'a@b.dev', 'A', 'x', now);
  db.prepare(
    'INSERT INTO tasks (id, human_id, type, scope, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('t1', 'GFA-1', 'code-issue', 'personal', 'u1', 'Fix the bug', 'in_progress', now, now);
  return db;
}

const TASK = { id: 't1', humanId: 'GFA-1', title: 'Fix the bug', content: { description: 'The thing is broken.' }, type: 'code-issue' };
const PROJECT = { id: 'p1', rootPath: '/repo', defaultBranch: 'main' };

// A fake child_process.spawn: records stdin, then on the next tick emits the given stdout lines (one
// per stream-json event) and stderr, and closes with exitCode.
function fakeSpawn({ stdout = [], stderr = '', exitCode = 0 }) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 12345;
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
    return { path: '/repo/.be10x/worktrees/be10x__GFA-1-fix-the-bug', branch: opts.branch, baseRef: 'main', reused: false };
  };
  fn.calls = calls;
  return fn;
}

function agentState(db, taskId) {
  const row = db.prepare('SELECT agent_json FROM tasks WHERE id = ?').get(taskId);
  return row?.agent_json ? JSON.parse(row.agent_json) : null;
}

test('buildPrompt: fresh run carries the task; resume re-orients', () => {
  const fresh = buildPrompt(TASK, { resume: false });
  assert.match(fresh, /GFA-1/);
  assert.match(fresh, /Fix the bug/);
  assert.match(fresh, /The thing is broken\./);
  assert.match(fresh, /plan first/);
  const resumed = buildPrompt(TASK, { resume: true });
  assert.match(resumed, /Continue task GFA-1/);
  assert.doesNotMatch(resumed, /The thing is broken/);
});

test('a successful run scrapes + persists the session id and marks the run done', async () => {
  const db = seed();
  const spawn = fakeSpawn({
    stdout: [
      '{"type":"system","subtype":"init","session_id":"sess-xyz"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Here is my plan: step 1, step 2."}]}}',
      '{"type":"result","subtype":"success","session_id":"sess-xyz","result":"ok"}',
    ],
    exitCode: 0,
  });
  const ensureWorktree = fakeEnsure();
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree });

  const summary = await execute(TASK);

  // worktree staged on the derived branch, in the project root
  assert.equal(ensureWorktree.calls.length, 1);
  assert.equal(ensureWorktree.calls[0].repoRoot, '/repo');
  assert.equal(ensureWorktree.calls[0].branch, 'be10x/GFA-1-fix-the-bug');

  // the prompt reached the CLI on stdin, and it was a fresh (non-resumed) invocation
  const child = spawn.calls[0];
  assert.equal(child.command, 'npx');
  assert.ok(child.args.includes('--append-system-prompt-file'));
  assert.ok(!child.args.includes('--resume'));

  // durable state: session id persisted, run done
  const run = getLatestRunForTask(db, 't1');
  assert.equal(run.sessionId, 'sess-xyz');
  assert.equal(run.status, 'done');
  assert.equal(run.pid, 12345);
  assert.ok(run.endedAt);

  // board reflects completion; summary is truthful
  assert.equal(agentState(db, 't1').state, 'done');
  assert.equal(summary.done, true);
  assert.equal(summary.sessionId, 'sess-xyz');
  assert.equal(summary.runId, run.id);
});

test('a run that exits without a result is marked failed and the board shows blocked', async () => {
  const db = seed();
  const spawn = fakeSpawn({
    stdout: ['{"type":"system","subtype":"init","session_id":"sess-die"}'],
    stderr: 'boom: model unavailable',
    exitCode: 1,
  });
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });

  const summary = await execute(TASK);

  const run = getLatestRunForTask(db, 't1');
  assert.equal(run.status, 'failed');
  assert.equal(run.sessionId, 'sess-die'); // still captured for a later resume
  assert.match(run.error, /boom/);
  assert.equal(summary.done, false);
  assert.equal(agentState(db, 't1').state, 'blocked');
});

test('a worktree failure blocks the task and never opens a run', async () => {
  const db = seed();
  const ensureWorktree = async () => {
    throw new Error('not a git repo');
  };
  const execute = makeClaudeExecutor(db, PROJECT, { spawn: fakeSpawn({}), ensureWorktree });

  await assert.rejects(() => execute(TASK), /not a git repo/);
  assert.equal(getLatestRunForTask(db, 't1'), null);
  assert.equal(agentState(db, 't1').state, 'blocked');
});
