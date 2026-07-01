// ABOUTME: Opens the SQLite database, enables foreign keys, and applies schema.sql.
// ABOUTME: Every core module takes the handle this returns as its first argument (no global singleton).
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  // be10x is multi-process on one file: the HTTP server, the runner, and each spawned agent's MCP server
  // all open it. WAL lets readers and a single writer coexist; a busy timeout rides out the brief
  // write-write contention windows instead of failing with SQLITE_BUSY. (Both are no-ops for :memory:.)
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
