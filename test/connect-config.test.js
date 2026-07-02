import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertRepo } from '../src/connect/connect.js';

// upsertRepo backs `be10x link` remembering repos: adding is idempotent by key, and re-linking a moved repo
// updates its path in place rather than piling up duplicates that would make `be10x connect` serve stale paths.

test('adds a new repo to an empty/absent list', () => {
  assert.deepEqual(upsertRepo(undefined, { key: 'k1', path: '/a' }), [{ key: 'k1', path: '/a' }]);
  assert.deepEqual(upsertRepo([], { key: 'k1', path: '/a' }), [{ key: 'k1', path: '/a' }]);
});

test('appends a distinct repo, keeping existing ones', () => {
  const out = upsertRepo([{ key: 'k1', path: '/a' }], { key: 'k2', path: '/b' });
  assert.deepEqual(out, [{ key: 'k1', path: '/a' }, { key: 'k2', path: '/b' }]);
});

test('re-linking the same key updates the path in place (no duplicate)', () => {
  const out = upsertRepo([{ key: 'k1', path: '/old' }, { key: 'k2', path: '/b' }], { key: 'k1', path: '/new' });
  assert.equal(out.filter((r) => r.key === 'k1').length, 1, 'no duplicate key');
  assert.equal(out.find((r) => r.key === 'k1').path, '/new', 'newest path wins');
});

test('normalizes each entry to just { key, path }', () => {
  const out = upsertRepo([], { key: 'k1', path: '/a', extra: 'ignored', defaultBranch: 'main' });
  assert.deepEqual(out, [{ key: 'k1', path: '/a' }]);
});
