import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createToken } from '../src/auth/tokens.js';
import { registerProject } from '../src/projects/projects.js';
import { enqueueWake, listPendingWakes } from '../src/executor/wake.js';
import { getTask } from '../src/tasks/tasks.js';
import { addComment, unseenComments } from '../src/tasks/comments.js';
import { getRun } from '../src/executor/runs.js';

// The token-authenticated agent/runner API (/api/agent/*) — how an agent on a MEMBER's own machine reaches
// a hosted board. These tests drive it over a real loopback server, the way the HTTP MCP transport and the
// `be10x connect` runner will.

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

// Same, but hands the db to the test so it can seed a project/task/wake directly (the way the board's own
// state would already look) and then drive claim/report over HTTP.
async function withServerDb(fn) {
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

// Seed a user + token + project + one task in `status`, returning the ids the runner-API tests need.
function seedBoard(db, { status = 'ready_to_work', key = 'github.com/acme/app' } = {}) {
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  const { token } = createToken(db, 'u1', 'laptop');
  const project = registerProject(db, { key, name: 'app', rootPath: null });
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('t1', 't1', 'general', 'project', project.id, 'u1', 'T', status, now, now);
  return { token, key, projectId: project.id };
}

// Bearer-token request (the agent transport) — no session cookie.
async function agent(base, method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Session request (a human) — used only to bootstrap a user + mint a token.
async function session(base, method, path, { cookie, body } = {}) {
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

// Sign up a human and mint a personal access token — the credential the member's machine uses.
async function boot(base, email = 'a@b.co') {
  const s = await session(base, 'POST', '/api/auth/signup', {
    body: { email, displayName: 'A', password: 'pw12345' },
  });
  const me = await session(base, 'GET', '/api/me', { cookie: s.cookie });
  const t = await session(base, 'POST', '/api/tokens', { cookie: s.cookie, body: { name: 'my-laptop' } });
  return { cookie: s.cookie, userId: me.json.user.id, token: t.json.token.token };
}

test('rpc gateway dispatches a gfa_* tool as the token owner', async () => {
  await withServer(async (base) => {
    const { userId, token } = await boot(base);

    const created = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_create_task', args: { type: 'general', scope: 'personal', title: 'from my machine', content: { summary: 'hi' } } },
    });
    assert.equal(created.status, 200);
    const task = created.json.result;
    assert.ok(task.id, 'returns the created task');
    assert.equal(task.title, 'from my machine');
    assert.equal(task.status, 'backlog');
    assert.equal(task.ownerId, userId, 'the task is owned by the token holder, not "agent"');

    // And it can read it straight back through the same gateway.
    const got = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_get_task', args: { taskId: task.id } },
    });
    assert.equal(got.status, 200);
    assert.equal(got.json.result.id, task.id);
  });
});

test('rpc gateway rejects a missing or invalid token with 401', async () => {
  await withServer(async (base) => {
    await boot(base);
    const noTok = await agent(base, 'POST', '/api/agent/rpc', { body: { tool: 'gfa_list_tasks', args: {} } });
    assert.equal(noTok.status, 401);
    assert.equal(noTok.json.error, 'BAD_TOKEN');

    const badTok = await agent(base, 'POST', '/api/agent/rpc', {
      token: 'gfa_' + '0'.repeat(48),
      body: { tool: 'gfa_list_tasks', args: {} },
    });
    assert.equal(badTok.status, 401);
    assert.equal(badTok.json.error, 'BAD_TOKEN');
  });
});

test('rpc gateway 400s an unknown tool', async () => {
  await withServer(async (base) => {
    const { token } = await boot(base);
    const res = await agent(base, 'POST', '/api/agent/rpc', { token, body: { tool: 'gfa_nope', args: {} } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'UNKNOWN_TOOL');
  });
});

test('rpc gateway passes a domain error through with the right status (NO_TASK -> 404)', async () => {
  await withServer(async (base) => {
    const { token } = await boot(base);
    // gfa_submit_output on a task that doesn't exist -> core throws NO_TASK -> 404 (the appendEvent/setRefs
    // guard added for the distributed crash fix). Proves errors aren't swallowed as 200s.
    const res = await agent(base, 'POST', '/api/agent/rpc', {
      token,
      body: { tool: 'gfa_submit_output', args: { taskId: 'does-not-exist', refs: { pr: 'x' } } },
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'NO_TASK');
  });
});

test('POST /api/agent/projects registers a path-less project a connector serves', async () => {
  await withServer(async (base) => {
    const { token } = await boot(base);
    const res = await agent(base, 'POST', '/api/agent/projects', { token, body: { key: 'github.com/acme/app', name: 'app' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.project.key, 'github.com/acme/app');
    assert.equal(res.json.project.rootPath, null, 'path-less on a hosted board (repo lives on the member machine)');
  });
});

test('claim → report drives the full execute→verifying hand-off over HTTP', async () => {
  await withServerDb(async (base, db) => {
    const { token, key } = seedBoard(db, { status: 'ready_to_work' });
    enqueueWake(db, 't1', 'execute');

    const claim = await agent(base, 'POST', '/api/agent/claim', { token, body: { projectKeys: [key] } });
    assert.equal(claim.status, 200);
    assert.ok(claim.json.wake.id, 'a wake was handed out');
    assert.equal(claim.json.mode, 'execute');
    assert.equal(claim.json.task.status, 'in_progress', 'prepareWake claimed ready_to_work→in_progress');
    assert.equal(claim.json.resumeSessionId, null, 'no prior session to resume on the first run');
    assert.ok(claim.json.runId, 'a run row was opened');

    const report = await agent(base, 'POST', '/api/agent/report', {
      token,
      body: {
        wakeId: claim.json.wake.id,
        runId: claim.json.runId,
        taskId: 't1',
        commentIds: claim.json.commentIds,
        summary: { ok: true, done: true, mode: 'execute', sessionId: 'sess-1' },
      },
    });
    assert.equal(report.status, 200);
    assert.equal(report.json.ok, true);

    // The board applied the durability tail: execute→verifying + a fresh verify wake; run closed done + session.
    assert.equal(getTask(db, 't1').status, 'verifying');
    const pending = listPendingWakes(db, 't1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reason, 'verify');
    const run = getRun(db, claim.json.runId);
    assert.equal(run.status, 'done');
    assert.equal(run.sessionId, 'sess-1', 'the new session id was persisted for the next resume');
  });
});

test('claim returns { wake: null } when no served repo matches', async () => {
  await withServerDb(async (base, db) => {
    const { token } = seedBoard(db);
    enqueueWake(db, 't1', 'execute');
    const claim = await agent(base, 'POST', '/api/agent/claim', { token, body: { projectKeys: ['github.com/someone/else'] } });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.wake, null);
    // The wake is untouched — still pending for a runner that does serve the repo.
    assert.equal(listPendingWakes(db, 't1').length, 1);
  });
});

test('report of a network failure auto-retries over HTTP and keeps the delivered comment unseen', async () => {
  await withServerDb(async (base, db) => {
    const { token, key } = seedBoard(db, { status: 'in_progress' });
    const c = addComment(db, 't1', { author: 'u1', body: 'steer' });
    enqueueWake(db, 't1', 'execute');

    const claim = await agent(base, 'POST', '/api/agent/claim', { token, body: { projectKeys: [key] } });
    assert.equal(claim.json.commentIds.length, 1);

    const report = await agent(base, 'POST', '/api/agent/report', {
      token,
      body: {
        wakeId: claim.json.wake.id,
        runId: claim.json.runId,
        taskId: 't1',
        commentIds: claim.json.commentIds,
        summary: { ok: false, failureKind: 'network', error: 'ECONNRESET', mode: 'execute' },
      },
    });
    assert.equal(report.status, 200);
    assert.equal(report.json.retrying.kind, 'network');

    const pending = listPendingWakes(db, 't1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].context.retry, true);
    assert.equal(unseenComments(db, 't1').length, 1, 'the retry must re-deliver the comment');
    assert.equal(c.id, claim.json.commentIds[0]);
  });
});
