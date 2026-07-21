// ABOUTME: The connector's notification poll — fetch since the local watermark, show each as an OS
// ABOUTME: notification, advance the watermark (exactly-once, catches up while offline). Injectable fetch+show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifyOnce } from '../src/connect/notify-loop.js';

function fakeFetch(byUrl) {
  return async (url) => {
    const since = Number(new URL(url).searchParams.get('since')) || 0;
    const all = byUrl;
    const fresh = all.filter((n) => n.seq > since);
    return { ok: true, json: async () => ({ notifications: fresh }) };
  };
}

test('shows fresh notifications and advances the watermark', async () => {
  const shown = [];
  const state = { enabled: true, lastSeq: {} };
  const board = 'https://board.test';
  const fetchImpl = fakeFetch([{ seq: 1, title: 'one', body: 'a' }, { seq: 2, title: 'two', body: 'b' }]);
  const show = (n) => shown.push(n.title);

  const r1 = await runNotifyOnce({ board, token: 'tk', state, fetchImpl, show });
  assert.equal(r1.shown, 2);
  assert.deepEqual(shown, ['one', 'two']);
  assert.equal(state.lastSeq[board], 2, 'watermark advanced');

  // second poll: nothing newer than seq 2 → shows nothing
  const r2 = await runNotifyOnce({ board, token: 'tk', state, fetchImpl, show });
  assert.equal(r2.shown, 0);
  assert.equal(shown.length, 2);
});

test('disabled → no fetch, no notifications', async () => {
  let fetched = false;
  const state = { enabled: false, lastSeq: {} };
  const r = await runNotifyOnce({ board: 'b', token: 't', state, fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; }, show: () => {} });
  assert.equal(r.shown, 0);
  assert.equal(fetched, false);
});

test('a network/HTTP failure is swallowed (never breaks the connector loop)', async () => {
  const state = { enabled: true, lastSeq: {} };
  const r = await runNotifyOnce({ board: 'b', token: 't', state, fetchImpl: async () => { throw new Error('down'); }, show: () => {} });
  assert.equal(r.shown, 0);
});
