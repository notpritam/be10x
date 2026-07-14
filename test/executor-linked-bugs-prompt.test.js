// ABOUTME: The working agent's prompt must surface bugs linked to the task + the be10x-bugs tool hint, so a
// ABOUTME: claimed task tells the agent WHICH captures to debug. Tests buildPrompt (pure) + that the board's
// ABOUTME: /api/agent/claim payload carries task.linkedBugs so the remote connector renders it without a db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createToken } from '../src/auth/tokens.js';
import { registerProject } from '../src/projects/projects.js';
import { createBug, linkBugToTask } from '../src/bugs/bugs.js';
import { enqueueWake } from '../src/executor/wake.js';
import { buildPrompt } from '../src/executor/executor.js';

const BASE_TASK = { id: 't1', humanId: 'GFA-1', title: 'Fix checkout', content: { symptom: 'pay dead' }, type: 'code-issue' };

test('buildPrompt renders a Linked bugs block with ids, error counts, and the be10x-bugs tool hint', () => {
  const task = {
    ...BASE_TASK,
    linkedBugs: [
      { id: 'b1', humanId: 'BUG-012', title: 'checkout 500', severity: 'high', errorCount: 3 },
      { id: 'b2', humanId: 'BUG-014', title: 'nav flicker', severity: 'low', errorCount: 0 },
    ],
  };
  const prompt = buildPrompt(task, { mode: 'execute' });
  assert.match(prompt, /Linked bugs/);
  assert.match(prompt, /BUG-012/);
  assert.match(prompt, /checkout 500/);
  assert.match(prompt, /BUG-014/);
  assert.match(prompt, /3 console errors/);
  // the tool hint points the agent at the be10x-bugs MCP
  assert.match(prompt, /be10x-bugs/);
  assert.match(prompt, /bug_console/);
});

test('buildPrompt omits the Linked bugs block when there are none', () => {
  assert.doesNotMatch(buildPrompt(BASE_TASK, { mode: 'plan' }), /Linked bugs/);
  assert.doesNotMatch(buildPrompt({ ...BASE_TASK, linkedBugs: [] }, { mode: 'plan' }), /Linked bugs/);
});

test('/api/agent/claim carries task.linkedBugs so the remote connector can render them without a db', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    const now = Date.now();
    db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run('u1', 'a@b.dev', 'A', 'x', now);
    const { token } = createToken(db, 'u1', 'laptop');
    const project = registerProject(db, { key: 'github.com/acme/app', name: 'app', rootPath: null, ownerId: 'u1' });
    db.prepare(
      'INSERT INTO tasks (id,human_id,type,scope,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run('t1', 'GFA-1', 'code-issue', 'project', project.id, 'u1', 'Fix checkout', 'ready_to_work', now, now);
    const bug = createBug(db, { reporterId: 'u1', pageUrl: 'https://app/x', title: 'checkout 500', severity: 'high', meta: { errorCount: 3 } });
    linkBugToTask(db, bug.id, 't1', 'u1');
    enqueueWake(db, 't1', 'execute');

    const res = await fetch(base + '/api/agent/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ projectKeys: ['github.com/acme/app'] }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.task.linkedBugs), 'claim task carries linkedBugs');
    assert.equal(json.task.linkedBugs.length, 1);
    assert.equal(json.task.linkedBugs[0].humanId, bug.humanId);
    assert.equal(json.task.linkedBugs[0].errorCount, 3);
  } finally {
    await new Promise((r) => app.close(r));
  }
});
