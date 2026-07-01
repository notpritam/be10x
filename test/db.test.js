import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { openDb, migrate } from '../src/db/db.js';

test('openDb applies the schema and enforces foreign keys', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['comments', 'input_requests', 'memberships', 'projects', 'reviews', 'runs', 'sessions', 'share_links', 'task_events', 'tasks', 'teams', 'tokens', 'users', 'wake_queue']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

// Regression: a db created before the runs.executor/model columns existed must self-heal on open,
// not crash later with "no such column" when the executor persists the agent's model. (This is the
// bug that took down a running `be10x serve` — CREATE TABLE IF NOT EXISTS never alters an old table.)
test('migrate self-heals a runs table created before the executor/model columns existed', () => {
  const path = join(tmpdir(), `be10x-migrate-${randomUUID()}.db`);
  const cleanup = () => ['', '-wal', '-shm'].forEach((s) => rmSync(path + s, { force: true }));
  try {
    // An old-shape db: a runs table WITHOUT executor/model, holding a pre-existing row.
    const old = new Database(path);
    old.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'starting', created_at INTEGER NOT NULL)");
    old.prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)').run('r1', 't1', 'done', 1);
    old.close();

    // Opening through openDb adds the missing columns and preserves the existing row.
    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    assert.ok(cols.includes('executor'), 'executor column added');
    assert.ok(cols.includes('model'), 'model column added');
    const row = db.prepare('SELECT executor, model FROM runs WHERE id = ?').get('r1');
    assert.equal(row.executor, 'claude'); // NOT NULL DEFAULT backfills existing rows
    assert.equal(row.model, null);

    // Idempotent: running migrate again on an already-migrated db is a no-op, not an error.
    assert.doesNotThrow(() => migrate(db));
    db.close();
  } finally {
    cleanup();
  }
});
