// ABOUTME: Pure Claude Code CLI adapter for be10x — builds the npx command/args and parses the
// ABOUTME: agent's stream-json output. No process spawning (that lives in a separate runner).

// Pinned Claude Code CLI version. Kept as a const so bumping it is a one-line change.
export const CLAUDE_VERSION = '2.1.119';

// The be10x working agreement, delivered to the CLI via --append-system-prompt-file (the runner
// writes this to a temp file and passes the path to buildClaudeCommand). A few sentences, on
// purpose: it encodes the flow, not a manual.
export const BE10X_SYSTEM_PROMPT = [
  'You are a be10x agent working a task on a shared board.',
  'Plan first: propose a plan and do NOT implement any change until the plan has been explicitly approved.',
  'When a requirement is unclear or ambiguous, ask one scoped question rather than guessing — offer concrete options to choose from where you can.',
  'Prefer emitting structured board components (a plan with a short diagram, or a question with selectable options) over long walls of prose.',
  'When you receive review comments, revise the existing plan to address them instead of starting over.',
  "Keep the task's tracking state up to date as you make progress so the board always reflects reality.",
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
export function buildClaudeCommand({ worktree, systemPromptPath, model, resumeSessionId, bin } = {}) {
  const command = bin || 'npx';
  const args = bin ? [] : ['-y', '@anthropic-ai/claude-code@' + CLAUDE_VERSION];
  args.push('-p', '--verbose', '--output-format', 'stream-json');

  if (model) {
    args.push('--model', model);
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

// Parse one line of Claude `stream-json`. Returns null for blank / non-JSON / non-object lines.
// Otherwise a normalized event: { raw, type, sessionId, messageId, text, result, isResult }.
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
    messageId: findMessageId(obj),
    text: extractAssistantText(obj),
    result: isResult ? obj : null,
    isResult,
  };
}

// Stateful reducer over a stream-json line stream. Feed lines via push(); read accumulated state via
// the getters. `sessionId` is the first one seen, `text` is all assistant text concatenated, and
// `done`/`result` flip once the terminal `type:'result'` line arrives.
export class StreamAccumulator {
  #sessionId = null;
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
