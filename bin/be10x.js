#!/usr/bin/env node
// ABOUTME: The be10x CLI — the "use it on a real repo" layer. Registers the cwd as a project, mints an
// ABOUTME: MCP config for Claude Code (`link`), runs the local agent runner (`work`), and serves the board.
// Dependency-free: node built-ins + the project's own src/* core only.
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { openDb } from '../src/db/db.js';
import { getUserByEmail } from '../src/auth/users.js';
import { createToken } from '../src/auth/tokens.js';
import { listTasks, importTask, IMPORT_PHASES, handoffReasonForPhase } from '../src/tasks/tasks.js';
import { makeClaudeExecutor } from '../src/executor/executor.js';
import { detectProjectKey, registerProject, getProjectByKey, listProjects } from '../src/projects/projects.js';
import { enqueueWake } from '../src/executor/wake.js';
import { wakeLoop, wakeLoopAll } from '../src/runner/runner.js';

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
  const db = openDb(dbPathAbs());
  startServer({ db, port: args.port ? Number(args.port) : 4610, host: args.host && args.host !== true ? args.host : undefined });
  // Board-wide runner baked into serve: works tasks across every linked repo, spawning the agent in each
  // task's own repo — so the user never needs a separate `be10x work` terminal.
  const makeExecutor = (project) => makeClaudeExecutor(db, project, { model: process.env.GFA_MODEL, workerId: 'runner' });
  wakeLoopAll(db, { workerId: 'runner', makeExecutor });
  console.log('be10x runner working all linked repos on board wakes.');
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

  // Real executor: spawn an ephemeral Claude session in the task's own worktree and stream it to the board.
  const claudeExecute = makeClaudeExecutor(db, project, { model: process.env.GFA_MODEL, workerId });
  const execute = async (task, runOpts = {}) => {
    const stamp = () => new Date().toISOString();
    console.log('[' + stamp() + '] ' + task.humanId + ' (' + (runOpts.mode || 'plan') + ') — ' + task.title);
    const summary = await claudeExecute(task, runOpts);
    console.log(
      '[' + stamp() + '] ' + task.humanId + ' ' + (summary.done ? 'done' : 'failed') +
        (summary.sessionId ? ' · session ' + summary.sessionId : '')
    );
    return summary;
  };

  console.log(
    'be10x runner watching ' + key + ' for board wakes' +
      (once ? ' (single pass)' : ' every ' + intervalMs + 'ms — Ctrl-C to stop')
  );
  const loop = wakeLoop(db, { projectId: project.id, workerId, intervalMs, execute, once });

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

// Read a file that may hold JSON (a plan object, a research payload, an artifacts array) or plain text
// (an HTML/markdown plan). Returns the parsed value, the raw string, or null when no path was given.
function readPayload(p) {
  if (!p || p === true) return null;
  const raw = readFileSync(resolve(process.cwd(), p), 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// adopt --title "..." [--type ..] [--phase ..] [--project key] [--summary ..] [--symptom ..]
//       [--plan-file f] [--research-file f] [--artifacts-file f] [--refs-file f] [--handoff] [--email E]
// Move the work from THIS terminal/session onto the board as one task — the CLI half of "adopt to board".
// Files it under --project (or the cwd's linked repo, else personal), at the given --phase, attaching any
// plan/research/artifacts/refs files. The agent-driven path (gfa_import_task / the be10x-adopt skill) is
// richer because it captures the live session's state; this is the scriptable equivalent.
async function cmdAdopt(args) {
  const db = openDb(dbPathAbs());
  const userId = resolveUserId(db, args.email);
  if (!userId) {
    console.error(SIGNUP_HINT);
    process.exit(1);
  }

  const title = args.title && args.title !== true ? args.title : null;
  if (!title) {
    console.error('adopt needs --title "..."');
    process.exit(1);
  }

  const phase = args.phase && args.phase !== true ? String(args.phase) : 'idea';
  if (!IMPORT_PHASES.includes(phase)) {
    console.error('--phase must be one of: ' + IMPORT_PHASES.join(', '));
    process.exit(1);
  }

  // Project: explicit --project wins; otherwise adopt into the cwd's repo if it's linked; else personal.
  let projectId = null;
  let projectLabel = 'personal';
  const explicit = args.project && args.project !== true ? args.project : null;
  const key = explicit || detectProjectKey(process.cwd()).key;
  const project = getProjectByKey(db, key);
  if (explicit && !project) {
    console.error('Unknown project "' + key + '". Run `be10x link` in that repo first, or omit --project for a personal task.');
    process.exit(1);
  }
  if (project) {
    projectId = project.id;
    projectLabel = project.key;
  }

  const artifactsRaw = readPayload(args['artifacts-file']);
  const artifacts = Array.isArray(artifactsRaw) ? artifactsRaw : artifactsRaw ? [artifactsRaw] : null;

  const task = importTask(
    db,
    {
      title,
      type: args.type && args.type !== true ? args.type : 'general',
      projectId,
      severity: args.severity && args.severity !== true ? args.severity : 'medium',
      summary: args.summary && args.summary !== true ? args.summary : null,
      symptom: args.symptom && args.symptom !== true ? args.symptom : null,
      research: readPayload(args['research-file']),
      plan: readPayload(args['plan-file']),
      artifacts,
      refs: readPayload(args['refs-file']),
      phase,
      source: 'cli-adopt',
    },
    userId
  );

  let handed = false;
  const reason = handoffReasonForPhase(phase);
  if (args.handoff && reason) {
    enqueueWake(db, task.id, reason);
    handed = true;
  }

  console.log(task.humanId + '  ' + task.title + '  [' + task.status + ']  project=' + projectLabel);
  console.log('Adopted onto the board' + (handed ? ' and handed to the agent (' + reason + ').' : '.'));
  console.log('Control it from the board: be10x serve → http://localhost:4610  →  /t/' + task.id + '/full');
}

// install-skill — copy the /be10x-adopt skill into ~/.claude/skills so any Claude Code session can run it.
// This is the "key": in a repo you've `be10x link`-ed, /be10x-adopt pushes the session onto the board.
async function cmdInstallSkill() {
  const src = resolve(here, '..', 'skills', 'be10x-adopt');
  if (!existsSync(src)) {
    console.error('Skill source not found at ' + src);
    process.exit(1);
  }
  const dest = join(homedir(), '.claude', 'skills', 'be10x-adopt');
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('Installed the /be10x-adopt skill → ' + dest);
  console.log('');
  console.log('Use it: in any repo linked with `be10x link`, open Claude Code and run /be10x-adopt');
  console.log('(or just say "move this to the 10x board") to push the session onto the board.');
}

// --- dispatch -----------------------------------------------------------------

const COMMANDS = {
  serve: cmdServe,
  link: cmdLink,
  token: cmdToken,
  work: cmdWork,
  list: cmdList,
  adopt: cmdAdopt,
  'install-skill': cmdInstallSkill,
};

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
  console.log('  adopt --title T [--phase P] ...  move this session\'s work onto the board as a task');
  console.log('  install-skill                    install the /be10x-adopt skill into ~/.claude/skills');
  console.log('');
  console.log('  adopt options: --type code-issue|general  --project KEY  --phase ' + IMPORT_PHASES.join('|'));
  console.log('                 --summary S  --symptom S  --plan-file F  --research-file F');
  console.log('                 --artifacts-file F  --refs-file F  --handoff  --email E');
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
