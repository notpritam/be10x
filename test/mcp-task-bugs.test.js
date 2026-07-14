// ABOUTME: Tests the bug-aware MCP task tools (src/mcp/tools.js) by calling handler(db, ctx, args) directly:
// ABOUTME: bugIds on gfa_create_task, linkedBugs in gfa_get_task, and the gfa_attach_bug / gfa_task_bugs tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug } from '../src/bugs/bugs.js';
import { TOOLS } from '../src/mcp/tools.js';

function call(db, ctx, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" is registered`);
  return tool.handler(db, ctx, args);
}

function seed() {
  const db = openDb(':memory:');
  const owner = createUser(db, { email: 'owner@be10x.co', displayName: 'Owner', password: 'pw123456' });
  const other = createUser(db, { email: 'other@be10x.co', displayName: 'Other', password: 'pw123456' });
  const ctx = { userId: owner.id };
  const mk = (reporterId, title, errorCount = 0) =>
    createBug(db, { reporterId, pageUrl: 'https://app/x', title, severity: 'high', meta: { errorCount } });
  return { db, owner, other, ctx, mk };
}

test('gfa_attach_bug and gfa_task_bugs are registered', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('gfa_attach_bug'));
  assert.ok(names.includes('gfa_task_bugs'));
});

test('gfa_create_task with bugIds links each bug; gfa_get_task returns compact linkedBugs', () => {
  const { db, owner, ctx, mk } = seed();
  const b1 = mk(owner.id, 'checkout 500', 3);
  const b2 = mk(owner.id, 'nav flicker', 0);

  const task = call(db, ctx, 'gfa_create_task', {
    type: 'code-issue', scope: 'personal', title: 'Fix it', content: { symptom: 'x' }, bugIds: [b1.id, b2.humanId],
  });

  const got = call(db, ctx, 'gfa_get_task', { taskId: task.id });
  assert.equal(got.linkedBugs.length, 2);
  const byHuman = Object.fromEntries(got.linkedBugs.map((b) => [b.humanId, b]));
  assert.equal(byHuman[b1.humanId].title, 'checkout 500');
  assert.equal(byHuman[b1.humanId].errorCount, 3);
  assert.equal(byHuman[b1.humanId].severity, 'high');
  // compact — never carries the raw capture meta blob
  assert.equal(byHuman[b1.humanId].meta, undefined);
});

test('gfa_get_task returns linkedBugs: [] when none are attached', () => {
  const { db, ctx } = seed();
  const task = call(db, ctx, 'gfa_create_task', { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } });
  const got = call(db, ctx, 'gfa_get_task', { id: task.id });
  assert.deepEqual(got.linkedBugs, []);
});

test('gfa_attach_bug attaches post-creation; gfa_task_bugs lists the linked set', () => {
  const { db, owner, ctx, mk } = seed();
  const task = call(db, ctx, 'gfa_create_task', { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } });
  const bug = mk(owner.id, 'later bug', 1);

  const attached = call(db, ctx, 'gfa_attach_bug', { taskId: task.id, bugId: bug.humanId });
  assert.equal(attached.bug.humanId, bug.humanId);

  const listed = call(db, ctx, 'gfa_task_bugs', { taskId: task.id });
  assert.equal(listed.linkedBugs.length, 1);
  assert.equal(listed.linkedBugs[0].id, bug.id);
});

test('gfa_attach_bug refuses another account\'s bug (FORBIDDEN)', () => {
  const { db, owner, other, ctx, mk } = seed();
  const task = call(db, ctx, 'gfa_create_task', { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } });
  const foreign = mk(other.id, 'not yours', 0);
  assert.throws(() => call(db, ctx, 'gfa_attach_bug', { taskId: task.id, bugId: foreign.id }), /FORBIDDEN/);
});

test('gfa_create_task refuses bugIds the caller cannot access', () => {
  const { db, other, ctx, mk } = seed();
  const foreign = mk(other.id, 'not yours', 0);
  assert.throws(
    () => call(db, ctx, 'gfa_create_task', { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' }, bugIds: [foreign.id] }),
    /FORBIDDEN/
  );
});
