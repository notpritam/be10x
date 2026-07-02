import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeBoardClient,
  runConnectOnce,
  connectLoop,
  writeMcpConfig,
  saveConnectConfig,
  loadConnectConfig,
} from '../src/connect/connect.js';

// A fake board client capturing claim/report calls; `claimResult` is what claim() returns.
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

// A fake executor factory recording the repo it was built for and the runOpts it was called with.
function fakeExecutor(summary) {
  const runs = [];
  const make = (repo) => async (task, runOpts) => {
    runs.push({ repo, task, runOpts });
    return summary;
  };
  make.runs = runs;
  return make;
}

function fakeFetch(status, json) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

const REPOS = [{ key: 'github.com/acme/app', path: '/home/me/app', defaultBranch: 'main' }];

test('runConnectOnce claims, runs the matching local repo, and reports the summary', async () => {
  const claim = {
    wake: { id: 'w1', reason: 'execute', context: { verdict: 'approved' } },
    runId: 'r1',
    projectKey: 'github.com/acme/app',
    mode: 'execute',
    task: { id: 't1', humanId: 'GFA-1', title: 'x' },
    comments: [{ id: 'c1', body: 'go' }],
    commentIds: ['c1'],
    resume: undefined,
    resumeSessionId: 'sess-prev',
  };
  const board = fakeBoard(claim);
  const make = fakeExecutor({ ok: true, done: true, mode: 'execute', sessionId: 'sess-new' });

  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: make, workerId: 'connect:me' });

  assert.equal(res.summary.sessionId, 'sess-new');
  // Claimed for the served repo keys.
  assert.deepEqual(board.calls.claim[0].projectKeys, ['github.com/acme/app']);
  // Ran in the matching local checkout with the wake's mode/context/comments/resume from the board.
  assert.equal(make.runs.length, 1);
  assert.equal(make.runs[0].repo.path, '/home/me/app');
  assert.equal(make.runs[0].runOpts.mode, 'execute');
  assert.equal(make.runs[0].runOpts.resumeSessionId, 'sess-prev');
  assert.deepEqual(make.runs[0].runOpts.wakeContext, { verdict: 'approved' });
  assert.equal(make.runs[0].runOpts.comments[0].id, 'c1');
  // Reported the outcome with the claimed ids.
  const rep = board.calls.report[0];
  assert.equal(rep.wakeId, 'w1');
  assert.equal(rep.runId, 'r1');
  assert.equal(rep.taskId, 't1');
  assert.deepEqual(rep.commentIds, ['c1']);
  assert.equal(rep.summary.sessionId, 'sess-new');
});

test('runConnectOnce returns null and never reports when nothing is ready', async () => {
  const board = fakeBoard({ wake: null });
  const make = fakeExecutor({});
  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: make, workerId: 'w' });
  assert.equal(res, null);
  assert.equal(board.calls.report.length, 0);
  assert.equal(make.runs.length, 0);
});

test('runConnectOnce reports a crash (never runs) for a claimed repo it has no local checkout of', async () => {
  const claim = {
    wake: { id: 'w1', reason: 'execute' },
    runId: 'r1',
    projectKey: 'github.com/other/repo',
    mode: 'execute',
    task: { id: 't1' },
    commentIds: [],
  };
  const board = fakeBoard(claim);
  const make = fakeExecutor({});
  const res = await runConnectOnce({ board, repos: REPOS, makeExecutor: make, workerId: 'w' });

  assert.equal(res.skipped, 'no-repo');
  assert.equal(make.runs.length, 0, 'never spawned an executor for a repo we do not serve');
  assert.equal(board.calls.report[0].summary.failureKind, 'crash');
});

test('connectLoop --once runs a single claim pass', async () => {
  const board = fakeBoard({ wake: null });
  const loop = connectLoop({ board, repos: REPOS, makeExecutor: fakeExecutor({}), once: true });
  const result = await loop.done;
  assert.equal(result, null);
  assert.equal(board.calls.claim.length, 1);
});

test('makeBoardClient posts to the runner API with the bearer token, normalising the base URL', async () => {
  const f = fakeFetch(200, { wake: null });
  const client = makeBoardClient({ board: 'https://board.test/', token: 'gfa_x', fetchImpl: f });
  await client.claim(['k'], 'connect:me');
  assert.equal(f.calls[0].url, 'https://board.test/api/agent/claim');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer gfa_x');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { projectKeys: ['k'], workerId: 'connect:me' });
});

test('writeMcpConfig writes a board-pointing .be10x/mcp.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-connect-'));
  const out = writeMcpConfig(dir, { board: 'https://board.test', token: 'gfa_x', httpMcpServerPath: '/abs/http-server.js' });
  const cfg = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(cfg.mcpServers.be10x.command, 'node');
  assert.deepEqual(cfg.mcpServers.be10x.args, ['/abs/http-server.js']);
  assert.equal(cfg.mcpServers.be10x.env.GFA_BOARD_URL, 'https://board.test');
  assert.equal(cfg.mcpServers.be10x.env.GFA_TOKEN, 'gfa_x');
});

test('connect config save/load roundtrips; a missing file loads as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-cfg-'));
  const cfgPath = join(dir, 'connect.json');
  saveConnectConfig({ board: 'b', token: 't', repos: [{ key: 'k', path: '/p' }] }, cfgPath);
  const loaded = loadConnectConfig(cfgPath);
  assert.equal(loaded.board, 'b');
  assert.equal(loaded.repos[0].key, 'k');
  assert.equal(loadConnectConfig(join(dir, 'nope.json')), null);
});
