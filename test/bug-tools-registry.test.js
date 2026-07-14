// ABOUTME: Tests the shared bug-tools registry's BOARD-side enforced dispatch (dispatchBugTool) — the remote
// ABOUTME: agent path. Unlike the local stdio server (board-wide: a valid token reads any bug), the board
// ABOUTME: dispatch enforces per-account bug access, while the raw handler path stays board-wide (regression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { createBug, linkBugToTask } from '../src/bugs/bugs.js';
import { getBugTool, dispatchBugTool } from '../src/mcp/bug-tools.js';

function seed() {
  const db = openDb(':memory:');
  const a = createUser(db, { email: 'a@be10x.co', displayName: 'A', password: 'pw123456' });
  const b = createUser(db, { email: 'b@be10x.co', displayName: 'B', password: 'pw123456' });
  const bugA = createBug(db, { reporterId: a.id, pageUrl: 'https://app/a', title: 'A bug', severity: 'high', meta: { errorCount: 2, console: [{ ts: 1, level: 'error', text: 'boom' }] } });
  const bugB = createBug(db, { reporterId: b.id, pageUrl: 'https://app/b', title: 'B bug', severity: 'low' });
  return { db, a, b, ctxA: { userId: a.id }, bugA, bugB };
}

test('dispatchBugTool grants a caller access to their OWN bug', async () => {
  const { db, ctxA, bugA } = seed();
  const got = await dispatchBugTool(db, ctxA, 'bug_get', { bug: bugA.id });
  assert.equal(got.humanId, bugA.humanId);
  const console = await dispatchBugTool(db, ctxA, 'bug_console', { bug: bugA.id, level: 'error' });
  assert.equal(console.entries.length, 1);
});

test('dispatchBugTool BLOCKS a caller from another account\'s bug (FORBIDDEN)', async () => {
  const { db, ctxA, bugB } = seed();
  await assert.rejects(() => dispatchBugTool(db, ctxA, 'bug_get', { bug: bugB.id }), /FORBIDDEN/);
});

test('dispatchBugTool bug_list is filtered to the caller\'s visible bugs', async () => {
  const { db, ctxA, bugA } = seed();
  const res = await dispatchBugTool(db, ctxA, 'bug_list', {});
  assert.equal(res.count, 1);
  assert.equal(res.bugs[0].humanId, bugA.humanId);
});

test('a bug linked to a task the caller can access becomes reachable', async () => {
  const { db, a, ctxA, bugB } = seed();
  const task = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Fix', ownerId: a.id, content: { symptom: 'x' } });
  // A cannot see B's bug…
  await assert.rejects(() => dispatchBugTool(db, ctxA, 'bug_get', { bug: bugB.id }), /FORBIDDEN/);
  // …until it's linked to A's task, then canAccessBug's task branch grants it.
  linkBugToTask(db, bugB.id, task.id, a.id);
  const got = await dispatchBugTool(db, ctxA, 'bug_get', { bug: bugB.id });
  assert.equal(got.humanId, bugB.humanId);
});

test('the RAW handler path stays board-wide (local stdio behavior is unchanged)', () => {
  const { db, ctxA, bugB } = seed();
  // No access enforcement on the direct registry handler — the local single-tenant server relies on this.
  const got = getBugTool('bug_get').handler(db, ctxA, { bug: bugB.id });
  assert.equal(got.humanId, bugB.humanId);
});

test('dispatchBugTool rejects an unknown tool', async () => {
  const { db, ctxA } = seed();
  await assert.rejects(() => dispatchBugTool(db, ctxA, 'bug_nope', {}), /UNKNOWN_TOOL/);
});
