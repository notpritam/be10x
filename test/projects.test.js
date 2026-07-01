import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { keyFromRemote, registerProject, getProjectByKey, getProject, listProjects } from '../src/projects/projects.js';

test('keyFromRemote normalizes https and scp remotes to the same key', () => {
  const https = keyFromRemote('https://github.com/org/repo.git');
  const scp = keyFromRemote('git@github.com:org/repo.git');
  assert.equal(https, 'github.com/org/repo');
  assert.equal(scp, 'github.com/org/repo');
  assert.equal(https, scp);
});

test('keyFromRemote strips auth, port, scheme and lowercases', () => {
  assert.equal(keyFromRemote('https://user:pass@GitHub.com/Org/Repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('ssh://git@github.com/org/repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('ssh://git@github.com:2222/org/repo.git'), 'github.com/org/repo');
  assert.equal(keyFromRemote('https://github.com/org/repo/'), 'github.com/org/repo');
});

test('registerProject is idempotent by key', () => {
  const db = openDb(':memory:');
  const first = registerProject(db, { key: 'github.com/org/repo', name: 'Repo', rootPath: '/tmp/repo', defaultBranch: 'main' });
  const again = registerProject(db, { key: 'github.com/org/repo', name: 'Different name' });
  assert.equal(first.id, again.id);
  assert.equal(again.name, 'Repo'); // existing row returned unchanged
  assert.equal(listProjects(db).length, 1);
});

test('getProjectByKey and getProject round-trip a registered project', () => {
  const db = openDb(':memory:');
  const p = registerProject(db, { key: 'local:my-app', name: 'My App', rootPath: '/work/my-app', defaultBranch: 'develop' });
  const byKey = getProjectByKey(db, 'local:my-app');
  assert.equal(byKey.id, p.id);
  assert.equal(byKey.key, 'local:my-app');
  assert.equal(byKey.name, 'My App');
  assert.equal(byKey.rootPath, '/work/my-app');
  assert.equal(byKey.defaultBranch, 'develop');
  assert.equal(getProject(db, p.id).key, 'local:my-app');
  assert.equal(getProjectByKey(db, 'nope'), null);
});
