import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConnectOnce, connectLoop } from '../src/connect/connect.js';

// The connector's observability seam: runConnectOnce / connectLoop emit structured lifecycle events through an
// injected logger (default makeLogger()). We inject a capturing fake and assert the SEQUENCE of event names for
// each path — heartbeat (poll), idle, the claimed→reported lifecycle, run failures, and caught cycle errors —
// while proving the claim→run→report control flow is unchanged (only logging was added).

const REPOS = [{ key: 'github.com/acme/app', path: '/home/me/app', defaultBranch: 'main' }];

function fakeBoard(claimResult) {
  const calls = { claim: [], report: [] };
  return {
    calls,
    claim: async (projectKeys, workerId) => {
      calls.claim.push({ projectKeys, workerId });
      return claimResult;
    },
    report: async (payload) => {
      calls.report.push(payload);
      return { ok: true };
    },
  };
}

// A board whose claim() rejects — models a network blip mid-poll.
function throwingBoard(err) {
  const calls = { claim: [], report: [] };
  return {
    calls,
    claim: async () => {
      calls.claim.push({});
      throw err;
    },
    report: async (p) => {
      calls.report.push(p);
      return { ok: true };
    },
  };
}

function fakeExecutor(summary) {
  const runs = [];
  const make = (repo) => async (task, runOpts) => {
    runs.push({ repo, task, runOpts });
    return summary;
  };
  make.runs = runs;
  return make;
}

// Captures every log call as { level, event, fields }; names() gives just the ordered event names.
function fakeLogger() {
  const events = [];
  const rec = (level) => (event, fields = {}) => events.push({ level, event, fields });
  return {
    events,
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    names: () => events.map((e) => e.event),
    find: (name) => events.find((e) => e.event === name),
  };
}

const CLAIM = {
  wake: { id: 'w1', reason: 'execute', context: null },
  runId: 'r1',
  projectKey: 'github.com/acme/app',
  mode: 'execute',
  task: { id: 't1', humanId: 'GFA-1', title: 'x' },
  commentIds: [],
};

test('idle cycle logs a poll heartbeat then an idle line', async () => {
  const board = fakeBoard({ wake: null });
  const log = fakeLogger();
  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: fakeExecutor({}), log });
  assert.equal(res, null, 'control flow unchanged: still returns null when idle');
  assert.deepEqual(log.names(), ['poll', 'idle']);
  assert.equal(log.find('poll').fields.repos, 1, 'poll carries the served-repo count');
  assert.equal(log.find('idle').fields.wake, 'none');
});

test('a claimed+successful task logs poll → claimed → reported', async () => {
  const board = fakeBoard(CLAIM);
  const log = fakeLogger();
  const make = fakeExecutor({ ok: true, done: true, sessionId: 's1' });
  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: make, log });
  assert.equal(res.summary.sessionId, 's1', 'control flow unchanged: returns the summary');
  assert.equal(board.calls.report.length, 1, 'still reported to the board');
  assert.deepEqual(log.names(), ['poll', 'claimed', 'reported']);
  assert.equal(log.find('claimed').fields.task, 'GFA-1');
  assert.equal(log.find('claimed').fields.run, 'r1');
  assert.equal(log.find('reported').fields.ok, true);
  assert.equal(log.find('reported').level, 'info');
});

test('a failing run logs poll → claimed → run_failed (error level) but still reports', async () => {
  const board = fakeBoard(CLAIM);
  const log = fakeLogger();
  const make = fakeExecutor({ ok: false, error: 'boom' });
  await runConnectOnce({ board, repos: REPOS, makeExecutor: make, log });
  assert.equal(board.calls.report.length, 1, 'a failed run is still reported for durability');
  assert.deepEqual(log.names(), ['poll', 'claimed', 'run_failed']);
  const rf = log.find('run_failed');
  assert.equal(rf.level, 'error');
  assert.equal(rf.fields.task, 'GFA-1');
  assert.equal(rf.fields.error, 'boom');
});

test('a claimed repo we do not serve logs poll → no_repo and still reports a crash', async () => {
  const claim = { ...CLAIM, projectKey: 'github.com/other/repo' };
  const board = fakeBoard(claim);
  const log = fakeLogger();
  const make = fakeExecutor({});
  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: make, log });
  assert.equal(res.skipped, 'no-repo', 'control flow unchanged');
  assert.equal(make.runs.length, 0, 'never spawned an executor');
  assert.equal(board.calls.report[0].summary.failureKind, 'crash', 'still reported a crash');
  assert.deepEqual(log.names(), ['poll', 'no_repo']);
  assert.equal(log.find('no_repo').level, 'warn');
});

test('connectLoop surfaces a thrown cycle error as poll_error (preserving fetch failed) and still calls onError', async () => {
  const board = throwingBoard(new Error('fetch failed'));
  const log = fakeLogger();
  const seen = [];
  const loop = connectLoop({
    board,
    repos: REPOS,
    makeExecutor: fakeExecutor({}),
    log,
    once: true,
    onError: (e) => seen.push(e.message),
  });
  const result = await loop.done;
  assert.equal(result.error.message, 'fetch failed', 'control flow unchanged: lastResult carries the error');
  assert.ok(log.names().includes('poll_error'), 'emitted a poll_error event');
  const pe = log.find('poll_error');
  assert.equal(pe.level, 'error');
  assert.ok(pe.fields.error.includes('fetch failed'), 'preserves the fetch failed substring');
  assert.deepEqual(seen, ['fetch failed'], 'existing onError callback still fires');
});
