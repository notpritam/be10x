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
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeCommand, BE10X_SYSTEM_PROMPT, StreamAccumulator, extractUsage } from './claude-adapter.js';
import { classifyFailure, guidance } from './failures.js';
import { ensureWorktree as realEnsureWorktree, worktreeBranch, collectGitMeta } from './worktree.js';
import { createRun, setRunSession, setRunModel, setRunPid, markRunning, finishRun, getLatestRunForTask } from './runs.js';
import { recordRunStep } from './run-steps.js';
import { recordProgress } from '../worker/worker.js';
import { hookEventToActivity, phaseFromMode } from './agent-status.js';
import { listBugsForTask, linkedBugSummary } from '../bugs/bugs.js';

const BOARD_MSG_MAX = 280;

// Valid reasoning-effort levels the CLI accepts (--effort). A per-task value outside this set is ignored.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Clamp agent text to a board-friendly length (progress messages, not transcripts).
function truncate(s, n = BOARD_MSG_MAX) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Pull the REAL reason a run failed out of the accumulator, instead of a generic "exited without a result".
// The CLI reports its actual error in the stream-json result payload and/or its last assistant line
// ("Not logged in · Please run /login", "API Error: Unable to connect…") — both of which the executor used
// to discard, leaving every failure looking identical in the DB. Order: explicit spawn error → result
// payload → last assistant text → stderr → exit code.
export function deriveError(acc, stderrBuf, extra) {
  if (extra.error) return String(extra.error);
  const r = acc.result;
  if (r && typeof r === 'object') {
    const parts = [];
    if (typeof r.subtype === 'string' && r.subtype && r.subtype !== 'success') parts.push(r.subtype);
    if (typeof r.error === 'string' && r.error.trim()) parts.push(r.error.trim());
    else if (r.error && typeof r.error === 'object' && typeof r.error.message === 'string') parts.push(r.error.message);
    if (r.is_error && typeof r.result === 'string' && r.result.trim()) parts.push(r.result.trim());
    if (parts.length) return parts.join(': ').slice(0, 800);
  }
  const tail = String(acc.text ?? '').trim();
  if (tail) return tail.slice(-500);
  const se = stderrBuf.slice(-500).trim();
  if (se) return se;
  if (extra.exitCode != null) return `agent exited (code ${extra.exitCode}) without a result`;
  return 'agent exited without a result';
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
  verify:
    'VERIFY MODE. The implementation is done and this is a FRESH session — you do NOT have the build transcript, only the approved plan below and the code in this worktree. Review the changes on this branch (run `git diff` and `git log` against the base) against the plan, and check each part was implemented correctly. Report your findings by calling gfa_update_progress with a todos list of verification checks — each { text, status } where status is "done" (verified) or "pending" (a gap/concern) — plus a short summary message. Do NOT change any code and do NOT move the task; the human does the final sign-off. If you find gaps, spell them out clearly via gfa_reply so the human can decide.',
};

// Modes that start a FRESH session (no --resume), seeded from durable state rather than the prior
// transcript: `plan` is a clean start; `execute` is a clean handoff from the APPROVED PLAN (the planning
// session is deliberately not carried over); `verify` is a clean read of the diff. Everything else
// (revise, input_answer, follow_up, chat) resumes the same session for tight, stateful iteration.
export const FRESH_MODES = new Set(['plan', 'execute', 'verify']);
// Fresh modes whose prompt must carry the approved plan (they don't inherit it from a resumed session).
const PLAN_MODES = new Set(['execute', 'verify']);

function planText(plan) {
  if (plan == null) return '';
  return typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2);
}

// A compact "Linked bugs" block for the prompt: which extension-filed QA bugs this task must fix, and the
// pointer to inspect each one's full capture. Reads the compact linkedBugSummary shape (errorCount top-level)
// but tolerates a full hydrated bug (errorCount in meta) too. Empty/absent → '' (no block).
function linkedBugsBlock(bugs) {
  if (!Array.isArray(bugs) || bugs.length === 0) return '';
  const lines = bugs.map((b) => {
    const ec = b.errorCount ?? b.meta?.errorCount ?? 0;
    const errs = ec ? ` [${ec} console error${ec === 1 ? '' : 's'}]` : '';
    return `- ${b.humanId} "${b.title}"${errs}`;
  });
  return (
    '\n\nLinked bugs — this task fixes these filed QA bug(s). Inspect each capture (rrweb replay, console, ' +
    'network, DOM, picked elements) with the be10x-bugs MCP tools (bug_get / bug_console / bug_network / ' +
    'bug_picked_elements):\n' + lines.join('\n')
  );
}

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
  const planBlock =
    PLAN_MODES.has(mode) && task.plan != null
      ? `\n\nApproved plan (build/verify against THIS — the planning session is not carried over):\n${planText(task.plan)}`
      : '';
  const bugsBlock = linkedBugsBlock(task.linkedBugs);
  return `${header}${bodyBlock}${bugsBlock}${planBlock}\n\n${directive}${commentBlock}${ctxBlock}`;
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
    effort = process.env.GFA_EFFORT || undefined,
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
    const phase = phaseFromMode(mode); // user-facing phase for the live status snapshot
    const comments = runOpts.comments || [];
    const wakeContext = runOpts.wakeContext || null;
    // Context policy: fresh session for plan/execute/verify (clean start / clean handoff from the plan /
    // clean read of the diff), resume for revise/input_answer/follow_up/chat. Override per run if needed.
    const wantResume = runOpts.resume !== undefined ? runOpts.resume : resume || !FRESH_MODES.has(mode);

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
      host: hostname(), // the machine this agent actually runs on — surfaced in ps / the board
    });

    // Per-task overrides win over the executor default: the human can set a model/effort on the task
    // (task.content.model / .effort) and it applies from the next run. An invalid effort is ignored.
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

    // Monotonic trace sequence for this run (prompt=0, then each tool call, then the result). Shared by
    // the stdin write below and the stream consumer's closure.
    let stepSeq = 0;
    // Surface linked bugs in the prompt. The hosted claim payload already stages them on the task; on the
    // in-process path the staged task has none, so source them from the db here (best-effort — never block
    // a run on a bug lookup). `=== undefined` so an explicit [] isn't re-queried.
    let taskForPrompt = task;
    if (task.linkedBugs === undefined) {
      let linkedBugs = [];
      try {
        linkedBugs = listBugsForTask(db, task.id).map(linkedBugSummary);
      } catch {
        linkedBugs = [];
      }
      taskForPrompt = { ...task, linkedBugs };
    }
    const promptText = buildPrompt(taskForPrompt, { mode, comments, wakeContext });
    // The exact context we handed down — the full prompt, the resolved command + args, and whether this
    // was a resume. Recorded verbatim so the debug view can show "what we passed the agent" in depth.
    try {
      recordRunStep(db, {
        runId: run.id,
        taskId: task.id,
        seq: stepSeq++,
        kind: 'prompt',
        detail: { mode, resumed: !!resumeSessionId, sessionId: resumeSessionId, command, args, prompt: promptText },
      });
    } catch {
      // best-effort trace — never block the run on a trace write
    }

    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: wt.path, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) setRunPid(db, run.id, child.pid);

      // Deliver the prompt on stdin, then close it so the CLI's print mode runs to completion.
      try {
        child.stdin.write(promptText);
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
          // Hook lifecycle events (SessionStart/PreToolUse/Notification/Stop/…) drive the live state
          // machine: working (heartbeat), waiting (needs a human), blocked (denied/errored tool).
          if (ev.hookEvent) {
            const activity = hookEventToActivity(ev.hookEvent, ev.outcome);
            if (activity) recordProgress(db, task.id, { state: activity, phase, step: 'agent' }, workerId);
          }
          if (ev.text) {
            recordProgress(db, task.id, { state: 'working', phase, step: 'agent', message: truncate(ev.text) }, workerId);
          }
          // The commands the agent ran, in order: each tool_use (Bash, Edit, gfa_*, …) with its input.
          if (ev.toolUses && ev.toolUses.length) {
            for (const t of ev.toolUses) {
              recordRunStep(db, { runId: run.id, taskId: task.id, seq: stepSeq++, kind: 'tool', tool: t.name, detail: { input: t.input } });
            }
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
        // Bookend the trace with the outcome (best-effort).
        try {
          recordRunStep(db, {
            runId: run.id,
            taskId: task.id,
            seq: stepSeq++,
            kind: 'result',
            detail: { done: acc.done, ok, ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}), ...(extra.error ? { error: extra.error } : {}) },
          });
        } catch {
          // best-effort trace
        }
        const usage = extractUsage(acc.result);
        if (ok && acc.done) {
          summary.ok = true;
          finishRun(db, run.id, { status: 'done', result: summary, usage });
          recordProgress(
            db,
            task.id,
            { state: 'done', step: 'done', message: truncate(acc.text) || 'agent finished' },
            workerId
          );
        } else {
          // Capture the REAL reason (not the generic string) and classify it so the runner can decide to
          // auto-retry an environmental failure (auth/network/crash) vs. surface a genuine error.
          const error = deriveError(acc, stderrBuf, extra);
          const failureKind = classifyFailure(error);
          summary.ok = false;
          summary.failureKind = failureKind;
          summary.error = error;
          finishRun(db, run.id, { status: 'failed', result: summary, error, usage });
          const g = guidance(failureKind);
          const message = g ? `${truncate(error, 180)} — ${g}` : truncate(error);
          recordProgress(
            db,
            task.id,
            { state: 'blocked', step: failureKind === 'auth' ? 'auth' : 'failed', message: truncate(message) },
            workerId
          );
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
