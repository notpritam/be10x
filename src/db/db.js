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
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
