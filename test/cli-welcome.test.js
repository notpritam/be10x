import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setColorEnabled, width } from '../src/cli/ui.js';
import { wordmark, renderWelcome } from '../src/cli/welcome.js';

// The welcome screen renders from a plain state object — so we assert on its plain-text form.

test('wordmark is 5 aligned rows of equal width', () => {
  const rows = wordmark('BE10X');
  assert.equal(rows.length, 5);
  const w = rows[0].length;
  for (const r of rows) assert.equal(r.length, w, 'every row is the same width (block letters line up)');
});

test('renderWelcome shows signed-in status, board, running agent, and the menu', () => {
  setColorEnabled(false);
  const out = renderWelcome({
    user: 'frontend@emergent.sh',
    board: 'https://be10x.notpritam.in',
    service: 'running',
    repos: ['github.com/acme/app'],
    version: '0.1.0',
  });
  assert.match(out, /frontend@emergent\.sh/);
  assert.match(out, /be10x\.notpritam\.in/);
  assert.match(out, /running/);
  assert.match(out, /account/);
  assert.match(out, /login/);
  assert.match(out, /service/);
  assert.match(out, /v0\.1\.0/);
});

test('renderWelcome shows "signed in" when a token exists but no email is stored', () => {
  setColorEnabled(false);
  const out = renderWelcome({ user: null, signedIn: true, board: 'https://b', service: 'running', repos: [], version: '0.1.0' });
  assert.match(out, /signed in/);
  assert.doesNotMatch(out, /not signed in/);
});

test('renderWelcome nudges a signed-out user toward login and service install', () => {
  setColorEnabled(false);
  const out = renderWelcome({ user: null, board: null, service: 'none', repos: [], version: '0.1.0' });
  assert.match(out, /not signed in/);
  assert.match(out, /be10x login/);
  assert.match(out, /be10x service install/);
});

test('renderWelcome surfaces an update when the latest version differs', () => {
  setColorEnabled(false);
  const out = renderWelcome({ user: 'a@b.co', board: 'b', service: 'running', repos: [], version: '0.1.0', latest: '0.2.0' });
  assert.match(out, /update available \(v0\.2\.0\)/);
  assert.match(out, /be10x update/);
});

test('renderWelcome has no ANSI escapes in plain mode (safe for pipes/logs)', () => {
  setColorEnabled(false);
  const out = renderWelcome({ user: 'a@b.co', board: 'b', service: 'none', repos: [], version: '0.1.0' });
  assert.doesNotMatch(out, /\x1b/);
  assert.ok(width(out.split('\n')[0]) >= 0);
});
