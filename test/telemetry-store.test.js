// ABOUTME: Server-side ingestion of a telemetry batch — recordTelemetryBatch (unit) and the
// ABOUTME: public POST /api/telemetry route (HTTP), including the defense-in-depth caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';
import { recordTelemetryBatch } from '../src/telemetry/store.js';
import { MAX_EVENTS_PER_BATCH } from '../src/telemetry/telemetry.js';

function rows(db) {
  return db.prepare('SELECT * FROM telemetry_events ORDER BY rowid').all();
}

test('recordTelemetryBatch requires an installId', () => {
  const db = openDb(':memory:');
  assert.throws(() => recordTelemetryBatch(db, { events: [{ event: 'cli_command' }] }), /MISSING_FIELD:installId/);
});

test('recordTelemetryBatch stores well-formed events with the batch-level fields on each row', () => {
  const db = openDb(':memory:');
  const result = recordTelemetryBatch(db, {
    installId: 'install-1',
    cliVersion: '0.1.0',
    os: 'darwin',
    nodeVersion: 'v22.0.0',
    events: [
      { event: 'cli_command', command: 'link', ok: true, occurredAt: 1000 },
      { event: 'task_run', taskId: 't1', content: 'plan text', occurredAt: 2000 },
    ],
  });
  assert.equal(result.received, 2);
  const stored = rows(db);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].install_id, 'install-1');
  assert.equal(stored[0].cli_version, '0.1.0');
  assert.equal(stored[0].event, 'cli_command');
  assert.equal(stored[0].occurred_at, 1000);
  assert.deepEqual(JSON.parse(stored[0].payload_json), { command: 'link', ok: true });
  assert.equal(stored[1].event, 'task_run');
  assert.deepEqual(JSON.parse(stored[1].payload_json), { taskId: 't1', content: 'plan text' });
});

test('recordTelemetryBatch silently drops malformed individual events but keeps the well-formed ones', () => {
  const db = openDb(':memory:');
  const result = recordTelemetryBatch(db, {
    installId: 'install-2',
    events: [null, 'not an object', { noEventField: true }, { event: '' }, { event: 'cli_command', command: 'link' }],
  });
  assert.equal(result.received, 1);
  assert.equal(rows(db).length, 1);
});

test('recordTelemetryBatch caps the batch at MAX_EVENTS_PER_BATCH even if more are sent', () => {
  const db = openDb(':memory:');
  const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 25 }, (_, i) => ({ event: 'cli_command', i }));
  const result = recordTelemetryBatch(db, { installId: 'install-3', events });
  assert.equal(result.received, MAX_EVENTS_PER_BATCH);
  assert.equal(rows(db).length, MAX_EVENTS_PER_BATCH);
});

test('recordTelemetryBatch treats a missing/non-array events field as an empty batch, not an error', () => {
  const db = openDb(':memory:');
  const result = recordTelemetryBatch(db, { installId: 'install-4' });
  assert.equal(result.received, 0);
  assert.equal(rows(db).length, 0);
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

test('POST /api/telemetry requires no session/auth and stores the batch', async () => {
  await withServer(async (base, db) => {
    const res = await fetch(base + '/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: 'http-install-1',
        cliVersion: '0.1.0',
        events: [{ event: 'cli_command', command: 'connect', occurredAt: Date.now() }],
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.received, 1);
    assert.equal(rows(db).length, 1);
  });
});

test('POST /api/telemetry without an installId returns a 4xx, not a 500', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ event: 'cli_command' }] }),
    });
    assert.ok(res.status >= 400 && res.status < 500);
  });
});

// GET /api/telemetry — the internal viewer, gated behind GFA_ADMIN_TOKEN. Mutates process.env for
// the duration of each test, always restored in `finally` so it never leaks into other test files.
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

test('GET /api/telemetry is a 404 when GFA_ADMIN_TOKEN is not configured at all, even with a bearer token', async () => {
  await withAdminToken(undefined, async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/api/telemetry', { headers: { Authorization: 'Bearer anything' } });
      assert.equal(res.status, 404);
    });
  });
});

test('GET /api/telemetry is a 404 with no Authorization header, or the wrong token', async () => {
  await withAdminToken('correct-secret', async () => {
    await withServer(async (base) => {
      const noAuth = await fetch(base + '/api/telemetry');
      assert.equal(noAuth.status, 404);
      const wrongAuth = await fetch(base + '/api/telemetry', { headers: { Authorization: 'Bearer wrong-secret' } });
      assert.equal(wrongAuth.status, 404);
    });
  });
});

test('GET /api/telemetry returns recent events, newest first, with the correct admin token', async () => {
  await withAdminToken('correct-secret', async () => {
    await withServer(async (base, db) => {
      recordTelemetryBatch(db, {
        installId: 'view-1',
        cliVersion: '0.1.0',
        events: [
          { event: 'cli_command', command: 'link', occurredAt: 1000 },
          { event: 'task_run', taskId: 't1', content: 'plan text', occurredAt: 2000 },
        ],
      });
      const res = await fetch(base + '/api/telemetry', { headers: { Authorization: 'Bearer correct-secret' } });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.events.length, 2);
      assert.equal(json.events[0].event, 'task_run', 'newest (higher received_at) first');
      assert.equal(json.events[0].content, 'plan text');
      assert.equal(json.events[1].command, 'link');
    });
  });
});

test('GET /api/telemetry respects limit and installId filters', async () => {
  await withAdminToken('correct-secret', async () => {
    await withServer(async (base, db) => {
      recordTelemetryBatch(db, { installId: 'a', events: [{ event: 'cli_command' }, { event: 'cli_command' }] });
      recordTelemetryBatch(db, { installId: 'b', events: [{ event: 'cli_command' }] });

      const filtered = await fetch(base + '/api/telemetry?installId=b', { headers: { Authorization: 'Bearer correct-secret' } });
      assert.equal((await filtered.json()).events.length, 1);

      const limited = await fetch(base + '/api/telemetry?limit=1', { headers: { Authorization: 'Bearer correct-secret' } });
      assert.equal((await limited.json()).events.length, 1);
    });
  });
});
