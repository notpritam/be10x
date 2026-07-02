import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';
import { getLatestRunForTask, createRun, setRunSession } from '../src/executor/runs.js';
import { listRunSteps } from '../src/executor/run-steps.js';
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

test('buildPrompt: carries task identity + the mode directive + comment deltas', () => {
  const plan = buildPrompt(TASK, { mode: 'plan' });
  assert.match(plan, /GFA-1/);
  assert.match(plan, /task db id: t1/);
  assert.match(plan, /Fix the bug/);
  assert.match(plan, /The thing is broken\./);
  assert.match(plan, /PLAN MODE/);
  assert.match(plan, /gfa_plan_task/);

  const execute = buildPrompt(TASK, { mode: 'execute' });
  assert.match(execute, /EXECUTE MODE/);
  assert.match(execute, /gfa_submit_output/);

  const revise = buildPrompt(TASK, { mode: 'revise', comments: [{ anchor: 'plan_line', body: 'tighten step 2' }] });
  assert.match(revise, /REVISE MODE/);
  assert.match(revise, /tighten step 2/);
});

test('execute starts a FRESH session (no --resume) — a clean handoff from the plan, not the planning transcript', async () => {
  const db = seed();
  const prior = createRun(db, { taskId: 't1' });
  setRunSession(db, prior.id, 'sess-prev');
  const spawn = fakeSpawn({
    stdout: ['{"type":"result","subtype":"success","session_id":"sess-new","result":"done"}'],
    exitCode: 0,
  });
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });

  await execute(TASK, { mode: 'execute' });

  const args = spawn.calls[0].args;
  assert.ok(!args.includes('--resume'), 'execute does not resume the planning session');
  assert.ok(args.includes('--append-system-prompt-file'), 'a fresh run carries the system prompt');
});

test('revise mode resumes the prior session (--resume, no fresh system prompt)', async () => {
  const db = seed();
  const prior = createRun(db, { taskId: 't1' });
  setRunSession(db, prior.id, 'sess-prev');
  const spawn = fakeSpawn({
    stdout: ['{"type":"result","subtype":"success","session_id":"sess-prev","result":"done"}'],
    exitCode: 0,
  });
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });

  await execute(TASK, { mode: 'revise' });

  const args = spawn.calls[0].args;
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-prev');
  assert.ok(!args.includes('--append-system-prompt-file'));
});

test('per-task model + effort (task.content) are passed to the CLI; an invalid effort is dropped', async () => {
  const db = seed();
  const spawn = fakeSpawn({ stdout: ['{"type":"result","subtype":"success","session_id":"s","result":"ok"}'], exitCode: 0 });
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });

  await execute({ ...TASK, content: { ...TASK.content, model: 'sonnet', effort: 'high' } }, { mode: 'execute' });
  const args = spawn.calls[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');

  // An out-of-range effort is silently ignored (no --effort), so the CLI never gets a bad value.
  const spawn2 = fakeSpawn({ stdout: ['{"type":"result","subtype":"success","session_id":"s","result":"ok"}'], exitCode: 0 });
  const execute2 = makeClaudeExecutor(db, PROJECT, { spawn: spawn2, ensureWorktree: fakeEnsure() });
  await execute2({ ...TASK, content: { ...TASK.content, effort: 'bogus' } }, { mode: 'execute' });
  assert.ok(!spawn2.calls[0].args.includes('--effort'));
});

test('the be10x MCP config is wired in when the repo has one', async () => {
  const db = seed();
  const repo = mkdtempSync(join(tmpdir(), 'be10x-mcp-'));
  mkdirSync(join(repo, '.be10x'), { recursive: true });
  writeFileSync(join(repo, '.be10x', 'mcp.json'), '{"mcpServers":{}}');
  const spawn = fakeSpawn({
    stdout: ['{"type":"result","subtype":"success","session_id":"s","result":"ok"}'],
    exitCode: 0,
  });
  const execute = makeClaudeExecutor(db, { ...PROJECT, rootPath: repo }, { spawn, ensureWorktree: fakeEnsure() });

  await execute(TASK, { mode: 'plan' });

  const args = spawn.calls[0].args;
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], join(repo, '.be10x', 'mcp.json'));
  assert.ok(args.includes('--strict-mcp-config'));
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

test('a run records an execution trace: the prompt/context handed down, each tool call, then the result', async () => {
  const db = seed();
  const spawn = fakeSpawn({
    stdout: [
      '{"type":"system","subtype":"init","session_id":"sess-tr"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"gfa_update_progress","input":{"todos":[]}}]}}',
      '{"type":"result","subtype":"success","session_id":"sess-tr","result":"ok"}',
    ],
    exitCode: 0,
  });
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });

  const summary = await execute(TASK, { mode: 'execute' });
  const steps = listRunSteps(db, summary.runId);

  // First step is the context we passed down — the full prompt + the resolved command/args.
  assert.equal(steps[0].kind, 'prompt');
  assert.match(steps[0].detail.prompt, /EXECUTE MODE/);
  assert.ok(Array.isArray(steps[0].detail.args));

  // Then the commands the agent ran, in order.
  const tools = steps.filter((s) => s.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].tool, 'Bash');
  assert.equal(tools[0].detail.input.command, 'git status');
  assert.equal(tools[1].tool, 'gfa_update_progress');

  // Bookended by the outcome.
  const last = steps[steps.length - 1];
  assert.equal(last.kind, 'result');
  assert.equal(last.detail.done, true);

  // Ordered contiguously by seq.
  steps.forEach((s, i) => assert.equal(s.seq, i));
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
