// ABOUTME: The member-side executor — spawns the member's OWN claude in their LOCAL worktree and RESOLVES a
// ABOUTME: run summary for `be10x connect` to report to the hosted board. No local db (the board owns runs).
//
// This is the distributed sibling of src/executor/executor.js. It reuses the SAME primitives — the prompt
// (buildPrompt), the CLI command (buildClaudeCommand), the stream parser (StreamAccumulator), the worktree
// helpers, and the error derivation (deriveError) — but instead of writing run/progress rows to a local db
// it just returns a summary. The agent's own gfa_* tools carry all rich state to the board over HTTP (via
// the board-pointing mcp.json), and the connector reports this summary so the board applies durability.
import { spawn as realSpawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeCommand, BE10X_SYSTEM_PROMPT, StreamAccumulator, extractUsage } from '../executor/claude-adapter.js';
import { ensureWorktree as realEnsureWorktree, worktreeBranch, collectGitMeta } from '../executor/worktree.js';
import { buildPrompt, deriveError, FRESH_MODES } from '../executor/executor.js';
import { classifyFailure } from '../executor/failures.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// A nested `claude` refuses to start if it inherits the parent's CLAUDECODE* markers — strip them.
function strippedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^CLAUDE_?CODE/i.test(k)) env[k] = v;
  }
  return env;
}

// Write the be10x system prompt to a unique temp file for a fresh run; null on a resume (already cached).
function writeSystemPrompt(resume) {
  if (resume) return null;
  const path = join(tmpdir(), `be10x-sysprompt-${randomUUID()}.txt`);
  writeFileSync(path, BE10X_SYSTEM_PROMPT);
  return path;
}
function cleanup(path) {
  if (path) {
    try {
      unlinkSync(path);
    } catch {
      // a leaked temp file is harmless
    }
  }
}

// Build a remote `execute(task, runOpts)` for a member's connector. `repo` = { rootPath, defaultBranch };
// `mcpConfigPath` is the board-pointing .be10x/mcp.json the connector wrote (so the agent's gfa_* tools
// reach the board over HTTP). It stages the worktree LOCALLY, spawns the member's claude, scrapes the
// session id + done off the stream, and RESOLVES a summary (never throws) — child failures come back as
// { ok:false, failureKind } so the connector reports them and the board decides retry vs. surface.
// spawn/ensureWorktree are injected for tests. runOpts: { mode, comments, wakeContext, resume,
// resumeSessionId } (the last two come from the board's claim payload).
export function makeRemoteExecutor(repo, opts = {}) {
  const {
    model,
    effort = process.env.GFA_EFFORT || undefined,
    bin = process.env.GFA_CLAUDE_BIN || undefined,
    permissionMode = process.env.GFA_PERMISSION_MODE || 'bypassPermissions',
    mcpConfigPath = null,
    spawn = realSpawn,
    ensureWorktree = realEnsureWorktree,
  } = opts;

  return async function execute(task, runOpts = {}) {
    const mode = runOpts.mode || 'plan';
    const comments = runOpts.comments || [];
    const wakeContext = runOpts.wakeContext || null;
    // Same resume policy as the local executor: fresh for plan/execute/verify, resume otherwise — unless
    // the caller (a retry) forces it. The session id to resume comes from the board's claim payload.
    const wantResume = runOpts.resume !== undefined ? runOpts.resume : !FRESH_MODES.has(mode);
    const resumeSessionId = wantResume ? runOpts.resumeSessionId || null : null;

    const branch = worktreeBranch(task.humanId, task.title);
    const isolation = task.content?.isolation === 'branch' ? 'branch' : 'worktree';

    let wt;
    if (isolation === 'branch') {
      wt = { path: repo.rootPath, branch, baseRef: repo.defaultBranch, reused: true };
    } else {
      try {
        wt = await ensureWorktree(repo.rootPath, { branch, baseRef: repo.defaultBranch });
      } catch (e) {
        // Staging failure → a retryable crash-kind summary (the board decides retry/surface). No throw.
        return { ok: false, done: false, mode, branch, failureKind: 'crash', error: 'could not create worktree: ' + (e?.message ?? e) };
      }
    }

    const useMcp = !!mcpConfigPath && existsSync(mcpConfigPath);
    const runModel = task.content?.model || model;
    const rawEffort = task.content?.effort || effort;
    const runEffort = EFFORTS.has(rawEffort) ? rawEffort : undefined;
    const systemPromptPath = writeSystemPrompt(!!resumeSessionId);
    const { command, args } = buildClaudeCommand({
      worktree: wt.path,
      systemPromptPath,
      model: runModel,
      effort: runEffort,
      resumeSessionId,
      bin,
      permissionMode,
      mcpConfig: useMcp ? mcpConfigPath : undefined,
      strictMcp: useMcp,
    });
    const promptText = buildPrompt(task, { mode, comments, wakeContext });

    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: wt.path, env: strippedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const acc = new StreamAccumulator();
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const consume = (line) => {
        try {
          acc.push(line);
        } catch {
          // best-effort stream parse — never let a bad line crash the run
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          consume(stdoutBuf.slice(0, nl));
          stdoutBuf = stdoutBuf.slice(nl + 1);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });

      const finalize = (ok, extra = {}) => {
        if (settled) return;
        settled = true;
        cleanup(systemPromptPath);
        const git = collectGitMeta(wt.path, wt.baseRef);
        const summary = { sessionId: acc.sessionId, worktree: wt.path, branch, mode, done: acc.done, usage: extractUsage(acc.result), ...(git ? { git } : {}) };
        if (ok && acc.done) {
          summary.ok = true;
        } else {
          // Same real-error derivation + classification as the local executor, so the board's retry
          // decision (auth/network/crash retryable; other not) is identical on both paths.
          const error = deriveError(acc, stderrBuf, extra);
          summary.ok = false;
          summary.failureKind = classifyFailure(error);
          summary.error = error;
        }
        resolve(summary);
      };

      child.on('error', (e) => finalize(false, { error: 'spawn error: ' + (e?.message ?? e) }));
      child.on('close', (code) => {
        if (stdoutBuf.trim()) consume(stdoutBuf);
        stdoutBuf = '';
        finalize(code === 0, { exitCode: code });
      });

      // Deliver the prompt on stdin, then close it so the CLI's print mode runs to completion.
      try {
        child.stdin.write(promptText);
        child.stdin.end();
      } catch {
        // if stdin is already gone the error/close path handles it
      }
    });
  };
}
