// ABOUTME: Pure formatter for `be10x ps` — turns fleet rows into a compact aligned table + relative ages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFleetTable, relAge } from '../src/cli/fleet-format.js';

test('relAge renders compact relative ages', () => {
  assert.equal(relAge(5000), '5s');
  assert.equal(relAge(90000), '1m');
  assert.equal(relAge(3 * 3600000), '3h');
  assert.equal(relAge(null), '-');
});

test('formatFleetTable includes the key columns for each session', () => {
  const out = formatFleetTable([
    { humanId: 'GFA-1', phase: 'implement', state: 'working', stalled: false, ageMs: 5000,
      assignee: { displayName: 'Pat' }, project: { key: 'github.com/x/y' } },
    { humanId: 'GFA-2', phase: 'plan', state: 'stalled', stalled: true, ageMs: 700000,
      assignee: null, project: null },
  ]);
  assert.match(out, /GFA-1/);
  assert.match(out, /implement/);
  assert.match(out, /working/);
  assert.match(out, /Pat/);
  assert.match(out, /github\.com\/x\/y/);
  assert.match(out, /GFA-2/);
  // a stalled row surfaces "stalled" regardless of the stored state
  assert.match(out, /stalled/);
});

test('formatFleetTable handles an empty fleet', () => {
  assert.match(formatFleetTable([]), /no active sessions/i);
});
