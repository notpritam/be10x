// ABOUTME: assembleFleetStatus — the "what is every agent doing" view: in-flight tasks the viewer can see,
// ABOUTME: each with its live state + derived stalled flag. Terminal tasks and tasks the viewer can't see are excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { recordProgress } from '../src/worker/worker.js';
import { assembleFleetStatus } from '../src/tasks/fleet.js';
import { createRun, setRunSession } from '../src/executor/runs.js';

function seed() {
  const db = openDb(':memory:');
  const a = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw123456' });
  const b = createUser(db, { email: 'b@b.co', displayName: 'B', password: 'pw123456' });
  return { db, a, b };
}
function setAge(db, id, ts){ const a=JSON.parse(db.prepare('SELECT agent_json FROM tasks WHERE id=?').get(id).agent_json); a.updatedAt=ts; db.prepare('UPDATE tasks SET agent_json=? WHERE id=?').run(JSON.stringify(a), id); }
const mkTask = (db, ownerId, status) => {
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'T', ownerId, content: { summary: 'x' } });
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id); // seed status directly (skip gates)
  return t;
};

test('lists in-flight tasks the viewer can see, with state + stalled', () => {
  const { db, a } = seed();
  const now = 10_000_000;
  const t = mkTask(db, a.id, 'in_progress');
  recordProgress(db, t.id, { state: 'working', phase: 'implement' });
  setAge(db, t.id, now - 1000);

  const rows = assembleFleetStatus(db, { viewerId: a.id, now, staleMs: 300000 });
  const row = rows.find((r) => r.taskId === t.id);
  assert.ok(row, 'in-flight task listed');
  assert.equal(row.state, 'working');
  assert.equal(row.phase, 'implement');
  assert.equal(row.stalled, false);
});

test('a fleet row carries the latest run\'s session id + host ("where it\'s running")', () => {
  const { db, a } = seed();
  const now = 10_000_000;
  const t = mkTask(db, a.id, 'in_progress');
  recordProgress(db, t.id, { state: 'working', phase: 'implement' });
  setAge(db, t.id, now - 1000);
  const run = createRun(db, { taskId: t.id, host: 'mac-pritam' });
  setRunSession(db, run.id, 'sess-abc-123');

  const row = assembleFleetStatus(db, { viewerId: a.id, now }).find((r) => r.taskId === t.id);
  assert.equal(row.sessionId, 'sess-abc-123');
  assert.equal(row.host, 'mac-pritam');
  assert.equal(row.runId, run.id);
});

test('an in-flight task with no run yet shows queued, not a false "working"', () => {
  const { db, a } = seed();
  const now = 10_000_000;
  const t = mkTask(db, a.id, 'researching'); // no recordProgress → no agent snapshot, nothing claimed it
  const row = assembleFleetStatus(db, { viewerId: a.id, now }).find((r) => r.taskId === t.id);
  assert.equal(row.state, 'queued', 'nothing is running it → queued, not working');
  assert.equal(row.stalled, false);
});

test('a working task past the stale threshold is flagged stalled', () => {
  const { db, a } = seed();
  const now = 10_000_000;
  const t = mkTask(db, a.id, 'in_progress');
  recordProgress(db, t.id, { state: 'working', phase: 'implement' });
  setAge(db, t.id, now - 10 * 60000);
  const row = assembleFleetStatus(db, { viewerId: a.id, now, staleMs: 300000 }).find((r) => r.taskId === t.id);
  assert.equal(row.stalled, true);
});

test('terminal tasks are excluded; other users\' private tasks are not visible', () => {
  const { db, a, b } = seed();
  const now = 10_000_000;
  const done = mkTask(db, a.id, 'done');
  const priv = mkTask(db, a.id, 'in_progress');

  const bView = assembleFleetStatus(db, { viewerId: b.id, now });
  assert.equal(bView.find((r) => r.taskId === priv.id), undefined, 'B cannot see A\'s private task');
  const aView = assembleFleetStatus(db, { viewerId: a.id, now });
  assert.equal(aView.find((r) => r.taskId === done.id), undefined, 'done task excluded');
  assert.ok(aView.find((r) => r.taskId === priv.id), 'A sees own in-flight task');
});
