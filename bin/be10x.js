#!/usr/bin/env node
// ABOUTME: The be10x CLI — the "use it on a real repo" layer. Registers the cwd as a project, mints an
// ABOUTME: MCP config for Claude Code (`link`), runs the local agent runner (`work`), and serves the board.
// Dependency-free: node built-ins + the project's own src/* core only.
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/db/db.js';
import { getUserByEmail } from '../src/auth/users.js';
import { createToken } from '../src/auth/tokens.js';
import { listTasks } from '../src/tasks/tasks.js';
import { recordProgress } from '../src/worker/worker.js';
import { detectProjectKey, registerProject, getProjectByKey, listProjects } from '../src/projects/projects.js';
import { workLoop } from '../src/runner/runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const SIGNUP_HINT = 'Sign up on the board first: be10x serve → http://localhost:4610';

// Tiny arg parser: `--flag value` -> { flag: 'value' }, bare `--flag` -> { flag: true }, rest in `_`.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Absolute db path so the CLI, the runner, and the MCP server (launched by Claude Code from any cwd) all
// open the exact same SQLite file.
function dbPathAbs() {
  return resolve(process.cwd(), process.env.GFA_DB_PATH || './gfa.db');
}

const mcpServerPath = () => resolve(here, '..', 'src', 'mcp', 'server.js');

// Owning user: an explicit --email/GFA_EMAIL wins; otherwise the single/first user on the board. Null if
// there's no such user (the caller prints the signup hint and exits).
function resolveUserId(db, email) {
  const e = email && email !== true ? email : process.env.GFA_EMAIL;
  if (e) {
    const u = getUserByEmail(db, e);
    return u ? u.id : null;
  }
  const row = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get();
  return row ? row.id : null;
}

// --- commands -----------------------------------------------------------------

// serve [--port N] — boot the HTTP board. Dynamic import so the http stack only loads for this command.
async function cmdServe(args) {
  const { startServer } = await import('../src/http/server.js');
  startServer({ port: args.port ? Number(args.port) : 4610 });
}

// link [--name X] [--email you@x] — register the cwd as a project, mint a cli token, and write + print a
// Claude-Code MCP config wiring the be10x tools to this repo's board.
async function cmdLink(args) {
  const dbPath = dbPathAbs();
  const db = openDb(dbPath);
  const cwd = process.cwd();
  const { key, rootPath, defaultBranch } = detectProjectKey(cwd);
  const name = args.name && args.name !== true ? args.name : basename(rootPath);
  const project = registerProject(db, { key, name, rootPath, defaultBranch });

  const userId = resolveUserId(db, args.email);
  if (!userId) {
    console.error(SIGNUP_HINT);
    process.exit(1);
  }

  const { token } = createToken(db, userId, 'cli:' + key);
  const config = {
    mcpServers: {
      be10x: {
        command: 'node',
        args: [mcpServerPath()],
        env: { GFA_TOKEN: token, GFA_DB_PATH: dbPath },
      },
    },
  };

  const dir = join(cwd, '.be10x');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, 'mcp.json');
  const json = JSON.stringify(config, null, 2);
  writeFileSync(outPath, json + '\n');

  console.log(json);
  console.log('');
  console.log('Linked project: ' + project.key + '  (' + project.name + ')');
  console.log('Wrote MCP config: ' + outPath);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Open this repo in Claude Code — it now has the be10x tools.');
  console.log('  2. Move a task to "Ready to work" on the board and Claude Code can claim it.');
}

// token [--name X] [--email you@x] — mint a personal access token; the secret is shown once.
async function cmdToken(args) {
  const db = openDb(dbPathAbs());
  const userId = resolveUserId(db, args.email);
  if (!userId) {
    console.error(SIGNUP_HINT);
    process.exit(1);
  }
  const name = args.name && args.name !== true ? args.name : 'cli';
  const { token } = createToken(db, userId, name);
  console.log(token);
  console.log('');
  console.log('(secret shown once — set it as GFA_TOKEN, it cannot be retrieved again)');
}

// work [--interval S] [--once] — run the agent runner against the cwd's project.
async function cmdWork(args) {
  const db = openDb(dbPathAbs());
  const { key } = detectProjectKey(process.cwd());
  const project = getProjectByKey(db, key);
  if (!project) {
    console.error('Repo not linked (' + key + '). Run: be10x link');
    process.exit(1);
  }

  const workerId = 'runner';
  const intervalMs = (args.interval && args.interval !== true ? Number(args.interval) : 3) * 1000;
  const once = !!args.once;

  // Default executor: log the claim and drop a "runner picked up" progress note onto the task.
  const execute = async (task) => {
    console.log(
      '[' + new Date().toISOString() + '] claimed ' + task.humanId + ' (' + task.type + ') — ' + task.title
    );
    recordProgress(
      db,
      task.id,
      { state: 'working', step: 'runner picked up', message: 'runner picked up ' + task.humanId },
      workerId
    );
  };

  console.log(
    'be10x runner watching ' + key + (once ? ' (single pass)' : ' every ' + intervalMs + 'ms — Ctrl-C to stop')
  );
  const loop = workLoop(db, { projectId: project.id, workerId, intervalMs, execute, once });

  if (once) {
    const result = await loop.done;
    if (!result) console.log('nothing ready to work.');
    process.exit(0);
  }
  process.on('SIGINT', () => {
    loop.stop();
    console.log('\nstopped.');
    process.exit(0);
  });
}

// list — print registered projects and, for the cwd's project, its tasks grouped by status.
async function cmdList() {
  const db = openDb(dbPathAbs());
  const projects = listProjects(db);
  console.log('Registered projects (' + projects.length + '):');
  for (const p of projects) {
    console.log('  ' + p.key + '  ' + p.name + (p.rootPath ? '  [' + p.rootPath + ']' : ''));
  }

  const { key } = detectProjectKey(process.cwd());
  const project = getProjectByKey(db, key);
  console.log('');
  if (!project) {
    console.log('Current repo (' + key + ') is not linked. Run: be10x link');
    return;
  }
  const tasks = listTasks(db, {}).filter((t) => t.projectId === project.id);
  console.log('Tasks for ' + key + ' (' + tasks.length + '):');
  if (!tasks.length) {
    console.log('  (none)');
    return;
  }
  const byStatus = {};
  for (const t of tasks) (byStatus[t.status] ||= []).push(t);
  for (const status of Object.keys(byStatus)) {
    console.log('  ' + status + ':');
    for (const t of byStatus[status]) console.log('    ' + t.humanId + '  ' + t.title);
  }
}

// --- dispatch -----------------------------------------------------------------

const COMMANDS = { serve: cmdServe, link: cmdLink, token: cmdToken, work: cmdWork, list: cmdList };

function usage() {
  console.log('be10x — git-for-agents CLI');
  console.log('Usage: node bin/be10x.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  serve [--port N]                 run the HTTP board');
  console.log('  link  [--name X] [--email E]     register this repo + write Claude-Code MCP config');
  console.log('  token [--name X] [--email E]     mint a personal access token (shown once)');
  console.log('  work  [--interval S] [--once]    run the agent runner for this repo');
  console.log('  list                             list projects and this repo\'s tasks by status');
  console.log('');
  console.log('Env: GFA_DB_PATH (default ./gfa.db), GFA_EMAIL');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const fn = COMMANDS[cmd];
  if (!fn) {
    usage();
    process.exit(cmd ? 1 : 0);
  }
  await fn(parseArgs(argv.slice(1)));
}

main().catch((e) => {
  console.error(String(e?.stack || e?.message || e));
  process.exit(1);
});
