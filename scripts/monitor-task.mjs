#!/usr/bin/env node
// ABOUTME: Read-only be10x task monitor for cron: snapshots task/run/wake/process/git state.
// ABOUTME: Appends JSONL heartbeats and writes a compact latest summary without touching agent work.
import { execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '../src/db/db.js';

function arg(name, fallback = null) {
  const flag = '--' + name;
  const index = process.argv.indexOf(flag);
  if (index === -1) return process.env['GFA_MONITOR_' + name.toUpperCase().replaceAll('-', '_')] ?? fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function run(command, args, opts = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (error) {
    return String(error?.stderr || error?.message || error).trim();
  }
}

function gitStatus(worktreePath) {
  if (!worktreePath) return null;
  const status = run('git', ['-C', worktreePath, 'status', '--short', '--branch']);
  const diffStat = run('git', ['-C', worktreePath, 'diff', '--stat']);
  return { status, diffStat };
}

function matchingProcesses(worktreePath) {
  if (!worktreePath) return [];
  const output = run('ps', ['-axo', 'pid,ppid,command']);
  const matches = output
    .split('\n')
    .filter((line) => line.includes(worktreePath) && line.includes('claude'))
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    agent: matches.filter(
      (line) =>
        line.includes(' --add-dir ' + worktreePath) &&
        (line.includes('/claude ') || line.includes('@anthropic-ai/claude-code'))
    ),
    toolChildren: matches.filter((line) => !line.includes(' --add-dir ' + worktreePath)),
    all: matches,
  };
}

function ageMs(now, value) {
  return typeof value === 'number' ? now - value : null;
}

const dbPath = resolve(arg('db', process.env.GFA_DB_PATH || join(homedir(), 'be10x-demo.db')));
const taskKey = arg('task', 'GFA-003');
const outDir = resolve(arg('out-dir', join(homedir(), '.be10x', 'monitor')));
const now = Date.now();

mkdirSync(outDir, { recursive: true });
const db = openDb(dbPath);

const task = db
  .prepare('SELECT * FROM tasks WHERE human_id = ? OR id = ? ORDER BY rowid DESC LIMIT 1')
  .get(taskKey, taskKey);

if (!task) {
  const missing = { ts: new Date(now).toISOString(), dbPath, taskKey, ok: false, error: 'task-not-found' };
  appendFileSync(join(outDir, taskKey + '.jsonl'), JSON.stringify(missing) + '\n');
  writeFileSync(join(outDir, taskKey + '.latest.json'), JSON.stringify(missing, null, 2) + '\n');
  process.exitCode = 2;
} else {
  const latestRun = db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(task.id);
  const pendingWakes = db
    .prepare('SELECT id, reason, context_json, enqueued_at FROM wake_queue WHERE task_id = ? AND claimed_at IS NULL ORDER BY enqueued_at, rowid')
    .all(task.id);
  const latestEvents = db
    .prepare('SELECT actor, kind, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 8')
    .all(task.id)
    .map((event) => ({ ...event, payload: safeJson(event.payload_json, event.payload_json), payload_json: undefined }));
  const openInputs = db.prepare("SELECT id, question, created_at FROM input_requests WHERE task_id = ? AND status = 'open'").all(task.id);

  const agent = safeJson(task.agent_json, {});
  const refs = safeJson(task.refs_json, null);
  const result = safeJson(latestRun?.result_json, null);
  const worktreePath = latestRun?.worktree_path || result?.worktree || null;
  const alive = pidAlive(latestRun?.pid);
  const processMatches = matchingProcesses(worktreePath);
  const promptStep = latestRun
    ? db.prepare("SELECT detail_json FROM run_steps WHERE run_id = ? AND kind = 'prompt' ORDER BY seq, rowid LIMIT 1").get(latestRun.id)
    : null;
  const promptDetail = safeJson(promptStep?.detail_json, {});
  const warnings = [];

  const latestProgressAt = latestEvents.find((event) => event.kind === 'progress')?.created_at ?? agent.updatedAt ?? null;
  const progressAgeMs = ageMs(now, latestProgressAt);
  const oldestWakeAgeMs = pendingWakes.length ? ageMs(now, pendingWakes[0].enqueued_at) : null;
  if (latestRun?.status === 'running' && !alive) warnings.push('latest-run-marked-running-but-pid-not-alive');
  if (latestRun?.status === 'running' && progressAgeMs != null && progressAgeMs > 10 * 60 * 1000) warnings.push('no-progress-for-10m');
  if (oldestWakeAgeMs != null && oldestWakeAgeMs > 10 * 60 * 1000) warnings.push('pending-wake-older-than-10m');
  if (processMatches.agent.length > 1) warnings.push('multiple-agent-sessions-touching-worktree');
  if (task.status === 'verifying' && agent.state === 'working') warnings.push('status-verifying-while-agent-still-working');

  const snapshot = {
    ts: new Date(now).toISOString(),
    dbPath,
    task: {
      id: task.id,
      humanId: task.human_id,
      title: task.title,
      status: task.status,
      updatedAt: task.updated_at,
      updatedAgeMs: ageMs(now, task.updated_at),
      agent,
      refs,
    },
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          mode: result?.mode ?? promptDetail?.mode ?? null,
          resumed: promptDetail?.resumed ?? null,
          resumeSessionId: promptDetail?.sessionId ?? null,
          sessionId: latestRun.session_id,
          model: latestRun.model,
          pid: latestRun.pid,
          pidAlive: alive,
          worktreePath,
          branch: latestRun.branch,
          baseRef: latestRun.base_ref,
          createdAt: latestRun.created_at,
          startedAt: latestRun.started_at,
          endedAt: latestRun.ended_at,
          error: latestRun.error,
        }
      : null,
    pendingWakes: pendingWakes.map((wake) => ({
      id: wake.id,
      reason: wake.reason,
      context: safeJson(wake.context_json, wake.context_json),
      enqueuedAt: wake.enqueued_at,
      ageMs: ageMs(now, wake.enqueued_at),
    })),
    openInputs,
    processMatches: processMatches.all,
    agentProcesses: processMatches.agent,
    toolChildProcesses: processMatches.toolChildren,
    git: gitStatus(worktreePath),
    latestEvents,
    warnings,
    ok: warnings.length === 0,
  };

  appendFileSync(join(outDir, task.human_id + '.jsonl'), JSON.stringify(snapshot) + '\n');
  writeFileSync(join(outDir, task.human_id + '.latest.json'), JSON.stringify(snapshot, null, 2) + '\n');

  const summary = [
    `${snapshot.ts} ${task.human_id} ${task.status}`,
    `run=${snapshot.latestRun?.status ?? 'none'} mode=${snapshot.latestRun?.mode ?? 'unknown'} pid=${snapshot.latestRun?.pid ?? 'none'} alive=${snapshot.latestRun?.pidAlive ?? false}`,
    `session=${snapshot.latestRun?.sessionId ?? 'none'}`,
    `step=${agent.step ?? ''}`,
    `message=${agent.message ?? ''}`,
    `pendingWakes=${snapshot.pendingWakes.length}`,
    `warnings=${warnings.length ? warnings.join(',') : 'none'}`,
    `log=${join(outDir, task.human_id + '.jsonl')}`,
  ].join('\n');
  writeFileSync(join(outDir, task.human_id + '.latest.txt'), summary + '\n');
  console.log(summary);
  if (warnings.length) process.exitCode = 1;
}
