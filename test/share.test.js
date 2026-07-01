import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createUser } from '../src/auth/users.js';
import { createTask, setPlan } from '../src/tasks/tasks.js';
import { addComment } from '../src/tasks/comments.js';
import {
  createShareLink,
  getActiveShareLinkByToken,
  listShareLinksForTask,
  revokeShareLink,
  shareView,
} from '../src/share/share.js';

// --- core module ---------------------------------------------------------------------------------

function seedTask(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: owner, content: { symptom: 'x' } });
  setPlan(db, t.id, { steps: ['a', 'b'] }, owner);
  return { owner, taskId: t.id };
}

test('createShareLink mints an unguessable token and getActiveShareLinkByToken resolves it', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seedTask(db);
  const link = createShareLink(db, { taskId, permission: 'run_agent', createdBy: owner });
  assert.equal(link.task_id, taskId);
  assert.equal(link.permission, 'run_agent');
  assert.equal(link.created_by, owner);
  assert.equal(link.revoked_at, null);
  assert.match(link.token, /^[0-9a-f]{64}$/); // 32 random bytes as hex

  const found = getActiveShareLinkByToken(db, link.token);
  assert.equal(found.id, link.id);
  assert.equal(getActiveShareLinkByToken(db, 'nope'), null);
});

test('permission defaults to comment_only and an unknown permission is rejected', () => {
  const db = openDb(':memory:');
  const { taskId } = seedTask(db);
  assert.equal(createShareLink(db, { taskId }).permission, 'comment_only');
  assert.throws(() => createShareLink(db, { taskId, permission: 'admin' }), /INVALID_PERMISSION/);
});

test('revokeShareLink makes the token read as gone (getActiveShareLinkByToken => null)', () => {
  const db = openDb(':memory:');
  const { taskId } = seedTask(db);
  const link = createShareLink(db, { taskId });
  assert.equal(revokeShareLink(db, link.token), 1);
  assert.equal(getActiveShareLinkByToken(db, link.token), null);
  assert.equal(shareView(db, link.token), null); // a revoked token exposes nothing
  assert.equal(revokeShareLink(db, link.token), 0); // idempotent: re-revoking is a no-op
});

test('listShareLinksForTask returns every minted link, newest first', () => {
  const db = openDb(':memory:');
  const { taskId } = seedTask(db);
  const a = createShareLink(db, { taskId });
  const b = createShareLink(db, { taskId, permission: 'run_agent' });
  const ids = listShareLinksForTask(db, taskId).map((l) => l.id);
  assert.deepEqual(ids, [b.id, a.id]);
});

test('shareView exposes only the plan-review subset of the task', () => {
  const db = openDb(':memory:');
  const { owner, taskId } = seedTask(db);
  addComment(db, taskId, { author: owner, body: 'looks good' });
  const link = createShareLink(db, { taskId });
  const view = shareView(db, link.token);
  assert.deepEqual(Object.keys(view).sort(), ['comments', 'plan', 'task']);
  assert.deepEqual(Object.keys(view.task).sort(), ['humanId', 'id', 'status', 'title', 'type']);
  assert.deepEqual(view.plan, { steps: ['a', 'b'] });
  assert.equal(view.comments.length, 1);
  assert.equal(view.comments[0].body, 'looks good');
  assert.equal(shareView(db, 'bogus'), null);
});

// --- HTTP routes (public + owner) ----------------------------------------------------------------

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function api(base, method, path, { cookie, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

async function ownerWithTask(base) {
  const s = await api(base, 'POST', '/api/auth/signup', { body: { email: 'a@b.co', displayName: 'A', password: 'pw12345' } });
  const t = await api(base, 'POST', '/api/tasks', { cookie: s.cookie, body: { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } } });
  await api(base, 'POST', '/api/tasks/' + t.json.task.id + '/plan', { cookie: s.cookie, body: { plan: { steps: ['a'] } } });
  return { cookie: s.cookie, taskId: t.json.task.id };
}

test('owner mints a link; an anonymous holder can view + comment without a session', async () => {
  await withServer(async (base) => {
    const { cookie, taskId } = await ownerWithTask(base);
    const share = await api(base, 'POST', '/api/tasks/' + taskId + '/share', { cookie, body: { permission: 'comment_only' } });
    assert.equal(share.status, 200);
    const token = share.json.share.token;

    // Public view — no cookie — returns only the shared subset.
    const view = await api(base, 'GET', '/api/share/' + token, {});
    assert.equal(view.status, 200);
    assert.deepEqual(Object.keys(view.json).sort(), ['comments', 'plan', 'task']);
    assert.equal(view.json.task.id, taskId);

    // A comment with no author defaults to 'guest'.
    const guest = await api(base, 'POST', '/api/share/' + token + '/comment', { body: { body: 'drive-by note' } });
    assert.equal(guest.status, 200);
    assert.equal(guest.json.comment.author, 'guest');

    // Public comment as a named-but-anonymous reviewer.
    const c2 = await api(base, 'POST', '/api/share/' + token + '/comment', { body: { author: 'Dana', body: 'nit: rename step' } });
    assert.equal(c2.json.comment.author, 'Dana');

    // Owner sees the reviewer's comment on the task thread.
    const thread = await api(base, 'GET', '/api/tasks/' + taskId + '/comments', { cookie });
    assert.ok(thread.json.comments.some((x) => x.author === 'Dana' && x.body === 'nit: rename step'));
  });
});

test('a public review appends a review event tagged via:share and records the comment', async () => {
  await withServer(async (base) => {
    const { cookie, taskId } = await ownerWithTask(base);
    const share = await api(base, 'POST', '/api/tasks/' + taskId + '/share', { cookie, body: { permission: 'comment_only' } });
    const token = share.json.share.token;

    const r = await api(base, 'POST', '/api/share/' + token + '/review', { body: { verdict: 'changes_requested', comment: 'redo step 2', author: 'Dana' } });
    assert.equal(r.status, 200);

    const events = await api(base, 'GET', '/api/tasks/' + taskId + '/events', { cookie });
    const rev = events.json.events.find((e) => e.kind === 'review' && e.payload.via === 'share');
    assert.ok(rev, 'a via:share review event was appended');
    assert.equal(rev.payload.verdict, 'changes_requested');
    assert.equal(rev.payload.by, 'Dana');

    const thread = await api(base, 'GET', '/api/tasks/' + taskId + '/comments', { cookie });
    assert.ok(thread.json.comments.some((x) => x.body === 'redo step 2'));
  });
});

test('run-agent is gated by permission: run_agent allows (enqueues a wake), comment_only is forbidden', async () => {
  await withServer(async (base) => {
    const { cookie, taskId } = await ownerWithTask(base);

    // comment_only link => 403 FORBIDDEN.
    const ro = await api(base, 'POST', '/api/tasks/' + taskId + '/share', { cookie, body: { permission: 'comment_only' } });
    const blocked = await api(base, 'POST', '/api/share/' + ro.json.share.token + '/run-agent', { body: { message: 'go', author: 'Dana' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, 'FORBIDDEN');

    // run_agent link => 200 and a pick_up_now wake tagged via:share.
    const rw = await api(base, 'POST', '/api/tasks/' + taskId + '/share', { cookie, body: { permission: 'run_agent' } });
    const ran = await api(base, 'POST', '/api/share/' + rw.json.share.token + '/run-agent', { body: { message: 'please run', author: 'Dana' } });
    assert.equal(ran.status, 200);
    assert.equal(ran.json.wake.reason, 'pick_up_now');
    assert.equal(ran.json.wake.context.via, 'share');
    assert.equal(ran.json.wake.context.author, 'Dana');
  });
});

test('revoked and unknown tokens are 404 NO_SUCH_SHARE on every public route', async () => {
  await withServer(async (base) => {
    const { cookie, taskId } = await ownerWithTask(base);
    const share = await api(base, 'POST', '/api/tasks/' + taskId + '/share', { cookie, body: { permission: 'run_agent' } });
    const token = share.json.share.token;

    // Owner lists then revokes the link.
    const list = await api(base, 'GET', '/api/tasks/' + taskId + '/shares', { cookie });
    assert.equal(list.json.shares.length, 1);
    const del = await api(base, 'DELETE', '/api/share/' + token, { cookie });
    assert.equal(del.status, 200);

    for (const t of [token, 'never-existed']) {
      assert.equal((await api(base, 'GET', '/api/share/' + t, {})).status, 404);
      assert.equal((await api(base, 'POST', '/api/share/' + t + '/comment', { body: { body: 'x' } })).status, 404);
      assert.equal((await api(base, 'POST', '/api/share/' + t + '/run-agent', { body: {} })).status, 404);
    }
    // Re-revoking a dead/unknown token is a 404, not a crash.
    assert.equal((await api(base, 'DELETE', '/api/share/' + token, { cookie })).status, 404);
  });
});
