// ABOUTME: The Claude executor — spawns an ephemeral `claude-code` session in the task's own git
// ABOUTME: worktree, streams its stream-json onto the board, and persists the session id for resume.
//
// This is the piece that makes an agent actually pick up a task. It is deliberately a be10x-native
// superset of paperclip's claude-local execute.ts and vibe-kanban's claude.rs: same mechanics (spawn
// the CLI, feed the prompt on stdin, scrape session_id off stream-json, run in a per-task worktree),
// wired to OUR lifecycle (runs table + recordProgress) instead of their control planes. `spawn` and
// `ensureWorktree` are injected (defaulting to the real implementations) so the stream/persistence
// logic is unit-testable without a real git repo or the CLI on PATH.
import { spawn as realSpawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeCommand, BE10X_SYSTEM_PROMPT, StreamAccumulator } from './claude-adapter.js';
import { ensureWorktree as realEnsureWorktree, worktreeBranch } from './worktree.js';
import { createRun, setRunSession, setRunPid, markRunning, finishRun, getLatestRunForTask } from './runs.js';
import { recordProgress } from '../worker/worker.js';

const BOARD_MSG_MAX = 280;

// Clamp agent text to a board-friendly length (progress messages, not transcripts).
function truncate(s, n = BOARD_MSG_MAX) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Pull a human-readable body out of a task's content, whatever shape it is. Empty/object-only content
// yields '' so we never dump `{}` into the prompt.
function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (content && typeof content === 'object') {
    const body = content.description || content.body || content.text;
    if (typeof body === 'string') return body.trim();
  }
  return '';
}

// The prompt delivered on stdin. A fresh run gets the full task; a resume just re-orients the agent
// (its plan + history are already in the resumed session, and new comments live on the board it reads).
export function buildPrompt(task, { resume = false } = {}) {
  if (resume) {
    return `Continue task ${task.humanId}. Read any new comments, review feedback, or answered input requests on the board and revise your plan to address them before proceeding.`;
  }
  const body = contentText(task.content);
  return (
    `Task ${task.humanId}: ${task.title}\n\n` +
    (body ? body + '\n\n' : '') +
    'Follow the be10x working agreement: produce a plan first and wait for approval before implementing.'
  );
}

// Write the be10x system prompt to a unique temp file for a fresh run; returns its path (or null on a
// resume, where the instructions are already in the session cache).
function writeSystemPrompt(resume) {
  if (resume) return null;
  const path = join(tmpdir(), `be10x-sysprompt-${randomUUID()}.txt`);
  writeFileSync(path, BE10X_SYSTEM_PROMPT);
  return path;
}

function cleanup(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // best effort — a leaked temp file is harmless
  }
}

// Build an `execute(task)` function for the runner. It runs one Claude session to completion and
// resolves with a summary; child-level failures are recorded (run → failed, board → blocked) and
// resolved, not thrown, so a single bad task never kills the loop.
export function makeClaudeExecutor(db, project, opts = {}) {
  const {
    model,
    workerId = 'runner',
    resume = false,
    spawn = realSpawn,
    ensureWorktree = realEnsureWorktree,
  } = opts;

  return async function execute(task) {
    const branch = worktreeBranch(task.humanId, task.title);

    // Isolate the task in its own worktree. A worktree failure is a hard setup error: record it and
    // rethrow so the runner marks the task blocked (no run row is opened for a task we can't stage).
    let wt;
    try {
      wt = await ensureWorktree(project.rootPath, { branch, baseRef: project.defaultBranch });
    } catch (e) {
      recordProgress(
        db,
        task.id,
        { state: 'blocked', step: 'worktree', message: 'could not create worktree: ' + (e?.message ?? e) },
        workerId
      );
      throw e;
    }

    // Resume the prior session for this task when asked (Slice-2 wake path); Slice 1 always runs fresh.
    const prior = resume ? getLatestRunForTask(db, task.id) : null;
    const resumeSessionId = prior?.sessionId || null;

    const run = createRun(db, {
      taskId: task.id,
      projectId: project.id,
      worktreePath: wt.path,
      branch,
      baseRef: wt.baseRef,
    });

    const systemPromptPath = writeSystemPrompt(!!resumeSessionId);
    const { command, args } = buildClaudeCommand({
      worktree: wt.path,
      systemPromptPath,
      model,
      resumeSessionId,
    });

    recordProgress(
      db,
      task.id,
      {
        state: 'working',
        step: 'spawning',
        message: `${resumeSessionId ? 'resuming' : 'starting'} agent in ${branch}`,
      },
      workerId
    );

    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: wt.path, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) setRunPid(db, run.id, child.pid);

      // Deliver the prompt on stdin, then close it so the CLI's print mode runs to completion.
      try {
        child.stdin.write(buildPrompt(task, { resume: !!resumeSessionId }));
        child.stdin.end();
      } catch {
        // if stdin is already gone the child.error/close path handles it
      }

      const acc = new StreamAccumulator();
      let sessionPersisted = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      // Fold one complete stream-json line into state: persist the session id the first time it appears
      // (and flip the run to running), and surface each assistant message as a board progress note.
      const consume = (line) => {
        const ev = acc.push(line);
        if (!ev) return;
        if (acc.sessionId && !sessionPersisted) {
          sessionPersisted = true;
          setRunSession(db, run.id, acc.sessionId);
          markRunning(db, run.id);
        }
        if (ev.text) {
          recordProgress(db, task.id, { state: 'working', step: 'agent', message: truncate(ev.text) }, workerId);
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          consume(line);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });

      const finalize = (ok, extra = {}) => {
        if (settled) return;
        settled = true;
        cleanup(systemPromptPath);
        const summary = {
          runId: run.id,
          sessionId: acc.sessionId,
          worktree: wt.path,
          branch,
          done: acc.done,
          ...extra,
        };
        if (ok && acc.done) {
          finishRun(db, run.id, { status: 'done', result: summary });
          recordProgress(
            db,
            task.id,
            { state: 'done', step: 'done', message: truncate(acc.text) || 'agent finished' },
            workerId
          );
        } else {
          const error = extra.error || stderrBuf.slice(-500).trim() || 'agent exited without a result';
          finishRun(db, run.id, { status: 'failed', result: summary, error });
          recordProgress(db, task.id, { state: 'blocked', step: 'failed', message: truncate(error) }, workerId);
        }
        resolve(summary);
      };

      child.on('error', (e) => finalize(false, { error: 'spawn error: ' + (e?.message ?? e) }));
      child.on('close', (code) => {
        // Flush a trailing line with no newline (the terminal result often arrives this way).
        if (stdoutBuf.trim()) consume(stdoutBuf);
        stdoutBuf = '';
        finalize(code === 0, { exitCode: code });
      });
    });
  };
}
