import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUpdate, fetchBoardVersion, makeAutoUpdater } from '../src/connect/auto-update.js';
import { connectLoop } from '../src/connect/connect.js';

const silentLog = { info() {}, warn() {}, error() {} };
const captureLog = () => {
  const events = [];
  return { events, info: (e, f) => events.push(['info', e, f]), warn: (e, f) => events.push(['warn', e, f]), error: (e, f) => events.push(['error', e, f]) };
};
const fakeFetch = (version, { ok = true, throws = false } = {}) => async () => {
  if (throws) throw new Error('fetch failed');
  return { ok, json: async () => ({ version }) };
};
const base = (over = {}) => ({ board: 'https://b', localVersion: '0.1.0', fetchImpl: fakeFetch('0.2.0'), runUpdate: async () => {}, log: silentLog, now: () => 1, loadCooldown: () => null, saveCooldown: () => {}, ...over });

test('shouldUpdate: differ → true; same/missing → false', () => {
  assert.equal(shouldUpdate('0.1.0', '0.2.0'), true);
  assert.equal(shouldUpdate('0.1.0', '0.1.0'), false);
  assert.equal(shouldUpdate('0.1.0', null), false);
  assert.equal(shouldUpdate(null, '0.2.0'), false);
  assert.equal(shouldUpdate('', ''), false);
});

test('fetchBoardVersion: ok → version; !ok or throw → null', async () => {
  assert.equal(await fetchBoardVersion('https://b/', { fetchImpl: fakeFetch('0.2.0') }), '0.2.0');
  assert.equal(await fetchBoardVersion('https://b', { fetchImpl: fakeFetch('0.2.0', { ok: false }) }), null);
  assert.equal(await fetchBoardVersion('https://b', { fetchImpl: fakeFetch('x', { throws: true }) }), null);
});

test('maybeUpdate: triggers runUpdate + logs when board version differs', async () => {
  let ran = 0;
  const log = captureLog();
  const up = makeAutoUpdater(base({ runUpdate: async () => { ran++; }, log }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, true);
  assert.equal(r.boardVersion, '0.2.0');
  assert.equal(ran, 1);
  assert.deepEqual(log.events[0], ['info', 'self_update', { from: '0.1.0', to: '0.2.0' }]);
});

test('maybeUpdate: no-op when versions match', async () => {
  let ran = 0;
  const up = makeAutoUpdater(base({ localVersion: '0.2.0', runUpdate: async () => { ran++; } }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, false);
  assert.equal(ran, 0);
});

test('maybeUpdate: throttled within minIntervalMs', async () => {
  let ran = 0, t = 0;
  const up = makeAutoUpdater(base({ runUpdate: async () => { ran++; }, minIntervalMs: 1000, now: () => t }));
  t = 0; await up.maybeUpdate();
  t = 500; const r = await up.maybeUpdate();
  assert.equal(r.checked, false);
  assert.equal(r.reason, 'throttled');
  assert.equal(ran, 1);
});

test('maybeUpdate: cross-restart cooldown skips a recently-attempted target', async () => {
  let ran = 0;
  const up = makeAutoUpdater(base({ runUpdate: async () => { ran++; }, minIntervalMs: 1000, now: () => 5000, loadCooldown: () => ({ version: '0.2.0', at: 4500 }) }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(ran, 0);
});

test('maybeUpdate: a DIFFERENT recent target does not block the current one', async () => {
  let ran = 0;
  const up = makeAutoUpdater(base({ runUpdate: async () => { ran++; }, minIntervalMs: 1000, now: () => 5000, loadCooldown: () => ({ version: '0.1.9', at: 4900 }) }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, true);
  assert.equal(ran, 1);
});

test('maybeUpdate: runUpdate failure is caught + logged, never thrown', async () => {
  const log = captureLog();
  const up = makeAutoUpdater(base({ runUpdate: async () => { throw new Error('npm boom'); }, log }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, false);
  assert.match(r.error, /npm boom/);
  assert.equal(log.events.at(-1)[1], 'self_update_failed');
});

test('maybeUpdate: board unreachable → no update attempt', async () => {
  let ran = 0;
  const up = makeAutoUpdater(base({ fetchImpl: fakeFetch('x', { throws: true }), runUpdate: async () => { ran++; } }));
  const r = await up.maybeUpdate();
  assert.equal(r.updated, false);
  assert.equal(ran, 0);
});

test('connectLoop invokes autoUpdater.maybeUpdate on its cycles (not in once mode)', async () => {
  let calls = 0;
  const ref = {};
  // Stop from inside the first check so the loop breaks cleanly (before the next sleep) and `done` resolves.
  const autoUpdater = { maybeUpdate: async () => { calls++; ref.handle?.stop(); return {}; } };
  const board = { claim: async () => null }; // idle every poll
  ref.handle = connectLoop({ board, repos: [{ key: 'k', path: '/p' }], makeExecutor: () => async () => ({}), workerId: 'test', intervalMs: 5, once: false, autoUpdater, log: silentLog });
  await ref.handle.done;
  assert.equal(calls, 1);
});
