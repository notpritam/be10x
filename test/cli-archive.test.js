import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createApp } from '../src/http/server.js';
import { createTask, resolveTaskId } from '../src/tasks/tasks.js';
import { createRun } from '../src/executor/runs.js';
import { makeBoardClient } from '../src/connect/connect.js';

// --- resolveTaskId: the shared uuid / GFA-123 resolver the CLI + agent route lean on ---------------------

test('resolveTaskId accepts a uuid, a GFA-123 human id, and a zero-pad-forgiving GFA-1', () => {
  const db = openDb(':memory:');
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'X', ownerId: uid, content: { summary: 's' } });

  assert.equal(resolveTaskId(db, t.id), t.id); // uuid passes through
  assert.equal(resolveTaskId(db, t.humanId), t.id); // GFA-001
  assert.equal(resolveTaskId(db, 'gfa-001'), t.id); // case-insensitive
  assert.equal(resolveTaskId(db, 'GFA-1'), t.id); // zero-pad forgiving → GFA-001
  assert.equal(resolveTaskId(db, 'GFA-999'), null); // unknown human id
  assert.equal(resolveTaskId(db, 'nope'), null);
  assert.equal(resolveTaskId(db, ''), null);
  assert.equal(resolveTaskId(db, null), null);
});

// --- hosted archive: board client → Bearer agent route → archiveTask, end to end ------------------------

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base, db);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function http(base, method, path, { cookie, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: sid };
}

const signup = (base, email) =>
  http(base, 'POST', '/api/auth/signup', { body: { email, displayName: email[0].toUpperCase(), password: 'pw12345' } });

test('makeBoardClient.archive soft-archives by human id over the Bearer agent route and returns worktrees', async () => {
  await withServer(async (base, db) => {
    const owner = await signup(base, 'owner@cli.co');
    const token = (await http(base, 'POST', '/api/tokens', { cookie: owner.cookie, body: { name: 'cli' } })).json.token.token;
    const created = await http(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'personal', title: 'Hosted shelf', content: { summary: 's' } },
    });
    const id = created.json.task.id;
    const humanId = created.json.task.humanId;
    createRun(db, { taskId: id, worktreePath: '/repo/.be10x/worktrees/w', branch: 'be10x/w' });

    const client = makeBoardClient({ board: base, token });
    // Archive by the human id — the CLI on a hosted board has no local db to resolve it, so the route does.
    const result = await client.archive(humanId);
    assert.equal(result.task.status, 'archived');
    assert.deepEqual(result.worktrees, [{ path: '/repo/.be10x/worktrees/w', branch: 'be10x/w' }]);

    // Idempotent over the wire.
    const again = await client.archive(id);
    assert.equal(again.task.status, 'archived');
  });
});

test('the Bearer archive route rejects a token that can\'t access the task, and a bad token', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner2@cli.co');
    const outsider = await signup(base, 'outsider2@cli.co');
    const outsiderToken = (await http(base, 'POST', '/api/tokens', { cookie: outsider.cookie, body: { name: 'cli' } })).json.token.token;
    const created = await http(base, 'POST', '/api/tasks', {
      cookie: owner.cookie,
      body: { type: 'general', scope: 'personal', title: 'T', content: { summary: 's' } },
    });
    const id = created.json.task.id;

    const outsiderClient = makeBoardClient({ board: base, token: outsiderToken });
    await assert.rejects(() => outsiderClient.archive(id), /FORBIDDEN/);

    const badClient = makeBoardClient({ board: base, token: 'gfa_not_a_real_token' });
    await assert.rejects(() => badClient.archive(id), /BAD_TOKEN/);
  });
});
