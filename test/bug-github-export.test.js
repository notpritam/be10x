// ABOUTME: Tests the optional GitHub issue export — the no-config degrade, a mocked GitHub call, the cache
// ABOUTME: setter, and the privacy invariant that the issue body NEVER contains the test credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug, getBug, setBugGithubIssue } from '../src/bugs/bugs.js';
import { bugToIssueMarkdown, createGithubIssue } from '../src/bugs/github-export.js';

function seedBug() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@b.co', displayName: 'QA', password: 'pw123456' });
  const bug = createBug(db, {
    reporterId: user.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    severity: 'high',
    meta: {
      notes: 'Click pay, nothing happens',
      console: [{ ts: 1, level: 'error', text: 'TypeError: total is undefined at Pay.tsx:42' }],
      pickedElements: [{ selector: 'button#pay', tag: 'BUTTON', rect: { x: 0, y: 0, w: 1, h: 1 }, react: { component: 'PayButton', source: 'src/checkout/Pay.tsx:42' } }],
      credentials: { username: 'qa@example.com', password: 'SuperSecret123!' },
      environment: { brands: ['Chrome 152'], platform: 'macOS', screen: { w: 1920, h: 1080 } },
    },
  });
  return { db, bug };
}

test('bugToIssueMarkdown includes the RCA + env but NEVER the credentials', () => {
  const { bug } = seedBug();
  const md = bugToIssueMarkdown(bug, { bugUrl: 'https://be10x.notpritam.in' });
  assert.match(md, /Pay button dead|BUG-001/);
  assert.match(md, /Likely root cause/);
  assert.match(md, /PayButton/);
  assert.match(md, /Chrome 152/);
  assert.doesNotMatch(md, /SuperSecret123!/);
  assert.doesNotMatch(md, /qa@example\.com/);
});

test('createGithubIssue throws NO_GITHUB_CONFIG without token/repo', async () => {
  const { bug } = seedBug();
  await assert.rejects(() => createGithubIssue(bug, { token: '', repo: '' }), /NO_GITHUB_CONFIG/);
  await assert.rejects(() => createGithubIssue(bug, { token: 'x', repo: '' }), /NO_GITHUB_CONFIG/);
});

test('createGithubIssue posts to the repo and returns html_url (mocked)', async () => {
  const { bug } = seedBug();
  let sentUrl = null;
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ html_url: 'https://github.com/acme/app/issues/7', number: 7 }) };
  };
  const out = await createGithubIssue(bug, { token: 't', repo: 'acme/app', bugUrl: 'https://be10x', fetchImpl });
  assert.equal(sentUrl, 'https://api.github.com/repos/acme/app/issues');
  assert.match(sentBody.title, /\[be10x BUG-001\] Pay button dead/);
  assert.doesNotMatch(sentBody.body, /SuperSecret123!/);
  assert.equal(out.url, 'https://github.com/acme/app/issues/7');
  assert.equal(out.number, 7);
});

test('createGithubIssue surfaces a non-OK response as an error', async () => {
  const { bug } = seedBug();
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' });
  await assert.rejects(() => createGithubIssue(bug, { token: 'bad', repo: 'acme/app', fetchImpl }), /GITHUB_HTTP_401/);
});

test('setBugGithubIssue caches the issue URL on the bug meta', () => {
  const { db, bug } = seedBug();
  const updated = setBugGithubIssue(db, bug.id, 'https://github.com/acme/app/issues/7');
  assert.equal(updated.meta.githubIssueUrl, 'https://github.com/acme/app/issues/7');
  assert.equal(getBug(db, bug.id).meta.githubIssueUrl, 'https://github.com/acme/app/issues/7');
  assert.equal(getBug(db, bug.id).meta.pickedElements.length, 1); // capture survives the merge
});
