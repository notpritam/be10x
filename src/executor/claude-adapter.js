// ABOUTME: Pure Claude Code CLI adapter for be10x — builds the npx command/args and parses the
// ABOUTME: agent's stream-json output. No process spawning (that lives in a separate runner).

// Pinned Claude Code CLI version for the npx fallback. Kept as a const so bumping it is a one-line
// change. (Set GFA_CLAUDE_BIN to a locally-installed `claude` to skip npx entirely.)
export const CLAUDE_VERSION = '2.1.197';

// The be10x working agreement, delivered to the CLI via --append-system-prompt-file (the runner
// writes this to a temp file and passes the path to buildClaudeCommand). A few sentences, on
// purpose: it encodes the flow, not a manual.
export const BE10X_SYSTEM_PROMPT = [
  'You are a be10x agent working a single task on a shared board, in an isolated git worktree.',
  'You have be10x MCP tools (prefixed gfa_). Always operate on the task db id given in your prompt, and keep the board authoritative: record your plan with gfa_plan_task, stream progress with gfa_update_progress, ask scoped questions with gfa_request_input, and submit your plan for review with gfa_submit_plan.',
  'Plan first: in plan/revise mode, research and record a concrete plan (steps plus a small diagram) and do NOT implement any change until the plan has been approved and you are told to execute.',
  'When a requirement is unclear, ask ONE scoped question via gfa_request_input with concrete options to choose from rather than guessing.',
  'Make your output visual: the plan you pass to gfa_plan_task may be rich HTML written directly — the board renders it safely in a sandbox, so use it for diagrams, wireframes, tables, mock-ups, or flow visualizations — or markdown, or a structured { steps, diagram } / { blocks: [...] } mix. Choose the richest format the task warrants and favour showing over long walls of prose.',
  'On review feedback, revise the existing plan to address it instead of starting over.',
  'In execute mode, implement the approved plan in the worktree, commit on the task branch, then record output with gfa_submit_output.',
].join(' ');

// Build the `npx @anthropic-ai/claude-code` invocation. Pure: it only assembles command + args.
// The prompt text itself is delivered on stdin by the runner, not here.
//   - model              → `--model <model>` when set
//   - resumeSessionId    → `--resume <id>` (a resumed session already has the system prompt cached,
//                          so we must NOT also pass --append-system-prompt-file)
//   - systemPromptPath   → `--append-system-prompt-file <path>` only on a fresh (non-resumed) run
//   - worktree           → `--add-dir <worktree>` when set
//   - bin                → run this executable directly (a locally-installed `claude`, or a test stub)
//                          instead of downloading via npx; the npx package prefix is dropped, flags stay
//   - permissionMode     → `--permission-mode <mode>` (default 'bypassPermissions'): a headless agent
//                          cannot answer interactive tool prompts, so it must run in a non-asking mode.
//                          The per-task worktree is the safety boundary; pass '' to omit the flag.
//   - mcpConfig          → `--mcp-config <path>` wiring the be10x MCP server (the gfa_* tools) into the
//                          agent; `strictMcp` adds `--strict-mcp-config` so only ours loads
export function buildClaudeCommand({
  worktree,
  systemPromptPath,
  model,
  effort,
  resumeSessionId,
  bin,
  permissionMode = 'bypassPermissions',
  mcpConfig,
  strictMcp = false,
} = {}) {
  const command = bin || 'npx';
  const args = bin ? [] : ['-y', '@anthropic-ai/claude-code@' + CLAUDE_VERSION];
  args.push('-p', '--verbose', '--output-format', 'stream-json');

  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }

  if (mcpConfig) {
    args.push('--mcp-config', mcpConfig);
    if (strictMcp) args.push('--strict-mcp-config');
  }

  if (model) {
    args.push('--model', model);
  }

  // Reasoning effort for this session (low|medium|high|xhigh|max). The caller validates the value.
  if (effort) {
    args.push('--effort', effort);
  }

  // Resume and fresh-system-prompt are mutually exclusive: on a resume the instructions are already
  // in the session cache, and the CLI may reject the combination outright.
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  } else if (systemPromptPath) {
    args.push('--append-system-prompt-file', systemPromptPath);
  }

  if (worktree) {
    args.push('--add-dir', worktree);
  }

  return { command, args };
}

// Defensively locate a session id anywhere in a parsed event. The real CLI puts `session_id` at the
// top level of most messages, but we also accept the `sessionId` alias and a shallow nested search
// so a shape change never loses the id.
function findSessionId(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return null;
  if (typeof value.session_id === 'string') return value.session_id;
  if (typeof value.sessionId === 'string') return value.sessionId;
  for (const key of Object.keys(value)) {
    const found = findSessionId(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// The model the agent is running on: top-level `model` on the init line, else the assistant message's.
function findModel(obj) {
  if (typeof obj.model === 'string') return obj.model;
  if (obj.message && typeof obj.message === 'object' && typeof obj.message.model === 'string') return obj.message.model;
  return null;
}

// The message uuid is the id used for resume/truncation; fall back to the inner Anthropic message id.
function findMessageId(obj) {
  if (typeof obj.uuid === 'string') return obj.uuid;
  if (obj.message && typeof obj.message === 'object' && typeof obj.message.id === 'string') {
    return obj.message.id;
  }
  return null;
}

// Concatenate the text of an assistant message. `message.content` is normally an array of content
// items ({type:'text', text}); tolerate a plain-string content too. Non-assistant lines yield ''.
function extractAssistantText(obj) {
  if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') return '';
  const content = obj.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const item of content) {
    if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      text += item.text;
    }
  }
  return text;
}

// Pull the tool calls out of an assistant message: each `{type:'tool_use', name, input}` content item
// becomes `{ name, input }`. This is the "what commands did the agent run" signal — Bash commands, file
// edits, gfa_* board calls. Non-assistant / text-only messages yield []. Tolerant of shape drift.
function extractToolUses(obj) {
  if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') return [];
  const content = obj.message.content;
  if (!Array.isArray(content)) return [];
  const uses = [];
  for (const item of content) {
    if (item && typeof item === 'object' && item.type === 'tool_use' && typeof item.name === 'string') {
      uses.push({ name: item.name, input: item.input ?? null });
    }
  }
  return uses;
}

// Parse one line of Claude `stream-json`. Returns null for blank / non-JSON / non-object lines.
// Otherwise a normalized event: { raw, type, sessionId, messageId, text, toolUses, result, isResult }.
// Tolerant by design — any object surfaces its session id and its result-ness regardless of shape.
export function parseStreamLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // stream-json events are always JSON objects — ignore primitives and arrays.
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const type = typeof obj.type === 'string' ? obj.type : null;
  const isResult = type === 'result';

  return {
    raw: obj,
    type,
    sessionId: findSessionId(obj),
    model: findModel(obj),
    messageId: findMessageId(obj),
    text: extractAssistantText(obj),
    toolUses: extractToolUses(obj),
    result: isResult ? obj : null,
    isResult,
  };
}

// Stateful reducer over a stream-json line stream. Feed lines via push(); read accumulated state via
// the getters. `sessionId` is the first one seen, `text` is all assistant text concatenated, and
// `done`/`result` flip once the terminal `type:'result'` line arrives.
export class StreamAccumulator {
  #sessionId = null;
  #model = null;
  #done = false;
  #result = null;
  #text = '';

  // Parse `line`, fold it into state, and return the parsed event (or null for a skipped line).
  push(line) {
    const event = parseStreamLine(line);
    if (!event) return null;

    if (event.sessionId && this.#sessionId === null) {
      this.#sessionId = event.sessionId;
    }
    if (event.model && this.#model === null) {
      this.#model = event.model;
    }
    if (event.text) {
      this.#text += event.text;
    }
    if (event.isResult) {
      this.#done = true;
      this.#result = event.result;
    }
    return event;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get model() {
    return this.#model;
  }

  get done() {
    return this.#done;
  }

  get result() {
    return this.#result;
  }

  get text() {
    return this.#text;
  }
}
