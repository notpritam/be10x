// ABOUTME: Unit tests for the pure bugs store (src/bugs/bugs.js) against a real in-memory SQLite db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import {
  createBug,
  getBug,
  listBugs,
  updateBugStatus,
  addBugComment,
  listBugEvents,
  bugStatsForUser,
} from '../src/bugs/bugs.js';

function seedUser(db, email = 'qa@b.co') {
  return createUser(db, { email, displayName: 'QA', password: 'pw12345' });
}

test('createBug stores a bug and getBug hydrates it', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const bug = createBug(db, {
    reporterId: u.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    description: 'Nothing happens on click',
    severity: 'high',
    screenshotKey: 'k-shot',
    domKey: 'k-dom',
    networkKey: 'k-net',
    sessionKey: 'k-session',
    identity: { loggedIn: true, email: 'buyer@x.co' },
    meta: {
      selector: '#pay',
      viewport: { w: 1440, h: 900 },
      markers: [{ t: 1783619469393, label: 'This is the bug' }],
      recording: { startedAt: 1783619400000, endedAt: 1783619470000, durationMs: 70000, mode: 'rolling' },
    },
  });
  assert.equal(bug.humanId, 'BUG-001');
  assert.equal(bug.status, 'open');
  assert.equal(bug.severity, 'high');
  assert.equal(bug.reporterId, u.id);
  assert.equal(bug.pageUrl, 'https://app.example.com/checkout');
  assert.equal(bug.identity.email, 'buyer@x.co');
  assert.equal(bug.meta.selector, '#pay');
  // The rrweb session key round-trips as its own column; markers + recording window ride in meta_json.
  assert.equal(bug.sessionKey, 'k-session');
  assert.equal(bug.meta.markers[0].label, 'This is the bug');
  assert.equal(bug.meta.recording.mode, 'rolling');
  const got = getBug(db, bug.id);
  assert.equal(got.title, 'Pay button dead');
  assert.equal(got.sessionKey, 'k-session');
  // A bug filed before session recording existed keeps a null session key (older-bug fallback path).
  const legacy = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'no session' });
  assert.equal(legacy.sessionKey, null);
  assert.equal(getBug(db, 'nope'), null);
});

test('createBug rejects an unknown severity and missing fields', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  assert.throws(() => createBug(db, { reporterId: u.id, pageUrl: 'x', title: 't', severity: 'spicy' }), /INVALID_SEVERITY/);
  assert.throws(() => createBug(db, { pageUrl: 'x', title: 't' }), /MISSING_FIELD:reporterId/);
  assert.throws(() => createBug(db, { reporterId: u.id, title: 't' }), /MISSING_FIELD:pageUrl/);
});

test('createBug stores tags as a JSON array and getBug hydrates them; sanitizes input', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  // A clean set round-trips as an array.
  const tagged = createBug(db, {
    reporterId: u.id,
    pageUrl: 'p',
    title: 'tagged',
    tags: ['checkout', 'regression'],
  });
  assert.deepEqual(tagged.tags, ['checkout', 'regression']);
  assert.deepEqual(getBug(db, tagged.id).tags, ['checkout', 'regression']);

  // No tags → empty array, never null/undefined.
  const untagged = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'untagged' });
  assert.deepEqual(untagged.tags, []);

  // Sanitization: trims, drops blanks/non-strings, clips each label to 40 chars, caps the count at 20.
  const messy = createBug(db, {
    reporterId: u.id,
    pageUrl: 'p',
    title: 'messy',
    tags: ['  spaced  ', '', '   ', 42, null, 'x'.repeat(60), ...Array.from({ length: 25 }, (_, i) => 'n' + i)],
  });
  assert.equal(messy.tags[0], 'spaced'); // trimmed
  assert.ok(!messy.tags.includes('')); // blanks dropped
  assert.equal(messy.tags[1].length, 40); // long label clipped to 40
  assert.equal(messy.tags.length, 20); // capped at 20
  assert.ok(messy.tags.every((t) => typeof t === 'string')); // non-strings dropped
});

test('listBugs returns newest-first and filters by status and reporter', () => {
  const db = openDb(':memory:');
  const a = seedUser(db, 'a@b.co');
  const b = seedUser(db, 'b@b.co');
  const b1 = createBug(db, { reporterId: a.id, pageUrl: 'p1', title: 'one' });
  const b2 = createBug(db, { reporterId: b.id, pageUrl: 'p2', title: 'two' });
  const all = listBugs(db);
  assert.deepEqual(all.map((x) => x.id), [b2.id, b1.id]); // newest first
  assert.equal(listBugs(db, { reporterId: a.id }).length, 1);
  assert.equal(listBugs(db, { reporterId: a.id })[0].title, 'one');
  assert.equal(listBugs(db, { status: 'resolved' }).length, 0);
});

test('updateBugStatus transitions and records resolution + event', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const dev = seedUser(db, 'dev@b.co');
  const bug = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 't' });
  const moved = updateBugStatus(db, bug.id, 'in_progress', dev.id);
  assert.equal(moved.status, 'in_progress');
  const done = updateBugStatus(db, bug.id, 'resolved', dev.id, { resolution: 'fixed in #42' });
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolution, 'fixed in #42');
  assert.ok(done.updatedAt >= bug.updatedAt);
  assert.throws(() => updateBugStatus(db, bug.id, 'banana', dev.id), /INVALID_STATUS/);
  assert.throws(() => updateBugStatus(db, 'nope', 'resolved', dev.id), /NOT_FOUND/);
});

test('addBugComment and listBugEvents record the trail', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const bug = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 't' });
  addBugComment(db, bug.id, u.id, 'still broken on staging');
  updateBugStatus(db, bug.id, 'in_progress', u.id);
  const events = listBugEvents(db, bug.id);
  assert.equal(events[0].kind, 'created');
  assert.equal(events[1].kind, 'comment');
  assert.equal(events[1].payload.body, 'still broken on staging');
  assert.equal(events[2].kind, 'status');
  assert.equal(events[2].payload.to, 'in_progress');
  assert.throws(() => addBugComment(db, 'nope', u.id, 'x'), /NOT_FOUND/);
});

test('bugStatsForUser counts reported / resolved / open', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const other = seedUser(db, 'o@b.co');
  const b1 = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'a' });
  createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'b' });
  createBug(db, { reporterId: other.id, pageUrl: 'p', title: 'c' });
  updateBugStatus(db, b1.id, 'resolved', u.id);
  const s = bugStatsForUser(db, u.id);
  assert.deepEqual(s, { reported: 2, resolved: 1, open: 1 });
});
