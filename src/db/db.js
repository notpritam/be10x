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
  { table: 'runs', column: 'input_tokens', ddl: 'ALTER TABLE runs ADD COLUMN input_tokens INTEGER' },
  { table: 'runs', column: 'output_tokens', ddl: 'ALTER TABLE runs ADD COLUMN output_tokens INTEGER' },
  { table: 'runs', column: 'cache_creation_tokens', ddl: 'ALTER TABLE runs ADD COLUMN cache_creation_tokens INTEGER' },
  { table: 'runs', column: 'cache_read_tokens', ddl: 'ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER' },
  { table: 'runs', column: 'cost_usd', ddl: 'ALTER TABLE runs ADD COLUMN cost_usd REAL' },
  // Where the agent actually runs — the executor's os.hostname() (a member's laptop in the hosted model,
  // the VM for board-run tasks). Powers "where is this running" in `be10x ps` and the board.
  { table: 'runs', column: 'host', ddl: 'ALTER TABLE runs ADD COLUMN host TEXT' },
  { table: 'bugs', column: 'session_key', ddl: 'ALTER TABLE bugs ADD COLUMN session_key TEXT' },
  { table: 'bugs', column: 'tags', ddl: 'ALTER TABLE bugs ADD COLUMN tags TEXT' },
  { table: 'bugs', column: 'task_id', ddl: 'ALTER TABLE bugs ADD COLUMN task_id TEXT' },
  { table: 'bugs', column: 'source_key', ddl: 'ALTER TABLE bugs ADD COLUMN source_key TEXT' },
];

// One-time rebuild for `projects`: the original table had a global UNIQUE(key) column constraint and no
// owner/team identity, which let two different accounts' repos collide onto one shared row (see
// docs/rca-2026-07-03-account-isolation.md, issue 2). SQLite can't ALTER a column's constraints in place,
// so this recreates the table with owner_id/team_id, copies the data across, then best-effort backfills
// ownership from task history (the earliest task filed under that project tells us who/which team it
// really belongs to). Rows with no task history stay NULL/NULL — pre-existing, ownerless, and treated as
// legacy-visible-to-everyone by the scoping queries, exactly as they behaved before this migration. Guarded
// by the `owner_id` column check so it's idempotent and safe to run redundantly from every process that
// opens this db (the http server, the local runner, and each spawned agent's MCP server all call openDb()).
function migrateProjectsTable(db) {
  const cols = db.prepare('PRAGMA table_info(projects)').all();
  if (cols.some((c) => c.name === 'owner_id')) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE projects_new (
        id             TEXT PRIMARY KEY,
        key            TEXT NOT NULL,
        name           TEXT NOT NULL,
        default_branch TEXT,
        root_path      TEXT,
        owner_id       TEXT REFERENCES users(id),
        team_id        TEXT REFERENCES teams(id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL
      );
      INSERT INTO projects_new (id, key, name, default_branch, root_path, created_at)
        SELECT id, key, name, default_branch, root_path, created_at FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;

      UPDATE projects SET owner_id = (
        SELECT owner_id FROM tasks WHERE tasks.project_id = projects.id ORDER BY tasks.created_at LIMIT 1
      );
      UPDATE projects SET team_id = (
        SELECT team_id FROM tasks WHERE tasks.project_id = projects.id AND tasks.team_id IS NOT NULL ORDER BY tasks.created_at LIMIT 1
      );
    `);
  })();
}

// The partial unique indexes that give `projects` its scoped identity (one row per (key, team) for
// team projects, one row per (key, owner) for personal ones). Deliberately NOT inlined into
// schema.sql's CREATE TABLE block: CREATE TABLE IF NOT EXISTS is a no-op against a database that
// already has an (old-shape) `projects` table, so an index statement placed there would run
// against the OLD columns and crash with "no such column: team_id" before migrateProjectsTable()
// ever got a chance to add them — exactly what took down every deploy since that migration
// landed. Calling this LAST in migrate(), after both COLUMN_MIGRATIONS and migrateProjectsTable()
// have run, guarantees owner_id/team_id already exist on every path (fresh table via schema.sql,
// already-migrated table, or a table this exact migrate() call just rebuilt).
function ensureProjectsIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_team_key ON projects (key, team_id) WHERE team_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_key ON projects (key, owner_id) WHERE team_id IS NULL AND owner_id IS NOT NULL;
  `);
}

// Bring an existing db up to the current schema without dropping data. Table names here are our own
// constants (never user input), so interpolating them into PRAGMA is safe.
export function migrate(db) {
  for (const m of COLUMN_MIGRATIONS) {
    const info = db.prepare(`PRAGMA table_info(${m.table})`).all();
    // A COLUMN_MIGRATION only applies to a table that already exists. In a real boot schema.sql (which
    // CREATEs every table) runs before migrate(), so the target table is always present and this guard is
    // a no-op; it only matters when migrate() is called against a partially hand-built db (e.g. a unit
    // test's old-shape fixture that predates a table) — there the table would be created, already carrying
    // this column, by schema.sql on a real open, so skipping the ALTER is the correct behavior.
    if (info.length === 0) continue;
    if (!info.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
  migrateProjectsTable(db);
  ensureProjectsIndexes(db);
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
