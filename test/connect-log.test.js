import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogger } from '../src/connect/log.js';

// A structured single-line logger for the connector: `<ISO> <LEVEL> <event> <k=v ...>`. `now`/`out` injected
// so tests capture the exact bytes written and pin the timestamp. These lines land in ~/.be10x/connect.log
// (the LaunchAgent tees stdout there), so they must stay one line each and greppable.

// Capture out.write() calls; return { lines() } giving the written lines without trailing newlines.
function fakeOut() {
  const writes = [];
  return {
    write: (s) => writes.push(s),
    writes,
    lines: () => writes.join('').split('\n').filter(Boolean),
  };
}

const FIXED = () => new Date('2020-01-01T00:00:00.000Z');

test('info writes one timestamped INFO line with k=v fields', () => {
  const out = fakeOut();
  const log = makeLogger({ now: FIXED, out });
  log.info('poll', { wake: 'none' });
  assert.equal(out.writes.length, 1, 'exactly one write');
  assert.match(out.writes[0], /\n$/, 'line is newline-terminated');
  assert.match(out.lines()[0], /^2020-01-01T00:00:00.000Z INFO poll wake=none$/);
});

test('error line quotes values with spaces but preserves the substring (fetch failed)', () => {
  const out = fakeOut();
  const log = makeLogger({ now: FIXED, out });
  log.error('claim_failed', { error: 'fetch failed' });
  const line = out.lines()[0];
  assert.match(line, /^2020-01-01T00:00:00.000Z ERROR claim_failed /);
  assert.ok(line.includes('fetch failed'), 'preserves the fetch failed substring for grep habits');
});

test('warn uppercases the level; an event with no fields has no trailing space', () => {
  const out = fakeOut();
  const log = makeLogger({ now: FIXED, out });
  log.warn('degraded');
  assert.equal(out.lines()[0], '2020-01-01T00:00:00.000Z WARN degraded');
});

test('multiple fields are space-joined in order; numbers/booleans render bare', () => {
  const out = fakeOut();
  const log = makeLogger({ now: FIXED, out });
  log.info('reported', { task: 'GFA-1', ok: true, repos: 3 });
  assert.equal(out.lines()[0], '2020-01-01T00:00:00.000Z INFO reported task=GFA-1 ok=true repos=3');
});

test('undefined fields are skipped so optional ids do not litter the line', () => {
  const out = fakeOut();
  const log = makeLogger({ now: FIXED, out });
  log.info('claimed', { task: 'GFA-2', run: undefined });
  assert.equal(out.lines()[0], '2020-01-01T00:00:00.000Z INFO claimed task=GFA-2');
});

test('defaults to a real clock + process.stdout when nothing is injected', () => {
  // Just proves the factory constructs with no args (writing to stdout) without throwing.
  const log = makeLogger();
  assert.equal(typeof log.info, 'function');
  assert.equal(typeof log.warn, 'function');
  assert.equal(typeof log.error, 'function');
});
