// ABOUTME: Pure formatter for `be10x ps` — turns fleet rows into a compact aligned table + relative ages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFleetTable, relAge, shortSession } from '../src/cli/fleet-format.js';

test('shortSession takes the leading 8 chars, or - when absent', () => {
  assert.equal(shortSession('a1b2c3d4e5f6'), 'a1b2c3d4');
  assert.equal(shortSession(null), '-');
  assert.equal(shortSession(undefined), '-');
});

test('relAge renders compact relative ages', () => {
  assert.equal(relAge(5000), '5s');
  assert.equal(relAge(90000), '1m');
  assert.equal(relAge(3 * 3600000), '3h');
  assert.equal(relAge(null), '-');
});

test('formatFleetTable includes the key columns for each session', () => {
  const out = formatFleetTable([
    { humanId: 'GFA-1', phase: 'implement', state: 'working', stalled: false, ageMs: 5000,
      sessionId: 'sess1234abcd', host: 'mac-pritam', assignee: { displayName: 'Pat' }, project: { key: 'github.com/x/y' } },
    { humanId: 'GFA-2', phase: 'plan', state: 'stalled', stalled: true, ageMs: 700000,
      sessionId: null, host: null, assignee: null, project: null },
  ]);
  assert.match(out, /GFA-1/);
  assert.match(out, /implement/);
  assert.match(out, /working/);
  assert.match(out, /Pat/);
  assert.match(out, /github\.com\/x\/y/);
  assert.match(out, /GFA-2/);
  // session id (short) + host surface as their own columns
  assert.match(out, /SESSION/);
  assert.match(out, /HOST/);
  assert.match(out, /sess1234/);
  assert.match(out, /mac-pritam/);
  // a stalled row surfaces "stalled" regardless of the stored state
  assert.match(out, /stalled/);
});

test('formatFleetTable handles an empty fleet', () => {
  assert.match(formatFleetTable([]), /no active sessions/i);
});
