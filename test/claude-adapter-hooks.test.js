// ABOUTME: The stream parser surfaces claude-code hook lifecycle events (from --include-hook-events) and
// ABOUTME: the flag is present on the built command, so the executor can derive live agent state from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeCommand } from '../src/executor/claude-adapter.js';
import { StreamAccumulator } from '../src/executor/claude-adapter.js';

test('buildClaudeCommand includes --include-hook-events', () => {
  const { args } = buildClaudeCommand({ bin: 'claude' });
  assert.ok(args.includes('--include-hook-events'), 'hook events must be requested');
  assert.ok(args.includes('stream-json'));
});

test('a hook_started system line surfaces hookEvent + sessionId', () => {
  const acc = new StreamAccumulator();
  const ev = acc.push(JSON.stringify({
    type: 'system', subtype: 'hook_started', hook_event: 'Notification', hook_name: 'Notification',
    session_id: 's1', uuid: 'u1',
  }));
  assert.equal(ev.hookEvent, 'Notification');
  assert.equal(ev.sessionId, 's1');
  assert.equal(ev.outcome, null);
});

test('a hook_response system line surfaces hookEvent + outcome', () => {
  const acc = new StreamAccumulator();
  const ev = acc.push(JSON.stringify({
    type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'blocked',
    exit_code: 2, session_id: 's1',
  }));
  assert.equal(ev.hookEvent, 'PostToolUse');
  assert.equal(ev.outcome, 'blocked');
});

test('a normal assistant line has hookEvent null', () => {
  const acc = new StreamAccumulator();
  const ev = acc.push(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] },
  }));
  assert.equal(ev.hookEvent, null);
  assert.equal(ev.text, 'hi');
});
