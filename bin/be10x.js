#!/usr/bin/env node
// ABOUTME: The be10x CLI — the "use it on a real repo" layer. Registers the cwd as a project, mints an
// ABOUTME: MCP config for Claude Code (`link`), runs the local agent runner (`work`), and serves the board.
// Dependency-free: node built-ins + the project's own src/* core only.
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, resolve, join, basename } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { getUserByEmail } from '../src/auth/users.js';
import { createToken } from '../src/auth/tokens.js';
import { listTasks, importTask, IMPORT_PHASES, handoffReasonForPhase, archiveTask, getTask, resolveTaskId, transition, createTask } from '../src/tasks/tasks.js';
import { assembleFleetStatus } from '../src/tasks/fleet.js';
import { formatFleetTable } from '../src/cli/fleet-format.js';
import { makeClaudeExecutor } from '../src/executor/executor.js';
import { detectProjectKey, registerProject, getProjectByKey, getProject, listProjects } from '../src/projects/projects.js';
import { getLatestRunForTask } from '../src/executor/runs.js';
import { gcTaskWorktrees } from '../src/executor/worktree.js';
import { enqueueWake } from '../src/executor/wake.js';
import { wakeLoop, wakeLoopAll } from '../src/runner/runner.js';
import { makeRemoteExecutor } from '../src/connect/remote-executor.js';
import { makeBoardClient, connectLoop, writeMcpConfig, loadConnectConfig, saveConnectConfig, connectConfigPath, runDeviceLogin, upsertRepo } from '../src/connect/connect.js';
import { makeAutoUpdater, fetchBoardVersion } from '../src/connect/auto-update.js';
import { runNotifyOnce, loadNotifyState, saveNotifyState } from '../src/connect/notify-loop.js';
import { showDeviceNotification } from '../src/connect/device-notify.js';
import { buildLaunchdPlist, buildSystemdUnit, serviceEnvPath, servicePaths, isRemovablePath } from '../src/connect/service.js';
import { assembleStatus, pickLastTask } from '../src/connect/status.js';
import { renderWelcome } from '../src/cli/welcome.js';
import { fg, dim, bold, sym, box, BRAND } from '../src/cli/ui.js';
import {
  loadTelemetryConfig,
  setTelemetryEnabled,
  effectiveEnabled,
  recordEvent,
  flushQueue,
  promptForConsent,
} from '../src/telemetry/telemetry.js';

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

// Open the board's local SQLite db, loading the native driver LAZILY so commands that don't touch a local
// db — notably `be10x connect`, which talks to a hosted board over HTTP — run even when better-sqlite3 (an
// OPTIONAL dependency) isn't installed or couldn't build on this machine.
async function openBoardDb(path = dbPathAbs()) {
  let openDb;
  try {
    ({ openDb } = await import('../src/db/db.js'));
  } catch {
    console.error("This command needs the local database driver (better-sqlite3), which isn't available here.");
    console.error('Install it with:  npm install better-sqlite3');
    console.error("(You don't need it for `be10x connect` — that talks to a hosted board over HTTP.)");
    process.exit(1);
  }
  return openDb(path);
}

const mcpServerPath = () => resolve(here, '..', 'src', 'mcp', 'server.js');
const bugMcpServerPath = () => resolve(here, '..', 'src', 'mcp', 'bug-server.js');
// The HTTP-transport twins, wired by the HOSTED path (`be10x connect` / `be10x link` remote): they forward
// gfa_* / bug_* calls to the board's /api/agent/rpc + /api/agent/bug-rpc instead of opening a local db.
const httpMcpServerPath = () => resolve(here, '..', 'src', 'mcp', 'http-server.js');
const httpBugMcpServerPath = () => resolve(here, '..', 'src', 'mcp', 'bug-http-server.js');

// Best-effort "open this URL in the default browser" for `be10x login`. Detached + unref'd so the CLI never
// waits on the browser; the URL is always printed too, so a headless box (no opener) just falls back to that.
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no opener available — the printed URL is the fallback */
  }
}

// --- welcome / version helpers ------------------------------------------------

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Ask a board which version it runs (public, unauthed) so the welcome can flag an available update. Tight
// timeout + swallow-all so a slow/unreachable board never blocks or errors the CLI.
async function fetchLatestVersion(board) {
  try {
    const res = await fetch(String(board).replace(/\/+$/, '') + '/api/version', { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return (await res.json()).version || null;
  } catch {
    return null;
  }
}

// Snapshot the local state the welcome screen renders: who/where you're signed in, whether the agent runs as
// a background service, your linked repos, and whether an update is out.
async function gatherWelcomeState() {
  const saved = loadConnectConfig() || {};
  const version = readPkgVersion();
  let service = 'none';
  try {
    const { execFileSync } = await import('node:child_process');
    const { plistPath, systemdPath, label, unit } = servicePaths();
    if (process.platform === 'darwin') {
      const listed = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).split('\n').some((l) => l.includes(label));
      service = listed ? 'running' : existsSync(plistPath) ? 'stopped' : 'none';
    } else if (process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['--user', 'is-active', unit], { stdio: 'ignore' });
        service = 'running';
      } catch {
        service = existsSync(systemdPath) ? 'stopped' : 'none';
      }
    }
  } catch {
    /* no service manager here — leave as 'none' */
  }
  const latest = saved.board ? await fetchLatestVersion(saved.board) : null;
  return {
    user: saved.user || null,
    signedIn: !!saved.token,
    board: saved.board || null,
    service,
    repos: (saved.repos || []).map((r) => r.key),
    version,
    latest,
  };
}

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
  const db = await openBoardDb();
  startServer({ db, port: args.port ? Number(args.port) : 4610, host: args.host && args.host !== true ? args.host : undefined });
  // Board-wide runner baked into serve: works tasks across every linked repo, spawning the agent in each
  // task's own repo — so the user never needs a separate `be10x work` terminal.
  // GFA_WORKER_ID labels this host's runner in run records (default 'runner'); we set it to the machine
  // identity (e.g. 'pritam') so work done on this VM is attributable to it across the board.
  const workerId = process.env.GFA_WORKER_ID || 'runner';
  // GFA_WORKER_USER (an email) is the user THIS host's baked runner acts for — strict assignee-routing then
  // only lets it claim tasks assigned to that user (plus unassigned). Unset ⇒ unassigned tasks only.
  let claimantUserId = null;
  if (process.env.GFA_WORKER_USER) {
    const u = getUserByEmail(db, process.env.GFA_WORKER_USER);
    if (u) claimantUserId = u.id;
    else console.error(`be10x: GFA_WORKER_USER "${process.env.GFA_WORKER_USER}" is not a board account — runner will claim only UNASSIGNED tasks.`);
  }
  const makeExecutor = (project) => makeClaudeExecutor(db, project, { model: process.env.GFA_MODEL, workerId });
  wakeLoopAll(db, { workerId, makeExecutor, claimantUserId });
  console.log('be10x runner working all linked repos on board wakes.');
}

// login [<board-url>] [--board URL] [--name label] — browser device-authorization against a HOSTED board.
// Opens the board's approve screen; once you click Authorize there (you're already logged in), the CLI
// collects a personal token and saves it to ~/.be10x/connect.json — so `be10x link` / `be10x connect`
// afterwards need no flags. The paste-free way onto a hosted board; the board URL is only needed once.
async function cmdLogin(args) {
  const cfgPath = connectConfigPath();
  const saved = loadConnectConfig(cfgPath) || {};
  const board = args._[0] || (args.board && args.board !== true ? args.board : null) || saved.board;
  if (!board) {
    console.error('Usage: be10x login <board-url>');
    console.error('  e.g. be10x login https://be10x.notpritam.in');
    process.exit(1);
  }
  const label = args.name && args.name !== true ? args.name : hostname();
  console.log('Connecting to ' + board + ' …');

  let result;
  try {
    result = await runDeviceLogin({
      board,
      label,
      open: openBrowser,
      log: (ev) => {
        if (ev.event === 'code') {
          console.log('');
          console.log('  Opening your browser to authorize this machine.');
          console.log("  If it doesn't open, visit:  " + ev.verificationUri);
          console.log('  Confirm this code matches:  ' + ev.userCode);
          console.log('');
          console.log('  Waiting for you to click Authorize on the board…  (Ctrl-C to cancel)');
        }
      },
    });
  } catch (e) {
    console.error('Login failed: ' + (e?.message ?? e));
    process.exit(1);
  }

  saveConnectConfig({ ...saved, board: result.board, token: result.token, user: result.user?.email || saved.user || null }, cfgPath);
  const who = result.user && (result.user.displayName || result.user.email);
  console.log('');
  console.log('✓ Logged in to ' + result.board + (who ? ' as ' + who : '') + '.');
  console.log('  Saved to ' + cfgPath);
  console.log('');
  console.log('Next:  cd into a repo, run  be10x link  — then  be10x connect');
}

// link [--name X] [--email you@x] — register THIS repo with the board and wire the agent's tools to it.
// Two modes, auto-detected: if you've run `be10x login` (a hosted board + token are saved), link registers
// the repo with that HOSTED board over HTTP — no local db, no flags. Otherwise it falls back to the local
// self-host link (a local SQLite board + a cli token). The hosted path is the common one for teammates.
async function cmdLink(args) {
  const cfgPath = connectConfigPath();
  const saved = loadConnectConfig(cfgPath) || {};
  if (saved.board && saved.token) return cmdLinkRemote(args, saved, cfgPath);
  return cmdLinkLocal(args);
}

// Hosted link: you've signed in with `be10x login`, so register this repo with the hosted board (path-less
// there — the checkout lives on your machine), write a board-pointing MCP config so the spawned agent's
// gfa_* tools reach the board over HTTP, and remember the repo so a bare `be10x connect` serves it.
async function cmdLinkRemote(args, saved, cfgPath) {
  const { key, rootPath } = detectProjectKey(process.cwd());
  const name = args.name && args.name !== true ? args.name : basename(rootPath);
  const client = makeBoardClient({ board: saved.board, token: saved.token });
  try {
    await client.registerProject(key, name);
  } catch (e) {
    console.error('Could not register this repo with ' + saved.board + ': ' + (e?.message ?? e));
    console.error('Your login may have expired — re-run:  be10x login ' + saved.board);
    process.exit(1);
  }
  writeMcpConfig(rootPath, {
    board: saved.board,
    token: saved.token,
    httpMcpServerPath: httpMcpServerPath(),
    bugHttpMcpServerPath: httpBugMcpServerPath(),
    uploadthingToken: process.env.UPLOADTHING_TOKEN,
  });
  saveConnectConfig({ ...saved, repos: upsertRepo(saved.repos, { key, path: rootPath }) }, cfgPath);

  console.log('✓ Linked ' + name + '  (' + key + ')  →  ' + saved.board);
  console.log('  Serving from ' + rootPath);
  console.log('');
  console.log('Start the agent for your linked repos:  be10x connect');
  console.log('Then create a task for this project on the board and your machine picks it up.');
}

// Local (self-host) link: no hosted login, so register the cwd against a LOCAL SQLite board, mint a cli
// token, and write a local-db MCP config. The original single-machine flow, kept for `be10x serve` users.
async function cmdLinkLocal(args) {
  const dbPath = dbPathAbs();
  const db = await openBoardDb(dbPath);

  const userId = resolveUserId(db, args.email);
  if (!userId) {
    console.error(SIGNUP_HINT);
    console.error('(Connecting to a hosted board instead? Run:  be10x login <board-url>)');
    process.exit(1);
  }

  const cwd = process.cwd();
  const { key, rootPath, defaultBranch } = detectProjectKey(cwd);
  const name = args.name && args.name !== true ? args.name : basename(rootPath);
  const project = registerProject(db, { key, name, rootPath, defaultBranch, ownerId: userId });

  const { token } = createToken(db, userId, 'cli:' + key);
  const config = {
    mcpServers: {
      be10x: {
        command: 'node',
        args: [mcpServerPath()],
        env: { GFA_TOKEN: token, GFA_DB_PATH: dbPath },
      },
      // Bug-debugging front door: paste a bug link and the agent scrubs its whole capture. The capture-body
      // tools (network/dom/replay) also need UPLOADTHING_TOKEN in this env — add it here to enable them; the
      // rest (console, picked elements, drawings, credentials, environment, markers, analysis) work without it.
      'be10x-bugs': {
        command: 'node',
        args: [bugMcpServerPath()],
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
  const db = await openBoardDb();
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
  const db = await openBoardDb();
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
  const execute = withTaskTelemetry(async (task, runOpts = {}) => {
    const stamp = () => new Date().toISOString();
    console.log('[' + stamp() + '] ' + task.humanId + ' (' + (runOpts.mode || 'plan') + ') — ' + task.title);
    const summary = await claudeExecute(task, runOpts);
    console.log(
      '[' + stamp() + '] ' + task.humanId + ' ' + (summary.done ? 'done' : 'failed') +
        (summary.sessionId ? ' · session ' + summary.sessionId : '')
    );
    return summary;
  });

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

// connect --board <url> --token <gfa_...> [--repos a,b] [--interval S] [--once] [--name label]
// Link THIS machine to a HOSTED board and run the agent locally: claim wakes for the repos you serve, spawn
// your OWN claude in each repo's worktree, and report back — the distributed runner. Unlike `be10x serve`
// (board + agent on one host), the board lives elsewhere and only state crosses the network. Flags are
// saved to ~/.be10x/connect.json so a bare `be10x connect` afterwards just works.
async function cmdConnect(args) {
  const cfgPath = connectConfigPath();
  const saved = loadConnectConfig(cfgPath) || {};
  const board = args.board && args.board !== true ? args.board : saved.board;
  const token = args.token && args.token !== true ? args.token : saved.token;
  if (!board || !token) {
    console.error('Not signed in to a board yet. Sign in first:');
    console.error('  be10x login <board-url>      e.g. be10x login https://be10x.notpritam.in');
    console.error('  cd <repo> && be10x link      link each repo you want the agent to work');
    console.error('(Advanced: be10x connect --board <url> --token <gfa_...> --repos a,b still works.)');
    process.exit(1);
  }

  // Repos to serve: --repos a,b,c (comma) wins; else the saved set; else the current directory.
  let repoPaths;
  if (args.repos && args.repos !== true) repoPaths = String(args.repos).split(',').map((s) => s.trim()).filter(Boolean);
  else if (Array.isArray(saved.repos) && saved.repos.length) repoPaths = saved.repos.map((r) => r.path);
  else repoPaths = [process.cwd()];

  const repos = repoPaths.map((p) => {
    const { key, rootPath, defaultBranch } = detectProjectKey(resolve(process.cwd(), p));
    return { key, path: rootPath, defaultBranch };
  });

  // Remember the setup so next time `be10x connect` alone works.
  saveConnectConfig({ board, token, repos: repos.map((r) => ({ key: r.key, path: r.path })) }, cfgPath);

  // Register each repo with the board + write a board-pointing MCP config so the spawned agent's gfa_* AND
  // be10x-bugs tools reach the board over HTTP (not a local db).
  const client = makeBoardClient({ board, token });
  for (const r of repos) {
    try {
      await client.registerProject(r.key, basename(r.path));
    } catch (e) {
      console.error('warning: could not register ' + r.key + ' with the board: ' + (e?.message ?? e));
    }
    writeMcpConfig(r.path, {
      board,
      token,
      httpMcpServerPath: httpMcpServerPath(),
      bugHttpMcpServerPath: httpBugMcpServerPath(),
      uploadthingToken: process.env.UPLOADTHING_TOKEN,
    });
  }

  const makeExecutor = (repo) =>
    withTaskTelemetry(
      makeRemoteExecutor(
        { rootPath: repo.path, defaultBranch: repo.defaultBranch },
        { model: process.env.GFA_MODEL, mcpConfigPath: join(repo.path, '.be10x', 'mcp.json') }
      )
    );
  const workerId = 'connect:' + (args.name && args.name !== true ? args.name : basename(repos[0]?.path || 'machine'));
  const intervalMs = (args.interval && args.interval !== true ? Number(args.interval) : 3) * 1000;
  const once = !!args.once;

  console.log('be10x connect → ' + board + (once ? '  (single pass)' : '  (Ctrl-C to stop)'));
  for (const r of repos) console.log('  serving ' + r.key + '  [' + r.path + ']');

  // connectLoop emits its own structured, timestamped heartbeat/lifecycle lines (poll/idle/claimed/reported/
  // run_failed) and a `poll_error` line on a caught cycle error via its default logger — which writes to stdout,
  // and the LaunchAgent tees that to ~/.be10x/connect.log. So no ad-hoc onError console line here: the structured
  // `poll_error` line replaces the old bare `connect: fetch failed`, keeping the log single-line and greppable.
  // Self-update: keep the always-on connector in sync with the board's advertised version (GET /api/version).
  // Default on; disable with `--no-auto-update`, env BE10X_AUTO_UPDATE=0, or "autoUpdate": false in
  // ~/.be10x/connect.json. Never in --once mode (a one-shot pass shouldn't reinstall + restart itself).
  const autoUpdateEnabled =
    !once && !args['no-auto-update'] && args['auto-update'] !== false && process.env.BE10X_AUTO_UPDATE !== '0' && saved.autoUpdate !== false;
  const autoUpdater = autoUpdateEnabled
    ? makeAutoUpdater({
        board,
        localVersion: readPkgVersion(),
        runUpdate: async () => {
          const { execFileSync } = await import('node:child_process');
          execFileSync('npm', ['install', '-g', 'github:notpritam/be10x'], { stdio: 'inherit' });
          process.exit(0); // KeepAlive (launchd/systemd) restarts us on the freshly-installed build
        },
      })
    : undefined;

  const loop = connectLoop({
    board: client,
    repos,
    makeExecutor,
    workerId,
    intervalMs,
    once,
    autoUpdater,
  });

  // Device notifications: on the same connection, poll this user's notification feed and pop a native OS
  // notification for anything they're tagged in (assigned / review / input / changes). On by default;
  // `be10x notify off` disables it. Decoupled from the claim loop — a slower cadence, best-effort.
  const notifyState = loadNotifyState();
  let notifyTimer;
  if (!once && notifyState.enabled) {
    const notifyEvery = Math.max(intervalMs, 10000);
    const tick = async () => {
      try {
        const { shown } = await runNotifyOnce({ board, token, state: notifyState });
        if (shown) saveNotifyState(notifyState);
      } catch { /* never let the notifier break the connector */ }
      notifyTimer = setTimeout(tick, notifyEvery);
    };
    notifyTimer = setTimeout(tick, notifyEvery);
  }

  if (once) {
    const result = await loop.done;
    if (!result || !result.claim) console.log('nothing ready to work.');
    process.exit(0);
  }
  process.on('SIGINT', () => {
    loop.stop();
    if (notifyTimer) clearTimeout(notifyTimer);
    console.log('\nstopped.');
    process.exit(0);
  });
}

// notify [on|off|test|status] — control the connector's native device notifications.
async function cmdNotify(args) {
  const sub = (args._[0] || 'status').toLowerCase();
  const state = loadNotifyState();
  if (sub === 'on' || sub === 'off') {
    state.enabled = sub === 'on';
    saveNotifyState(state);
    console.log('device notifications: ' + fg(state.enabled ? BRAND.ok : BRAND.dim || BRAND.bad, sub));
    return;
  }
  if (sub === 'test') {
    const ok = showDeviceNotification({ title: 'be10x', body: 'Notifications are working ✓' });
    console.log(ok ? sym.ok + ' sent a test notification (approve the OS prompt if asked).' : 'could not show a notification on this platform.');
    return;
  }
  console.log('device notifications: ' + (state.enabled ? fg(BRAND.ok, 'on') : 'off'));
  console.log(dim('usage: be10x notify [on|off|test|status]'));
}

// service <install|uninstall|status|logs> — run `be10x connect` as an always-on background service that
// starts on login/boot and restarts on crash (macOS launchd, Linux systemd --user). The set-and-forget way
// to keep this machine listening without a terminal open. Run it from your GLOBAL install for a boot-safe path.
async function cmdService(args) {
  const sub = (args._[0] || 'install').toLowerCase();
  const { execFileSync } = await import('node:child_process');
  const home = homedir();
  const { label, unit, logPath, plistPath, systemdPath } = servicePaths(home);
  const node = process.execPath;
  const cli = fileURLToPath(import.meta.url);

  // Run a command, returning combined stdout+stderr and never throwing (we branch on the text/label instead).
  const run = (cmd, a) => {
    try {
      return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };
  const tailLog = () => {
    console.log(logPath);
    console.log(existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n') : '(no log yet)');
  };

  if (process.platform === 'darwin') {
    if (sub === 'status') {
      const line = run('launchctl', ['list']).split('\n').find((l) => l.includes(label));
      console.log(line ? 'running (' + line.trim() + ')' : 'not installed — run: be10x service install');
      return;
    }
    if (sub === 'logs') return tailLog();
    if (sub === 'uninstall') {
      run('launchctl', ['unload', plistPath]);
      rmSync(plistPath, { force: true });
      console.log('✓ Stopped and removed the be10x background service.');
      return;
    }
    if (sub !== 'install') {
      console.error('Usage: be10x service <install|uninstall|status|logs>');
      process.exit(1);
    }
    if (isRemovablePath(cli)) {
      console.error('This be10x CLI lives on a removable path:\n  ' + cli);
      console.error("A boot service pointing here won't start until that drive is mounted. Install globally,");
      console.error('then run service install from it:  npm install -g github:notpritam/be10x && be10x service install');
      process.exit(1);
    }
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true });
    const path = serviceEnvPath(dirname(node), process.env.PATH || '');
    writeFileSync(plistPath, buildLaunchdPlist({ label, node, cli, home, logPath, path }));
    run('launchctl', ['unload', plistPath]); // reload cleanly if already installed
    const out = run('launchctl', ['load', '-w', plistPath]).trim();
    if (out) console.log(out);
    const running = run('launchctl', ['list']).split('\n').some((l) => l.includes(label));
    console.log(running ? '✓ be10x connect is running in the background — and starts on every login.' : 'Installed. Check: be10x service status');
    console.log('  logs:     be10x service logs');
    console.log('  stop it:  be10x service uninstall');
    return;
  }

  if (process.platform === 'linux') {
    const sc = (a) => run('systemctl', ['--user', ...a]);
    if (sub === 'status') {
      console.log(sc(['status', unit, '--no-pager']).trim() || 'not installed — run: be10x service install');
      return;
    }
    if (sub === 'logs') {
      console.log(run('journalctl', ['--user', '-u', unit, '-n', '40', '--no-pager']).trim() || '(no log yet)');
      return;
    }
    if (sub === 'uninstall') {
      sc(['disable', '--now', unit]);
      rmSync(systemdPath, { force: true });
      sc(['daemon-reload']);
      console.log('✓ Stopped and removed the be10x background service.');
      return;
    }
    if (sub !== 'install') {
      console.error('Usage: be10x service <install|uninstall|status|logs>');
      process.exit(1);
    }
    if (isRemovablePath(cli)) {
      console.error('This be10x CLI lives on a removable path (' + cli + ') — install globally, then run service install.');
      process.exit(1);
    }
    mkdirSync(dirname(systemdPath), { recursive: true });
    const path = serviceEnvPath(dirname(node), process.env.PATH || '');
    writeFileSync(systemdPath, buildSystemdUnit({ node, cli, path }));
    sc(['daemon-reload']);
    sc(['enable', '--now', unit]);
    run('loginctl', ['enable-linger', process.env.USER || '']); // survive logout / start at boot
    console.log('✓ be10x connect is running in the background — and starts on boot.');
    console.log('  logs:     be10x service logs');
    console.log('  stop it:  be10x service uninstall');
    return;
  }

  console.error('be10x service supports macOS and Linux. On Windows, add `be10x connect` to Task Scheduler at logon.');
  process.exit(1);
}

// Read the background connect service's live state → { running, pid }. macOS parses `launchctl list` (a
// numeric first column = the running pid; `-` = loaded but idle); Linux uses `systemctl --user is-active`
// plus MainPID. Best-effort: any missing service manager (or non-macOS/Linux) reads as not running.
async function readConnectService() {
  const { label, unit } = servicePaths();
  try {
    const { execFileSync } = await import('node:child_process');
    if (process.platform === 'darwin') {
      const line = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).split('\n').find((l) => l.includes(label));
      if (!line) return { running: false, pid: null };
      const pidTok = line.trim().split(/\s+/)[0];
      const pid = /^\d+$/.test(pidTok) ? Number(pidTok) : null;
      return { running: pid != null, pid };
    }
    if (process.platform === 'linux') {
      let running = false;
      try {
        execFileSync('systemctl', ['--user', 'is-active', unit], { stdio: 'ignore' });
        running = true;
      } catch {
        running = false;
      }
      let pid = null;
      try {
        const out = execFileSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
        if (/^\d+$/.test(out) && out !== '0') pid = Number(out);
      } catch {
        /* no MainPID available */
      }
      return { running, pid };
    }
  } catch {
    /* no service manager here */
  }
  return { running: false, pid: null };
}

// status — a legibility snapshot of `be10x connect`: whether you're signed in (and to which board), whether
// the background service is running, whether the board is reachable RIGHT NOW (+ how many projects it serves
// you), the last task this machine touched, and the tail of the structured log. The companion to the new
// per-poll/per-task connect logging — answers "is my agent working?" without tailing a log by hand.
async function cmdStatus() {
  const cfg = loadConnectConfig() || {};
  const base = cfg.board ? String(cfg.board).replace(/\/+$/, '') : null;

  // Live board probe: GET /api/agent/projects with the saved token (same Bearer pattern as makeBoardClient),
  // tightly timed out so an unreachable board reports an error instead of hanging the command.
  const probe = async () => {
    try {
      const res = await fetch(base + '/api/agent/projects', {
        headers: { Authorization: 'Bearer ' + cfg.token },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const json = await res.json().catch(() => ({}));
      return { ok: true, projectCount: Array.isArray(json.projects) ? json.projects.length : 0 };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  };

  const tailEvents = async () => {
    const { logPath } = servicePaths();
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-8);
  };

  const status = await assembleStatus({ config: cfg, probe, service: readConnectService, tailEvents });

  // --- pretty-print: a compact box summary, then the raw recent-activity tail below it (unboxed, so a long
  // log line doesn't blow out the box width).
  const lines = [bold('be10x status'), ''];
  if (!status.signedIn) {
    lines.push(sym.bad + ' not signed in');
    lines.push(dim('  sign in:  be10x login <board-url>'));
  } else {
    lines.push(sym.ok + ' signed in' + (cfg.user ? ' as ' + cfg.user : '') + dim('   ' + status.board));
    if (status.connectivity.ok) {
      const n = status.connectivity.projectCount;
      lines.push(sym.ok + ' board reachable' + dim('   ' + n + ' project' + (n === 1 ? '' : 's')));
    } else {
      lines.push(sym.bad + ' board unreachable' + dim('   ' + status.connectivity.error));
    }
  }
  if (status.service.running) {
    lines.push(sym.ok + ' service running' + dim('   pid ' + status.service.pid));
  } else {
    lines.push(sym.bad + ' service not running' + dim('   start it:  be10x service install'));
  }
  const lastTask = pickLastTask(status.lastEvents);
  if (lastTask) lines.push(fg(BRAND.slate, sym.bullet + ' last task ' + lastTask));
  process.stdout.write(box(lines) + '\n');

  if (status.lastEvents.length) {
    console.log('');
    console.log(dim('recent activity  ' + servicePaths().logPath));
    for (const ev of status.lastEvents) console.log('  ' + dim(ev));
  } else {
    console.log('');
    console.log(dim('no activity logged yet — run `be10x connect` (or `be10x service install`).'));
  }
}

// update — self-update the globally-installed CLI to the latest, then restart the background service (if any)
// so it runs the new binary. Running from source? Update with git in that repo instead.
// A one-line "a newer be10x is available" nudge, shown on any command when this machine is behind the
// board it's logged into. The board is the source of truth (GET /api/version). Cached for an hour so it
// costs a network call at most once per hour, and prints to STDERR so it never corrupts --json output.
// (The always-on `be10x service` also auto-updates itself; this is the notice for interactive use.)
async function maybeNotifyUpdate(cmd) {
  if (cmd === 'update' || cmd === 'serve') return;
  try {
    const saved = loadConnectConfig(connectConfigPath());
    if (!saved || !saved.board) return; // board host updates via `git pull`, not this notice
    const cachePath = join(dirname(connectConfigPath()), 'cli-update-check.json');
    let cache = {};
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
    const now = Date.now();
    let boardVersion = cache.boardVersion;
    if (!cache.checkedAt || now - cache.checkedAt > 3600_000 || cache.board !== saved.board) {
      boardVersion = await fetchBoardVersion(saved.board, { timeoutMs: 800 });
      try { writeFileSync(cachePath, JSON.stringify({ checkedAt: now, board: saved.board, boardVersion })); } catch { /* best-effort cache */ }
    }
    const local = readPkgVersion();
    // Only nudge when the board is STRICTLY newer than this CLI — never when we're already ahead (that
    // produced the confusing "v0.2.2 available — you have v0.2.4"). Semver-ish major.minor.patch compare.
    const newer = (a, b) => {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
      return false;
    };
    if (boardVersion && newer(boardVersion, local)) {
      console.error(
        fg(BRAND.teal, '▲ ') + 'be10x v' + boardVersion + ' available' +
        dim(' — you have v' + local + '. Run ') + bold('be10x update'),
      );
    }
  } catch { /* update check is best-effort — never block a command */ }
}

async function cmdUpdate() {
  const { execFileSync } = await import('node:child_process');
  const cli = fileURLToPath(import.meta.url);
  if (isRemovablePath(cli)) {
    console.error("You're running be10x from source (" + cli + '), not a global install.');
    console.error(dim('Update it with: git -C <that repo> pull'));
    process.exit(1);
  }
  console.log(fg(BRAND.teal, '↑ Updating be10x to the latest…'));
  try {
    execFileSync('npm', ['install', '-g', 'github:notpritam/be10x'], { stdio: 'inherit' });
  } catch (e) {
    console.error(sym.bad + ' Update failed: ' + (e?.message ?? e));
    console.error(dim('If the repo is private, make sure your active GitHub account has access.'));
    process.exit(1);
  }
  console.log(sym.ok + ' ' + fg(BRAND.good, 'be10x is up to date') + dim('  (v' + readPkgVersion() + ')'));
  // Restart the background service, if installed, so it picks up the new version immediately.
  try {
    const { label, unit } = servicePaths();
    if (process.platform === 'darwin') {
      const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });
      console.log(dim('  restarted the background service.'));
    } else if (process.platform === 'linux') {
      execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'ignore' });
      console.log(dim('  restarted the background service.'));
    }
  } catch {
    /* no service installed — nothing to restart */
  }
}

// list — print registered projects and, for the cwd's project, its tasks grouped by status.
async function cmdList() {
  const db = await openBoardDb();
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

// archive <id> [--force] [--email E] — soft-archive a task (status → 'archived', the row is KEPT so bug
// links & history survive) AND reclaim its git worktree(s) + branch from disk. Two modes, auto-detected like
// `link`: hosted (you ran `be10x login`) archives on the board over HTTP; local drives the self-host db
// directly. Disk GC always runs HERE (where the worktrees live), off the REAL paths recorded on the task's
// runs — never re-derived from the title. `<id>` accepts a uuid or the GFA-123 human id.
async function cmdArchive(args) {
  const ident = args._[0];
  if (!ident || ident === true) {
    console.error('Usage: be10x archive <task-id | GFA-123> [--force]');
    process.exit(1);
  }
  const saved = loadConnectConfig() || {};
  if (saved.board && saved.token) return cmdArchiveRemote(args, saved, ident);
  return cmdArchiveLocal(args, ident);
}

// Local (self-host) archive: the local db HAS runs.worktree_path (recorded by the in-process runner), so we
// can both soft-archive and GC the real paths. Guards against reclaiming a worktree out from under a live run.
async function cmdArchiveLocal(args, ident) {
  const db = await openBoardDb();
  const actor = resolveUserId(db, args.email);
  if (!actor) {
    console.error(SIGNUP_HINT);
    process.exit(1);
  }
  const id = resolveTaskId(db, ident);
  if (!id) {
    console.error('No such task: ' + ident + '   (pass a task id or its GFA-123 human id)');
    process.exit(1);
  }
  const before = getTask(db, id);
  const wasArchived = before.status === 'archived';

  // Don't yank a worktree out from under an in-flight run unless the user forces it.
  const latest = getLatestRunForTask(db, id);
  const runActive = latest && (latest.status === 'starting' || latest.status === 'running');
  const force = !!args.force;

  const { task, worktrees } = archiveTask(db, id, actor);

  console.log(
    wasArchived
      ? sym.ok + ' ' + task.humanId + ' ' + dim('was already archived.')
      : sym.ok + ' archived ' + bold(task.humanId) + '  ' + dim('(' + before.status + ' → archived)')
  );

  if (runActive && !force) {
    console.log('  ' + fg(BRAND.warn, 'a run is still active') + ' — skipped worktree cleanup.');
    console.log('  ' + dim('re-run with --force to reclaim its disk once the run is done.'));
    return;
  }

  const project = task.projectId ? getProject(db, task.projectId) : null;
  if (!worktrees.length) {
    console.log('  ' + dim('no worktrees to reclaim.'));
    return;
  }
  if (!project || !project.rootPath) {
    console.log('  ' + dim(worktrees.length + ' recorded worktree(s), but this task\'s repo path is not resolvable here — nothing removed.'));
    return;
  }
  const { removed, skipped } = await gcTaskWorktrees(project, worktrees);
  if (removed.length) {
    console.log('  reclaimed ' + bold(String(removed.length)) + ' worktree(s) + branch(es):');
    for (const w of removed) console.log('    ' + dim(w.path + (w.branch ? '  [' + w.branch + ']' : '')));
  } else {
    console.log('  ' + dim('no worktrees reclaimed (already gone).'));
  }
  const rootSkips = skipped.filter((s) => s.reason === 'repo-root');
  if (rootSkips.length) console.log('  ' + dim('left the repo root untouched (branch-isolation task).'));
}

// Hosted archive: soft-archive on the board over HTTP (Bearer). The board rarely holds this machine's local
// worktree paths, so disk on the machine that ran the task is reclaimed there (the connector settles it);
// still, if the board DID return any worktrees that live under a repo we serve, reclaim them here.
async function cmdArchiveRemote(args, saved, ident) {
  const client = makeBoardClient({ board: saved.board, token: saved.token });
  let result;
  try {
    result = await client.archive(ident);
  } catch (e) {
    console.error('Could not archive on ' + saved.board + ': ' + (e?.message ?? e));
    console.error('Your login may have expired — re-run:  be10x login ' + saved.board);
    process.exit(1);
  }
  const task = result.task || {};
  const worktrees = Array.isArray(result.worktrees) ? result.worktrees : [];
  console.log(sym.ok + ' archived ' + bold(task.humanId || String(ident)) + '  ' + dim('on ' + saved.board));

  let removed = 0;
  for (const repo of Array.isArray(saved.repos) ? saved.repos : []) {
    try {
      const { rootPath, defaultBranch } = detectProjectKey(repo.path);
      // gcTaskWorktrees fences to <rootPath>/.be10x/worktrees, so passing the full list is safe — anything
      // not under this repo is skipped.
      const gc = await gcTaskWorktrees({ rootPath, defaultBranch }, worktrees);
      removed += gc.removed.length;
    } catch {
      /* a repo path that no longer resolves is not fatal to archiving */
    }
  }
  if (removed) console.log('  reclaimed ' + removed + ' worktree(s) on this machine.');
  else console.log('  ' + dim('disk is reclaimed on the machine that ran it (be10x connect settles it).'));
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
  const db = await openBoardDb();
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

// --- opt-in telemetry -----------------------------------------------------------
// See docs/superpowers/specs/2026-07-03-cli-telemetry-consent-design.md. Off by default; a task
// run's title/content/plan is only ever sent once a human explicitly agrees.

// Real readline-backed prompt (the injectable half — promptForConsent — lives in telemetry.js so
// it's unit-testable without a terminal).
async function askLine(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Ask once, the first time any command (other than `telemetry` itself, so managing the setting
// doesn't require answering it first) runs with no decision on record yet. Non-interactive runs
// (CI, piped input) are left undecided rather than answered on their behalf — effectiveEnabled
// already treats "undecided" as off.
async function ensureTelemetryConsent(cmd) {
  if (cmd === 'telemetry') return;
  if (effectiveEnabled(process.env, loadTelemetryConfig()) !== undefined) return;
  const answer = await promptForConsent({ ask: askLine });
  if (answer === null) return; // non-interactive — stays undecided
  setTelemetryEnabled(answer);
  console.log(
    dim(
      answer
        ? '  Thanks — turn this off anytime with `be10x telemetry off`.'
        : '  Understood — turn this on anytime with `be10x telemetry on`.'
    )
  );
  console.log('');
}

// Wraps an executor's execute(task, runOpts) so every agent run — from `be10x work` (local) or
// `be10x connect` (remote) — records what it worked and the outcome, IF telemetry is on. A no-op
// wrapper (still calls through, records nothing) when it's off, so call sites never branch on it.
function withTaskTelemetry(execute) {
  return async (task, runOpts = {}) => {
    const enabled = effectiveEnabled(process.env, loadTelemetryConfig()) === true;
    const summary = await execute(task, runOpts);
    if (enabled) {
      recordEvent(
        'task_run',
        {
          taskId: task.id,
          humanId: task.humanId,
          title: task.title,
          content: task.content,
          plan: task.plan,
          mode: runOpts.mode,
          ok: summary?.ok !== false,
        },
        { enabled }
      );
    }
    return summary;
  };
}

// telemetry [status|on|off] — check or change the stored decision. Doesn't touch a GFA_TELEMETRY
// env override, which always wins for the current process regardless of what's stored.
async function cmdTelemetry(args) {
  const sub = args._[0] || 'status';
  if (sub === 'on' || sub === 'off') {
    const cfg = setTelemetryEnabled(sub === 'on');
    console.log(fg(BRAND.good, sym.ok + ' ') + 'Telemetry is ' + sub + '.');
    console.log(dim('  install id: ' + cfg.installId));
    return;
  }
  if (sub === 'status') {
    const cfg = loadTelemetryConfig();
    const enabled = effectiveEnabled(process.env, cfg);
    const forced = process.env.GFA_TELEMETRY !== undefined;
    if (enabled === undefined) console.log("Telemetry: not decided yet — you'll be asked next time you run a command.");
    else console.log('Telemetry: ' + (enabled ? 'on' : 'off') + (forced ? ' (forced by GFA_TELEMETRY env var)' : ''));
    if (cfg?.installId) console.log(dim('install id: ' + cfg.installId));
    console.log('');
    console.log(
      dim(
        'Sends CLI command usage always, and — only when on — task/plan content from `work`/`connect` runs, to help improve be10x.'
      )
    );
    return;
  }
  console.error('Usage: be10x telemetry [status|on|off]');
  process.exit(1);
}

// --- dispatch -----------------------------------------------------------------

// A hosted board this machine is logged into (via `be10x login`), or null when this IS the board host.
function remoteBoard() {
  const cfg = loadConnectConfig(connectConfigPath());
  return cfg && cfg.board && cfg.token ? cfg : null;
}
async function boardFetch(saved, path, init = {}) {
  const url = saved.board.replace(/\/$/, '') + path;
  const res = await fetch(url, { ...init, headers: { Authorization: 'Bearer ' + saved.token, ...(init.headers || {}) } });
  if (res.status === 401) { console.error('Your login expired — re-run:  be10x login ' + saved.board); process.exit(1); }
  return res;
}

// ps — the fleet view: what every agent session is doing right now (working/waiting/blocked/done/stalled).
// On a CONNECTOR (logged into a hosted board) it queries that board; on the board host it reads the local db.
async function cmdPs(args) {
  const saved = remoteBoard();
  if (saved) {
    const res = await boardFetch(saved, '/api/agent/ps');
    if (!res.ok) { console.error('Could not reach ' + saved.board + ' (HTTP ' + res.status + ').'); process.exit(1); }
    const { sessions } = await res.json();
    if (args.json) { console.log(JSON.stringify(sessions, null, 2)); return; }
    console.log(formatFleetTable(sessions));
    return;
  }
  const db = await openBoardDb();
  const viewerId = resolveUserId(db, args.email);
  if (!viewerId) { console.error(SIGNUP_HINT); process.exit(1); }
  const rows = assembleFleetStatus(db, { viewerId });
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(formatFleetTable(rows));
}

// resume <task> — continue the task's prior claude session (claude --resume) via a resume wake.
async function cmdResume(args) {
  const ident = args._[0];
  if (!ident) { console.error('Usage: be10x resume <task>'); process.exit(1); }
  const saved = remoteBoard();
  if (saved) {
    const res = await boardFetch(saved, '/api/agent/tasks/' + encodeURIComponent(ident) + '/resume', { method: 'POST' });
    if (res.status === 409) { console.error('No prior session to resume for ' + ident); process.exit(1); }
    if (!res.ok) { console.error('Could not resume on ' + saved.board + ' (HTTP ' + res.status + ').'); process.exit(1); }
    console.log(fg(BRAND.ok, sym.ok + ' ') + 'resume queued for ' + bold(ident) + dim(' on ' + saved.board));
    return;
  }
  const db = await openBoardDb();
  const taskId = resolveTaskId(db, ident);
  if (!taskId) { console.error('No such task: ' + ident); process.exit(1); }
  const sessionId = getLatestRunForTask(db, taskId)?.sessionId;
  if (!sessionId) { console.error('No prior session to resume for ' + ident); process.exit(1); }
  enqueueWake(db, taskId, 'resume');
  console.log(fg(BRAND.ok, sym.ok + ' ') + 'resume queued for ' + bold(ident) + dim(' (session ' + sessionId.slice(0, 8) + '…)'));
}

// start <task> — move a task to ready_to_work and wake the runner to begin a fresh session.
async function cmdStart(args) {
  const saved = remoteBoard();
  if (saved) { console.error('Connected to hosted board ' + saved.board + ' — start tasks from its web UI (drag to Ready to work), or run `be10x start` on the board host.'); process.exit(1); }
  const db = await openBoardDb();
  const actor = resolveUserId(db, args.email);
  const ident = args._[0];
  if (!ident) { console.error('Usage: be10x start <task>'); process.exit(1); }
  const taskId = resolveTaskId(db, ident);
  if (!taskId) { console.error('No such task: ' + ident); process.exit(1); }
  transition(db, taskId, 'ready_to_work', actor);
  enqueueWake(db, taskId, 'execute');
  console.log(fg(BRAND.ok, sym.ok + ' ') + 'started ' + bold(ident));
}

// new [title] [--project <key>] [--type general|code-issue] [--start] — create a task, resolving a project.
async function cmdNew(args) {
  const saved = remoteBoard();
  if (saved) { console.error('Connected to hosted board ' + saved.board + ' — create tasks from its web UI, or run `be10x new` on the board host.'); process.exit(1); }
  const db = await openBoardDb();
  const ownerId = resolveUserId(db, args.email);
  if (!ownerId) { console.error(SIGNUP_HINT); process.exit(1); }
  const title = (args.title && args.title !== true ? args.title : args._.join(' ')) || 'Untitled';
  const projectIdByKey = (key) => (key ? db.prepare('SELECT id FROM projects WHERE key = ?').get(key)?.id || null : null);
  let projectId = null;
  if (args.project && args.project !== true) {
    projectId = projectIdByKey(args.project);
    if (!projectId) { console.error('No such project: ' + args.project); process.exit(1); }
  } else {
    try { projectId = projectIdByKey(detectProjectKey(process.cwd()).key); } catch { /* not in a repo */ }
  }
  const type = args.type && args.type !== true ? args.type : 'general';
  const content = type === 'code-issue' ? { symptom: title } : { summary: title };
  const task = createTask(db, { type, scope: projectId ? 'project' : 'personal', title, ownerId, projectId, content });
  console.log(fg(BRAND.ok, sym.ok + ' ') + 'created ' + bold(task.humanId) + (projectId ? '' : dim(' (no project — link one to run it)')));
  if (args.start && projectId) { transition(db, task.id, 'ready_to_work', ownerId); enqueueWake(db, task.id, 'execute'); console.log(dim('  started.')); }
}

// Commands that run forever (their own server/poll loop). Every OTHER command is one-shot and the process
// exits as soon as it finishes — so nothing (a keep-alive socket, a stray timer) holds the terminal open.
const LONG_RUNNING = new Set(['serve', 'connect', 'work']);

const COMMANDS = {
  serve: cmdServe,
  ps: cmdPs,
  notify: cmdNotify,
  resume: cmdResume,
  start: cmdStart,
  new: cmdNew,
  login: cmdLogin,
  link: cmdLink,
  token: cmdToken,
  work: cmdWork,
  connect: cmdConnect,
  status: cmdStatus,
  service: cmdService,
  update: cmdUpdate,
  list: cmdList,
  archive: cmdArchive,
  adopt: cmdAdopt,
  'install-skill': cmdInstallSkill,
  telemetry: cmdTelemetry,
};

function usage() {
  console.log('be10x — git-for-agents CLI');
  console.log('Usage: node bin/be10x.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  serve [--port N]                 run the HTTP board');
  console.log('  login [board-url]                browser sign-in to a hosted board (saves a token, no paste)');
  console.log('  link  [--name X] [--email E]     register this repo + write Claude-Code MCP config');
  console.log('  token [--name X] [--email E]     mint a personal access token (shown once)');
  console.log('  work  [--interval S] [--once]    run the agent runner for this repo');
  console.log('  connect --board URL --token T    link THIS machine to a hosted board + run the agent locally');
  console.log('  status                           service health, board connectivity, and recent connect activity');
  console.log('  service install|uninstall|status|logs   run `be10x connect` as a background service (auto-starts on boot)');
  console.log('  list                             list projects and this repo\'s tasks by status');
  console.log('  archive <id|GFA-123> [--force]   soft-archive a task + delete its worktree(s)/branch from disk');
  console.log('  adopt --title T [--phase P] ...  move this session\'s work onto the board as a task');
  console.log('  install-skill                    install the /be10x-adopt skill into ~/.claude/skills');
  console.log('  telemetry [status|on|off]        check or change the opt-in telemetry setting');
  console.log('');
  console.log('  adopt options: --type code-issue|general  --project KEY  --phase ' + IMPORT_PHASES.join('|'));
  console.log('                 --summary S  --symptom S  --plan-file F  --research-file F');
  console.log('                 --artifacts-file F  --refs-file F  --handoff  --email E');
  console.log('');
  console.log('Env: GFA_DB_PATH (default ./gfa.db), GFA_EMAIL, GFA_TELEMETRY (0|1, overrides the stored choice)');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  await ensureTelemetryConsent(cmd);
  // Full, flat command reference (every command incl. advanced ones).
  if (cmd === 'commands' || (cmd === 'help' && argv.includes('--all'))) return usage();
  // Bare `be10x` (or help/menu) → the welcome + live status + curated menu.
  if (!cmd || cmd === 'help' || cmd === 'menu' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(renderWelcome(await gatherWelcomeState()) + '\n');
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log('be10x v' + readPkgVersion());
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(fg(BRAND.bad, 'Unknown command: ') + bold(cmd));
    console.error(dim('Run `be10x` for the menu, or `be10x commands` for the full list.'));
    process.exit(1);
  }

  // Show the "update available" nudge before running the command (best-effort, ~hourly-cached).
  await maybeNotifyUpdate(cmd);

  const telemetryCfg = loadTelemetryConfig();
  const telemetryOn = effectiveEnabled(process.env, telemetryCfg) === true;
  const startedAt = Date.now();
  let ok = true;
  try {
    await fn(parseArgs(argv.slice(1)));
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    // Note: a command that exits early via process.exit() (several do, on validation failures)
    // skips this finally — an accepted gap in best-effort telemetry, not worth restructuring
    // every command's error path to avoid.
    recordEvent('cli_command', { command: cmd, ok, durationMs: Date.now() - startedAt }, { enabled: telemetryOn });
    if (telemetryOn && telemetryCfg?.installId) {
      void flushQueue({ installId: telemetryCfg.installId, cliVersion: readPkgVersion() });
    }
  }

  // A one-shot command is done — exit cleanly so a lingering keep-alive socket (from a board fetch) or a
  // best-effort telemetry request can't hold the terminal open (you had to Ctrl-C). The long-running
  // commands (serve/connect/work) intentionally keep the process alive and are excluded.
  if (!LONG_RUNNING.has(cmd)) process.exit(0);
}

main().catch((e) => {
  console.error(fg(BRAND.bad, '✗ ') + String(process.env.BE10X_DEBUG ? e?.stack || e : e?.message || e));
  process.exit(1);
});
