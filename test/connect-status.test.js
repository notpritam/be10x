import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleStatus, pickLastTask } from '../src/connect/status.js';

// `be10x status` folds four injected probes — saved config, live board connectivity, the running background
// service, and the tail of the structured log — into one shaped snapshot. assembleStatus is pure (every
// side-effecting input injected) so we can assert the exact shape without a board, launchctl, or a real log file.

test('a signed-in, connected, running connector assembles a healthy snapshot', async () => {
  const status = await assembleStatus({
    config: { board: 'https://board.test', token: 'gfa_x', user: 'me@x.dev' },
    probe: async () => ({ ok: true, projectCount: 3 }),
    service: async () => ({ running: true, pid: 4242 }),
    tailEvents: async () => ['2020-01-01T00:00:00.000Z INFO poll repos=2', '2020-01-01T00:00:03.000Z INFO idle wake=none'],
  });
  assert.equal(status.signedIn, true);
  assert.equal(status.board, 'https://board.test');
  assert.deepEqual(status.service, { running: true, pid: 4242 });
  assert.deepEqual(status.connectivity, { ok: true, projectCount: 3 });
  assert.equal(status.lastEvents.length, 2);
});

test('no token → not signed in, and the board is never probed', async () => {
  let probed = false;
  const status = await assembleStatus({
    config: { board: 'https://board.test' },
    probe: async () => {
      probed = true;
      return { ok: true, projectCount: 9 };
    },
    service: async () => ({ running: false, pid: null }),
    tailEvents: async () => [],
  });
  assert.equal(status.signedIn, false);
  assert.equal(probed, false, 'skips the network probe when there is no token to probe with');
  assert.equal(status.connectivity.ok, false);
  assert.equal(status.connectivity.error, 'not signed in');
});

test('an unreachable board surfaces connectivity.ok=false with the error', async () => {
  const status = await assembleStatus({
    config: { board: 'https://board.test', token: 'gfa_x' },
    probe: async () => ({ ok: false, error: 'fetch failed' }),
    service: async () => ({ running: true, pid: 1 }),
    tailEvents: async () => [],
  });
  assert.equal(status.connectivity.ok, false);
  assert.ok(status.connectivity.error.includes('fetch failed'));
});

test('a stopped service reports running=false, pid=null; defaults are safe when deps are absent', async () => {
  const status = await assembleStatus({
    config: { board: 'b', token: 't' },
    probe: async () => ({ ok: true, projectCount: 0 }),
    service: async () => ({ running: false, pid: null }),
  });
  assert.deepEqual(status.service, { running: false, pid: null });
  assert.deepEqual(status.lastEvents, [], 'lastEvents defaults to [] when no tailEvents injected');
});

test('pickLastTask returns the most recent task id from structured log lines, else null', () => {
  assert.equal(
    pickLastTask([
      '2020-01-01T00:00:00.000Z INFO poll repos=2',
      '2020-01-01T00:00:03.000Z INFO claimed task=GFA-1 run=r1 mode=execute',
      '2020-01-01T00:00:09.000Z INFO reported task=GFA-1 ok=true',
    ]),
    'GFA-1'
  );
  assert.equal(
    pickLastTask(['... claimed task=GFA-1 run=a', '... claimed task=GFA-2 run=b']),
    'GFA-2',
    'newest task wins'
  );
  assert.equal(pickLastTask(['2020-01-01T00:00:00.000Z INFO poll repos=0', '... INFO idle wake=none']), null);
  assert.equal(pickLastTask([]), null);
});
