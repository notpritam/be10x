// ABOUTME: Tests the pure bug-debugging MCP registry (src/mcp/bug-tools.js) by calling handler(db, ctx, args)
// ABOUTME: directly — bug resolution (id / BUG-id / share token / URL), the sync capture tools, the heuristic
// ABOUTME: analysis, and the graceful no-artifact path. No transport/SDK; the server wiring is intentionally thin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug } from '../src/bugs/bugs.js';
import { createBugShareLink } from '../src/share/bug-share.js';
import { BUG_TOOLS, getBugTool, resolveBug } from '../src/mcp/bug-tools.js';

function call(db, ctx, name, args = {}) {
  const tool = getBugTool(name);
  assert.ok(tool, `tool "${name}" is registered`);
  return tool.handler(db, ctx, args);
}

const START = 1_000_000;
function seed() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@be10x.co', displayName: 'QA', password: 'pw123456' });
  const ctx = { userId: user.id };
  const bug = createBug(db, {
    reporterId: user.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    severity: 'high',
    tags: ['checkout'],
    identity: { loggedIn: true, email: 'qa@example.com' },
    meta: {
      notes: 'Click pay, nothing happens.\nExpected: order confirms.',
      errorCount: 2,
      console: [
        { ts: START + 500, level: 'log', text: 'mounted' },
        { ts: START + 1200, level: 'error', text: "TypeError: can't read 'total' of undefined\n  at Pay.tsx:42" },
        { ts: START + 1300, level: 'error', text: 'Unhandled promise rejection: 500' },
      ],
      pickedElements: [
        {
          selector: 'button#pay',
          tag: 'BUTTON',
          rect: { x: 1, y: 2, w: 3, h: 4 },
          ts: START + 1000,
          note: 'this button does nothing',
          react: { component: 'PayButton', source: 'src/checkout/Pay.tsx:42' },
        },
      ],
      drawings: [{ ts: START + 1100, tEnd: START + 1400, color: '#ef4444', width: 3.5, points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }] }],
      credentials: { username: 'qa@example.com', password: 'Secret1!', notes: 'admin' },
      environment: { userAgent: 'Mozilla/5.0 Chrome/152', timezone: 'Asia/Kolkata', screen: { w: 1920, h: 1080, dpr: 2 } },
      markers: [
        { t: START + 900, label: 'this is the bug', kind: 'user' },
        { t: START + 1200, label: 'TypeError…', kind: 'error' },
      ],
      visits: [{ t: START, url: 'https://app.example.com/checkout', title: 'Checkout' }],
      recording: { startedAt: START, endedAt: START + 5000, durationMs: 5000, mode: 'explicit' },
      viewport: { w: 1280, h: 800 },
    },
  });
  return { db, user, ctx, bug };
}

test('BUG_TOOLS are all well-formed', () => {
  assert.ok(BUG_TOOLS.length >= 12);
  for (const t of BUG_TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.handler, 'function');
  }
});

test('resolveBug: by uuid, human id, and share token; junk throws NO_BUG', () => {
  const { db, bug } = seed();
  assert.equal(resolveBug(db, bug.id).id, bug.id);
  assert.equal(resolveBug(db, bug.humanId).id, bug.id);
  assert.equal(resolveBug(db, bug.humanId.toLowerCase()).id, bug.id);
  const link = createBugShareLink(db, { bugId: bug.id });
  assert.equal(resolveBug(db, link.token).id, bug.id);
  assert.equal(resolveBug(db, `https://be10x.notpritam.in/b/${link.token}`).id, bug.id);
  assert.throws(() => resolveBug(db, 'not-a-real-bug'), /NO_BUG/);
});

test('bug_list returns headers with error counts', () => {
  const { db, ctx, bug } = seed();
  const res = call(db, ctx, 'bug_list', {});
  assert.equal(res.count, 1);
  assert.equal(res.bugs[0].humanId, bug.humanId);
  assert.equal(res.bugs[0].errorCount, 2);
});

test('bug_get returns counts + capability flags', () => {
  const { db, ctx, bug } = seed();
  const g = call(db, ctx, 'bug_get', { bug: bug.humanId });
  assert.equal(g.counts.errors, 2);
  assert.equal(g.counts.pickedElements, 1);
  assert.equal(g.counts.drawings, 1);
  assert.equal(g.credentials.hasPassword, true);
  assert.equal(g.credentials.username, 'qa@example.com');
  // never leak the raw password through bug_get
  assert.equal(g.credentials.password, undefined);
});

test('bug_console filters by level and stamps offsets', () => {
  const { db, ctx, bug } = seed();
  const errs = call(db, ctx, 'bug_console', { bug: bug.id, level: 'error' });
  assert.equal(errs.entries.length, 2);
  assert.equal(errs.entries[0].offsetMs, 1200);
});

test('bug_picked_elements surfaces note + react source', () => {
  const { db, ctx, bug } = seed();
  const p = call(db, ctx, 'bug_picked_elements', { bug: bug.id }).elements[0];
  assert.equal(p.note, 'this button does nothing');
  assert.equal(p.react.component, 'PayButton');
});

test('bug_drawings returns a normalized bbox + offset', () => {
  const { db, ctx, bug } = seed();
  const s = call(db, ctx, 'bug_drawings', { bug: bug.id }).strokes[0];
  assert.equal(s.offsetMs, 1100);
  assert.deepEqual(s.bbox, { x: 0.1, y: 0.2, w: 0.4, h: 0.4 });
});

test('bug_credentials returns the raw login (for reproduction)', () => {
  const { db, ctx, bug } = seed();
  assert.equal(call(db, ctx, 'bug_credentials', { bug: bug.id }).credentials.password, 'Secret1!');
});

test('bug_analyze pins the component + high confidence when an error and a picked component coincide', () => {
  const { db, ctx, bug } = seed();
  const a = call(db, ctx, 'bug_analyze', { bug: bug.id });
  assert.match(a.suspectedCause, /TypeError/);
  assert.equal(a.suspectedComponent, 'PayButton');
  assert.equal(a.suspectedSource, 'src/checkout/Pay.tsx:42');
  assert.equal(a.confidence, 'high');
  assert.ok(a.reproSteps.length >= 1);
});

test('artifact tools degrade gracefully when the bug has no such capture', async () => {
  const { db, ctx, bug } = seed(); // no networkKey/sessionKey/domKey uploaded
  await assert.rejects(() => call(db, ctx, 'bug_network', { bug: bug.id }), /NO_ARTIFACT:network/);
  await assert.rejects(() => call(db, ctx, 'bug_dom_at', { bug: bug.id, atMs: 1000 }), /NO_ARTIFACT:session/);
});
