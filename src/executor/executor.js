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
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeCommand, BE10X_SYSTEM_PROMPT, StreamAccumulator } from './claude-adapter.js';
import { ensureWorktree as realEnsureWorktree, worktreeBranch, collectGitMeta } from './worktree.js';
import { createRun, setRunSession, setRunModel, setRunPid, markRunning, finishRun, getLatestRunForTask } from './runs.js';
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
    const body =
      content.description || content.body || content.text || content.question || content.summary || content.symptom;
    if (typeof body === 'string') return body.trim();
  }
  return '';
}

// The per-turn instruction for each wake mode. The stable working agreement lives in the system prompt;
// this is the varying part (task, mode, and the delta that triggered the wake).
const MODE_DIRECTIVE = {
  plan:
    'PLAN MODE. Research the task and the codebase, then record a concrete plan by calling gfa_plan_task. Make the plan visual and easy to grasp — the plan value can be a rich HTML string the board renders safely in a sandbox (use it for diagrams, wireframes, tables, or flow visualizations), or markdown, or { steps: [...], diagram: "...", html: "..." }, or a { blocks: [...] } mix. Choose what best explains THIS task. If a decision needs the human, call gfa_request_input. When the plan is ready, call gfa_submit_plan to send it for review. Do NOT implement any change yet.',
  revise:
    'REVISE MODE. Your plan is under review. Address the feedback below by updating the plan via gfa_plan_task (rich HTML / markdown / structured — whatever conveys it best), then call gfa_submit_plan again. Do NOT implement yet.',
  input_answer:
    'CONTINUE. The human answered your question (below). Resume where you left off and keep the plan/progress current via the gfa_* tools.',
  execute:
    'EXECUTE MODE. Your plan was approved. First break the work into an ordered task list and report it via gfa_update_progress with todos: [{ text, status }] (status "pending" | "in_progress" | "done"); then keep it updated as you go — mark the step you start "in_progress" and finished steps "done" — so the human sees live progress. Implement it in this worktree, committing on this branch. When done, call gfa_submit_output with any artifacts and move the task to verifying.',
  pick_up_now:
    'The human asked you to pick this up now. Read the current plan, comments, and status, and take the most useful next step using the gfa_* tools.',
  follow_up: 'Continue this task from its saved state using the gfa_* tools.',
  chat:
    'CHAT MODE. This is a conversational task, not a build. Read the discussion below and reply to the human by calling gfa_reply with { taskId: <the task db id above>, message: "..." }. Be conversational and helpful; do NOT write a plan or implement anything. If the human asks you to create a task, call gfa_create_task and then tell them what you made. Reply once, then stop until they write again.',
};

// The prompt delivered on stdin: task identity (so the agent addresses the gfa_* tools correctly), the
// details, the mode directive, and any delta (unseen comments + the triggering context) for this wake.
export function buildPrompt(task, { mode = 'plan', comments = [], wakeContext = null } = {}) {
  const header = `You are working be10x task ${task.humanId} (task db id: ${task.id}). Use this exact id for every gfa_* tool call.\nTitle: ${task.title}`;
  const body = contentText(task.content);
  const bodyBlock = body ? `\n\nDetails:\n${body}` : '';
  const directive = MODE_DIRECTIVE[mode] || MODE_DIRECTIVE.plan;
  const commentBlock = comments.length
    ? '\n\nNew human comments to address:\n' + comments.map((c, i) => `${i + 1}. [${c.anchor}] ${c.body}`).join('\n')
    : '';
  const ctxBlock = wakeContext ? `\n\nContext for this wake:\n${JSON.stringify(wakeContext)}` : '';
  return `${header}${bodyBlock}\n\n${directive}${commentBlock}${ctxBlock}`;
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
    bin = process.env.GFA_CLAUDE_BIN || undefined,
    permissionMode = process.env.GFA_PERMISSION_MODE || 'bypassPermissions',
    spawn = realSpawn,
    ensureWorktree = realEnsureWorktree,
  } = opts;

  // A per-repo MCP config (written by `be10x link` at the repo root) wires the be10x gfa_* tools into the
  // spawned agent. When absent, the agent runs without board tools (degraded, but never crashes).
  const mcpConfigPath = join(project.rootPath, '.be10x', 'mcp.json');

  // A nested `claude` refuses to start if it inherits the parent's CLAUDECODE* markers — strip them.
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^CLAUDE_?CODE/i.test(k)) childEnv[k] = v;
  }

  return async function execute(task, runOpts = {}) {
    const mode = runOpts.mode || 'plan';
    const comments = runOpts.comments || [];
    const wakeContext = runOpts.wakeContext || null;
    // Fresh on a first plan; resume the prior session on every follow-up wake (override per run if needed).
    const wantResume = runOpts.resume !== undefined ? runOpts.resume : resume || mode !== 'plan';

    const branch = worktreeBranch(task.humanId, task.title);
    // Per-task isolation (set at create time): 'worktree' (default) cuts a fresh isolated checkout;
    // 'branch' works in the repo root itself, leaving branch management to the agent.
    const isolation = task.content?.isolation === 'branch' ? 'branch' : 'worktree';

    let wt;
    if (isolation === 'branch') {
      wt = { path: project.rootPath, branch, baseRef: project.defaultBranch, reused: true };
    } else {
      // A worktree failure is a hard setup error: record it and rethrow so the runner marks the task
      // blocked (no run row is opened for a task we can't stage).
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
    }

    // Resume the agent's saved session on a wake; a missing/lost id falls back to a fresh session seeded
    // from durable state (the plan + comments in the prompt) — the stateless-resumable principle.
    const resumeSessionId = wantResume ? getLatestRunForTask(db, task.id)?.sessionId || null : null;
    const useMcp = existsSync(mcpConfigPath);

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
      bin,
      permissionMode,
      mcpConfig: useMcp ? mcpConfigPath : undefined,
      strictMcp: useMcp,
    });

    recordProgress(
      db,
      task.id,
      {
        state: 'working',
        step: mode,
        message: `${resumeSessionId ? 'resuming' : 'starting'} agent (${mode}) in ${branch}`,
      },
      workerId
    );

    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: wt.path, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) setRunPid(db, run.id, child.pid);

      // Deliver the prompt on stdin, then close it so the CLI's print mode runs to completion.
      try {
        child.stdin.write(buildPrompt(task, { mode, comments, wakeContext }));
        child.stdin.end();
      } catch {
        // if stdin is already gone the child.error/close path handles it
      }

      const acc = new StreamAccumulator();
      let sessionPersisted = false;
      let modelPersisted = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      // Fold one complete stream-json line into state: persist the session id the first time it appears
      // (and flip the run to running), and surface each assistant message as a board progress note.
      // Every side-effect here is best-effort telemetry off a live stream handler — a DB hiccup (a
      // schema drift, a transient lock) must NEVER escape and kill the server+runner process, so the
      // whole body is guarded. The run still finalizes on `close` regardless.
      const consume = (line) => {
        try {
          const ev = acc.push(line);
          if (!ev) return;
          if (acc.sessionId && !sessionPersisted) {
            sessionPersisted = true;
            setRunSession(db, run.id, acc.sessionId);
            markRunning(db, run.id);
          }
          if (acc.model && !modelPersisted) {
            modelPersisted = true;
            setRunModel(db, run.id, acc.model);
          }
          if (ev.text) {
            recordProgress(db, task.id, { state: 'working', step: 'agent', message: truncate(ev.text) }, workerId);
          }
        } catch {
          // best-effort telemetry — never let a stream-side write crash the process
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
        // What the agent changed on its branch (commits + diff shortstat) — null on plan-only runs.
        const git = collectGitMeta(wt.path, wt.baseRef);
        const summary = {
          runId: run.id,
          sessionId: acc.sessionId,
          worktree: wt.path,
          branch,
          mode,
          done: acc.done,
          ...(git ? { git } : {}),
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
