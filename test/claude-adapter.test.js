// ABOUTME: node:test coverage for the pure Claude Code CLI adapter — command/arg building and
// ABOUTME: stream-json parsing/accumulation. No spawning, no filesystem, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_VERSION,
  BE10X_SYSTEM_PROMPT,
  buildClaudeCommand,
  parseStreamLine,
  StreamAccumulator,
} from '../src/executor/claude-adapter.js';

// True when `sub` appears as a contiguous run inside `arr` — used to assert flag+value adjacency.
function hasContiguous(arr, sub) {
  for (let i = 0; i + sub.length <= arr.length; i++) {
    let ok = true;
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

test('CLAUDE_VERSION is the pinned version string', () => {
  assert.equal(CLAUDE_VERSION, '2.1.119');
});

test('BE10X_SYSTEM_PROMPT encodes the be10x flow', () => {
  assert.equal(typeof BE10X_SYSTEM_PROMPT, 'string');
  const p = BE10X_SYSTEM_PROMPT.toLowerCase();
  assert.match(p, /plan/);
  assert.match(p, /do not implement/);
  assert.match(p, /ask/);
  assert.match(p, /option/);
  assert.match(p, /review/);
});

test('buildClaudeCommand: base command uses npx and the pinned package', () => {
  const { command, args } = buildClaudeCommand({});
  assert.equal(command, 'npx');
  assert.ok(hasContiguous(args, ['-y', '@anthropic-ai/claude-code@' + CLAUDE_VERSION]));
});

test('buildClaudeCommand: always includes -p and --output-format stream-json', () => {
  const { args } = buildClaudeCommand({});
  assert.ok(args.includes('-p'));
  assert.ok(hasContiguous(args, ['--output-format', 'stream-json']));
});

test('buildClaudeCommand: fresh call with systemPromptPath adds the flag and NOT --resume', () => {
  const { args } = buildClaudeCommand({ systemPromptPath: '/tmp/sys.txt' });
  assert.ok(hasContiguous(args, ['--append-system-prompt-file', '/tmp/sys.txt']));
  assert.ok(!args.includes('--resume'));
});

test('buildClaudeCommand: resumeSessionId adds --resume and NOT the system-prompt flag', () => {
  const { args } = buildClaudeCommand({ resumeSessionId: 'abc', systemPromptPath: '/tmp/sys.txt' });
  assert.ok(hasContiguous(args, ['--resume', 'abc']));
  assert.ok(!args.includes('--append-system-prompt-file'));
});

test('buildClaudeCommand: includes --add-dir when worktree is given', () => {
  const { args } = buildClaudeCommand({ worktree: '/work/tree' });
  assert.ok(hasContiguous(args, ['--add-dir', '/work/tree']));
});

test('buildClaudeCommand: includes --model when model is given, omits when not', () => {
  const withModel = buildClaudeCommand({ model: 'claude-opus-4-8' });
  assert.ok(hasContiguous(withModel.args, ['--model', 'claude-opus-4-8']));
  const without = buildClaudeCommand({});
  assert.ok(!without.args.includes('--model'));
});

test('buildClaudeCommand: bin override runs the executable directly and drops the npx prefix', () => {
  const { command, args } = buildClaudeCommand({ bin: '/opt/claude', worktree: '/w', systemPromptPath: '/s.txt' });
  assert.equal(command, '/opt/claude');
  assert.ok(!args.includes('-y'));
  assert.ok(!args.some((a) => a.startsWith('@anthropic-ai/claude-code')));
  // the real CLI flags are still present so a local `claude` gets the same behaviour as npx
  assert.ok(hasContiguous(args, ['--output-format', 'stream-json']));
  assert.ok(hasContiguous(args, ['--append-system-prompt-file', '/s.txt']));
  assert.ok(hasContiguous(args, ['--add-dir', '/w']));
});

test('parseStreamLine: returns null for blank and non-JSON lines', () => {
  assert.equal(parseStreamLine(''), null);
  assert.equal(parseStreamLine('   '), null);
  assert.equal(parseStreamLine('not json'), null);
  // Valid JSON that is not an object is not a stream event.
  assert.equal(parseStreamLine('123'), null);
  assert.equal(parseStreamLine('[1,2]'), null);
});

test('parseStreamLine: extracts sessionId from a system message', () => {
  const event = parseStreamLine('{"type":"system","session_id":"s1"}');
  assert.ok(event);
  assert.equal(event.type, 'system');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.isResult, false);
});

test('parseStreamLine: extracts text from an assistant message', () => {
  const line =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]},"session_id":"s1"}';
  const event = parseStreamLine(line);
  assert.ok(event);
  assert.equal(event.type, 'assistant');
  assert.equal(event.text, 'Hello world');
  assert.equal(event.sessionId, 's1');
});

test('parseStreamLine: sets isResult for a result message', () => {
  const event = parseStreamLine('{"type":"result","subtype":"success"}');
  assert.ok(event);
  assert.equal(event.isResult, true);
  assert.deepEqual(event.result, { type: 'result', subtype: 'success' });
});

test('parseStreamLine: finds a nested session id defensively', () => {
  const event = parseStreamLine('{"type":"stream_event","event":{"session_id":"nested1"}}');
  assert.ok(event);
  assert.equal(event.sessionId, 'nested1');
});

test('StreamAccumulator: folds a realistic system→assistant→result stream', () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on it"}]},"session_id":"s1"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"s1"}',
  ];
  const acc = new StreamAccumulator();
  for (const line of lines) acc.push(line);

  assert.equal(acc.sessionId, 's1');
  assert.equal(acc.done, true);
  assert.ok(acc.text.length > 0);
  assert.equal(acc.text, 'Working on it');
  assert.equal(acc.result.subtype, 'success');
});

test('StreamAccumulator: push returns the parsed event and null for skipped lines', () => {
  const acc = new StreamAccumulator();
  assert.equal(acc.push(''), null);
  assert.equal(acc.push('not json'), null);
  const event = acc.push('{"type":"system","session_id":"s9"}');
  assert.ok(event);
  assert.equal(event.sessionId, 's9');
  assert.equal(acc.done, false);
});

test('StreamAccumulator: keeps the first session id and concatenates assistant text', () => {
  const acc = new StreamAccumulator();
  acc.push('{"type":"system","session_id":"first"}');
  acc.push('{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]},"session_id":"second"}');
  acc.push('{"type":"assistant","message":{"content":[{"type":"text","text":"b"}]},"session_id":"second"}');
  assert.equal(acc.sessionId, 'first');
  assert.equal(acc.text, 'ab');
});
