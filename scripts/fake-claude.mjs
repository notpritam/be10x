#!/usr/bin/env node
// ABOUTME: A fake `claude-code` CLI for be10x smoke tests — ignores its args/stdin, emits one canned
// ABOUTME: init→plan→result stream-json turn, exits 0. Point GFA_CLAUDE_BIN at this to drive the whole
// ABOUTME: runner/worktree/runs/board pipeline for real, without the CLI, network, API, or cost.

// Swallow stdin (the runner writes the prompt then end()s it) so we never crash the writer.
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

const sessionId = 'smoke-' + process.pid + '-' + Date.now().toString(36);
const events = [
  { type: 'system', subtype: 'init', session_id: sessionId },
  {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Plan (fake agent): 1) reproduce, 2) write a failing test, 3) fix, 4) verify. Awaiting approval before implementing.',
        },
      ],
    },
  },
  { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'plan proposed' },
];

for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
process.exit(0);
