// ABOUTME: The projects-table rebuild migration (db.js migrateProjectsTable) — old databases must self-heal
// ABOUTME: without losing data, and existing linked repos must backfill ownership from their task history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/db.js';

// Hand-build the OLD shape (pre-2026-07-03): a global UNIQUE(key) projects table with no owner_id/team_id,
// plus the users/teams/tasks tables the backfill query joins against.
function oldShapeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, bias_md TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE memberships (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, default_branch TEXT, root_path TEXT, created_at INTEGER NOT NULL);
    -- Already past the earlier (unrelated) executor/model column migrations, just not this one.
    CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, executor TEXT NOT NULL DEFAULT 'claude', model TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, human_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, team_id TEXT, project_id TEXT,
      owner_id TEXT NOT NULL, assignee_id TEXT, reviewer_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
      content_json TEXT NOT NULL DEFAULT '{}', plan_json TEXT, research_json TEXT, rating_json TEXT, refs_json TEXT, agent_json TEXT,
      artifacts_json TEXT, retry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

test('migrateProjectsTable adds owner_id/team_id, preserves every existing row, and is a no-op the second time', () => {
  const db = oldShapeDb();
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run('u1', 'a@b.co', 'A', 'x', now);
  db.prepare('INSERT INTO teams (id,name,slug,created_by,created_at) VALUES (?,?,?,?,?)').run('t1', 'Team', 'team', 'u1', now);
  db.prepare('INSERT INTO projects (id,key,name,default_branch,root_path,created_at) VALUES (?,?,?,?,?,?)').run(
    'p-with-history', 'github.com/acme/app', 'App', 'main', '/repo', now
  );
  db.prepare('INSERT INTO projects (id,key,name,default_branch,root_path,created_at) VALUES (?,?,?,?,?,?)').run(
    'p-no-history', 'local:orphan', 'Orphan', null, null, now
  );
  // A task filed under p-with-history tells the migration who it really belongs to.
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,team_id,project_id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task1', 'GFA-001', 'general', 'team', 't1', 'p-with-history', 'u1', 'T', 'backlog', now, now);

  migrate(db);

  const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  assert.ok(cols.includes('owner_id'));
  assert.ok(cols.includes('team_id'));

  const withHistory = db.prepare('SELECT * FROM projects WHERE id = ?').get('p-with-history');
  assert.equal(withHistory.owner_id, 'u1', "backfilled from the earliest task's owner");
  assert.equal(withHistory.team_id, 't1', "backfilled from that task's team");
  assert.equal(withHistory.name, 'App', 'unrelated columns untouched');
  assert.equal(withHistory.root_path, '/repo');

  const noHistory = db.prepare('SELECT * FROM projects WHERE id = ?').get('p-no-history');
  assert.equal(noHistory.owner_id, null, 'no task history to backfill from — stays legacy/ownerless');
  assert.equal(noHistory.team_id, null);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c, 2, 'no rows lost in the rebuild');

  // Running it again on an already-migrated db must be a safe no-op (idempotent — every process that
  // opens this db calls migrate() independently).
  assert.doesNotThrow(() => migrate(db));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c, 2);
});

test('the new partial unique indexes allow the same key for two different owners after migration', () => {
  const db = oldShapeDb();
  migrate(db);
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run('u1', 'a@b.co', 'A', 'x', now);
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run('u2', 'b@b.co', 'B', 'x', now);
  db.prepare('INSERT INTO projects (id,key,name,owner_id,created_at) VALUES (?,?,?,?,?)').run('pa', 'local:dup', 'A app', 'u1', now);
  assert.doesNotThrow(() =>
    db.prepare('INSERT INTO projects (id,key,name,owner_id,created_at) VALUES (?,?,?,?,?)').run('pb', 'local:dup', 'B app', 'u2', now)
  );
});
