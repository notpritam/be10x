// ABOUTME: Admin aggregation queries (overview/user-list/user-detail) and the gated HTTP routes
// ABOUTME: that expose them — same GFA_ADMIN_TOKEN gate as the telemetry viewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { createUser } from '../src/auth/users.js';
import { createTask } from '../src/tasks/tasks.js';
import { createRun, finishRun } from '../src/executor/runs.js';
import { adminOverview, listUsersForAdmin, userDetailForAdmin } from '../src/admin/admin.js';

function seed(db) {
  const alice = createUser(db, { email: 'alice@admin.co', displayName: 'Alice', password: 'pw12345' });
  const bob = createUser(db, { email: 'bob@admin.co', displayName: 'Bob', password: 'pw12345' });

  const t1 = createTask(db, { type: 'general', scope: 'personal', title: 'A1', ownerId: alice.id, content: { summary: 's' } });
  const t2 = createTask(db, { type: 'general', scope: 'personal', title: 'A2', ownerId: alice.id, content: { summary: 's' } });
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t2.id);
  const t3 = createTask(db, { type: 'general', scope: 'personal', title: 'B1', ownerId: bob.id, content: { summary: 's' } });

  // t2 (alice, done) has TWO runs, to prove status counting doesn't double-count across the fan-out.
  const r1 = createRun(db, { taskId: t2.id });
  finishRun(db, r1.id, { status: 'done', usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.01 } });
  const r2 = createRun(db, { taskId: t2.id });
  finishRun(db, r2.id, { status: 'done', usage: { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 10, cacheReadTokens: 5, costUsd: 0.02 } });

  const r3 = createRun(db, { taskId: t3.id });
  finishRun(db, r3.id, { status: 'done', usage: { inputTokens: 40, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.005 } });

  return { alice, bob, t1, t2, t3 };
}

test('adminOverview counts users, tasks, done tasks, and sums usage across all runs', () => {
  const db = openDb(':memory:');
  seed(db);
  const overview = adminOverview(db);
  assert.equal(overview.userCount, 2);
  assert.equal(overview.taskCount, 3);
  assert.equal(overview.doneCount, 1);
  assert.equal(overview.usage.inputTokens, 100 + 200 + 40);
  assert.equal(overview.usage.outputTokens, 50 + 75 + 20);
  assert.ok(Math.abs(overview.usage.costUsd - (0.01 + 0.02 + 0.005)) < 1e-9);
});

test('adminOverview counts a user active only if a task was created/updated within the window', () => {
  const db = openDb(':memory:');
  const { alice, t1 } = seed(db);
  const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE owner_id = ?').run(oldTimestamp, oldTimestamp, alice.id);
  const overview = adminOverview(db, { activeSinceMs: 7 * 24 * 60 * 60 * 1000 });
  // Alice's tasks are all stale now; bob's (from seed, "now") are still fresh.
  assert.equal(overview.activeUsers, 1);
  void t1;
});

test('listUsersForAdmin: a task with multiple runs is counted once toward tasksDone, not once per run', () => {
  const db = openDb(':memory:');
  const { alice } = seed(db);
  const users = listUsersForAdmin(db);
  const aliceRow = users.find((u) => u.id === alice.id);
  assert.equal(aliceRow.taskCount, 2); // A1 + A2
  assert.equal(aliceRow.tasksDone, 1); // only A2, despite A2 having two runs
  assert.equal(aliceRow.inputTokens, 300); // summed across A2's two runs
});

test('listUsersForAdmin filters by q (email or display name, case-insensitive)', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.equal(listUsersForAdmin(db, { q: 'bob' }).length, 1);
  assert.equal(listUsersForAdmin(db, { q: 'ALICE' }).length, 1);
  assert.equal(listUsersForAdmin(db, { q: 'nobody' }).length, 0);
  assert.equal(listUsersForAdmin(db, {}).length, 2);
});

test('userDetailForAdmin returns a user\'s tasks with per-task and rolled-up usage; null for unknown id', () => {
  const db = openDb(':memory:');
  const { alice } = seed(db);
  const detail = userDetailForAdmin(db, alice.id);
  assert.equal(detail.user.email, 'alice@admin.co');
  assert.equal(detail.tasks.length, 2);
  assert.equal(detail.tasksDone, 1);
  assert.equal(detail.totals.inputTokens, 300);
  assert.equal(userDetailForAdmin(db, 'nope'), null);
});

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

async function withAdminToken(token, fn) {
  const prev = process.env.GFA_ADMIN_TOKEN;
  if (token === undefined) delete process.env.GFA_ADMIN_TOKEN;
  else process.env.GFA_ADMIN_TOKEN = token;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.GFA_ADMIN_TOKEN;
    else process.env.GFA_ADMIN_TOKEN = prev;
  }
}

test('admin HTTP routes are all 404 without the correct GFA_ADMIN_TOKEN', async () => {
  await withAdminToken('secret', async () => {
    await withServer(async (base, db) => {
      const { alice } = seed(db);
      for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/users/' + alice.id]) {
        const noAuth = await fetch(base + path);
        assert.equal(noAuth.status, 404, path + ' with no auth');
        const wrongAuth = await fetch(base + path, { headers: { Authorization: 'Bearer wrong' } });
        assert.equal(wrongAuth.status, 404, path + ' with wrong token');
      }
    });
  });
});

test('admin HTTP routes work with the correct token', async () => {
  await withAdminToken('secret', async () => {
    await withServer(async (base, db) => {
      const { alice } = seed(db);
      const auth = { Authorization: 'Bearer secret' };

      const overview = await (await fetch(base + '/api/admin/overview', { headers: auth })).json();
      assert.equal(overview.userCount, 2);

      const users = await (await fetch(base + '/api/admin/users?q=alice', { headers: auth })).json();
      assert.equal(users.users.length, 1);
      assert.equal(users.users[0].email, 'alice@admin.co');

      const detail = await (await fetch(base + '/api/admin/users/' + alice.id, { headers: auth })).json();
      assert.equal(detail.user.id, alice.id);
      assert.equal(detail.tasks.length, 2);

      const missing = await fetch(base + '/api/admin/users/does-not-exist', { headers: auth });
      assert.equal(missing.status, 404);
    });
  });
});
