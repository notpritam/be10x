// ABOUTME: Opens the SQLite database, enables foreign keys, and applies schema.sql.
// ABOUTME: Every core module takes the handle this returns as its first argument (no global singleton).
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Additive column migrations for databases created by an earlier build. schema.sql uses CREATE TABLE
// IF NOT EXISTS, which is a no-op on a table that already exists — so a db from before a column was
// added keeps its old shape and code that writes the new column crashes with "no such column". Each
// entry names a column that MUST exist; we ADD it (idempotently) when it's missing, so any old db
// self-heals on open. Additive only: new columns must be nullable or carry a constant DEFAULT.
const COLUMN_MIGRATIONS = [
  { table: 'runs', column: 'executor', ddl: "ALTER TABLE runs ADD COLUMN executor TEXT NOT NULL DEFAULT 'claude'" },
  { table: 'runs', column: 'model', ddl: 'ALTER TABLE runs ADD COLUMN model TEXT' },
  { table: 'tasks', column: 'artifacts_json', ddl: 'ALTER TABLE tasks ADD COLUMN artifacts_json TEXT' },
];

// Bring an existing db up to the current schema without dropping data. Table names here are our own
// constants (never user input), so interpolating them into PRAGMA is safe.
export function migrate(db) {
  for (const m of COLUMN_MIGRATIONS) {
    const has = db.prepare(`PRAGMA table_info(${m.table})`).all().some((c) => c.name === m.column);
    if (!has) db.exec(m.ddl);
  }
}

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  // be10x is multi-process on one file: the HTTP server, the runner, and each spawned agent's MCP server
  // all open it. WAL lets readers and a single writer coexist; a busy timeout rides out the brief
  // write-write contention windows instead of failing with SQLITE_BUSY. (Both are no-ops for :memory:.)
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}
