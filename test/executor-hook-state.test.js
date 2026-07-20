// ABOUTME: The executor derives live agent state from inline hook events — a Notification hook flips the
// ABOUTME: task snapshot to 'waiting' MID-run; a successful close finalizes it to 'done'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db/db.js';
import { makeClaudeExecutor } from '../src/executor/executor.js';

function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run('u1', 'a@b.dev', 'A', 'x', now);
  db.prepare('INSERT INTO tasks (id,human_id,type,scope,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t1', 'GFA-1', 'code-issue', 'personal', 'u1', 'Fix', 'in_progress', now, now);
  return db;
}
const TASK = { id: 't1', humanId: 'GFA-1', title: 'Fix', content: { description: 'broken' }, type: 'code-issue' };
const PROJECT = { id: 'p1', rootPath: '/repo', defaultBranch: 'main' };
const state = (db) => JSON.parse(db.prepare('SELECT agent_json FROM tasks WHERE id = ?').get('t1').agent_json ?? '{}').state;
const fakeEnsure = () => async (_r, opts) => ({ path: '/repo/wt', branch: opts.branch, baseRef: 'main', reused: false });

// A controllable fake child: returned immediately, driven by the test.
function controllableSpawn() {
  let child;
  const fn = () => {
    child = new EventEmitter();
    child.pid = 1;
    child.stdin = { write() {}, end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    fn.child = child;
    return child;
  };
  return fn;
}
const line = (o) => Buffer.from(JSON.stringify(o) + '\n');
const tick = () => new Promise((r) => setImmediate(r));

test('a Notification hook flips the snapshot to waiting mid-run; success closes it to done', async () => {
  const db = seed();
  const spawn = controllableSpawn();
  const execute = makeClaudeExecutor(db, PROJECT, { spawn, ensureWorktree: fakeEnsure() });
  const p = execute(TASK, { mode: 'execute' });

  // wait until the child has been spawned (worktree ensure is async)
  for (let i = 0; i < 20 && !spawn.child; i++) await tick();
  assert.ok(spawn.child, 'child spawned');

  // SessionStart → working
  spawn.child.stdout.emit('data', line({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart', session_id: 's1' }));
  await tick();
  assert.equal(state(db), 'working');

  // Notification → waiting (the agent is asking a human)
  spawn.child.stdout.emit('data', line({ type: 'system', subtype: 'hook_started', hook_event: 'Notification', session_id: 's1' }));
  await tick();
  assert.equal(state(db), 'waiting', 'Notification drives waiting mid-run');

  // a successful terminal result + close → done
  spawn.child.stdout.emit('data', line({ type: 'result', subtype: 'success', session_id: 's1', result: 'ok' }));
  spawn.child.emit('close', 0);
  await p;
  assert.equal(state(db), 'done', 'success finalizes to done');
});
