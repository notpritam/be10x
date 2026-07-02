import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callBoard } from '../src/mcp/http-server.js';

// The HTTP MCP transport forwards each gfa_* call to the board's /api/agent/rpc gateway. These pin the
// wire contract (URL, method, bearer header, body) and the result/error mapping, with fetch injected.

function fakeFetch(status, json) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test('callBoard POSTs { tool, args } to /api/agent/rpc with the bearer token and returns result', async () => {
  const f = fakeFetch(200, { result: { id: 't1', title: 'x' } });
  const out = await callBoard('gfa_get_task', { taskId: 't1' }, { board: 'https://board.test', token: 'gfa_abc', fetchImpl: f });

  assert.deepEqual(out, { id: 't1', title: 'x' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://board.test/api/agent/rpc');
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer gfa_abc');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { tool: 'gfa_get_task', args: { taskId: 't1' } });
});

test('callBoard normalises a trailing slash on the board URL', async () => {
  const f = fakeFetch(200, { result: null });
  await callBoard('gfa_list_tasks', {}, { board: 'https://board.test/', token: 't', fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://board.test/api/agent/rpc');
});

test('callBoard throws the board domain error on a non-2xx', async () => {
  const f = fakeFetch(404, { error: 'NO_TASK' });
  await assert.rejects(
    () => callBoard('gfa_get_task', { taskId: 'nope' }, { board: 'https://board.test', token: 't', fetchImpl: f }),
    /NO_TASK/
  );
});

test('callBoard requires a board URL', async () => {
  await assert.rejects(() => callBoard('gfa_list_tasks', {}, { board: '', token: 't', fetchImpl: fakeFetch(200, {}) }), /GFA_BOARD_URL/);
});
