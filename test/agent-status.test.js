// ABOUTME: Unit tests for the pure agent-status derivation — hook-event → activity state, snapshot
// ABOUTME: transitions (stateStartedAt vs updatedAt), staleness, and run-mode → phase mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hookEventToActivity, deriveStatus, isStalled, phaseFromMode, STALE_MS_DEFAULT,
} from '../src/executor/agent-status.js';

test('hookEventToActivity maps hook events to activity states', () => {
  assert.equal(hookEventToActivity('SessionStart'), 'working');
  assert.equal(hookEventToActivity('UserPromptSubmit'), 'working');
  assert.equal(hookEventToActivity('PreToolUse'), 'working');
  assert.equal(hookEventToActivity('PostToolUse'), 'working');
  assert.equal(hookEventToActivity('SubagentStop'), 'working');
  assert.equal(hookEventToActivity('Notification'), 'waiting');
  assert.equal(hookEventToActivity('Stop'), 'done');
  // a tool response that denied/errored is 'blocked'
  assert.equal(hookEventToActivity('PostToolUse', 'blocked'), 'blocked');
  assert.equal(hookEventToActivity('PostToolUse', 'error'), 'blocked');
  assert.equal(hookEventToActivity('Unknown'), null);
});

test('deriveStatus captures sessionId and sets stateStartedAt only on state change', () => {
  // SessionStart → working, stateStartedAt = now, sessionId captured
  const s1 = deriveStatus({}, { hookEvent: 'SessionStart', sessionId: 's1' }, 1000);
  assert.equal(s1.state, 'working');
  assert.equal(s1.sessionId, 's1');
  assert.equal(s1.stateStartedAt, 1000);
  assert.equal(s1.updatedAt, 1000);

  // another working event → updatedAt bumps, stateStartedAt unchanged
  const s2 = deriveStatus(s1, { hookEvent: 'PreToolUse' }, 2000);
  assert.equal(s2.state, 'working');
  assert.equal(s2.stateStartedAt, 1000, 'stateStartedAt frozen while state unchanged');
  assert.equal(s2.updatedAt, 2000);

  // Notification → waiting, stateStartedAt moves
  const s3 = deriveStatus(s2, { hookEvent: 'Notification' }, 3000);
  assert.equal(s3.state, 'waiting');
  assert.equal(s3.stateStartedAt, 3000);

  // Stop → done
  const s4 = deriveStatus(s3, { hookEvent: 'Stop' }, 4000);
  assert.equal(s4.state, 'done');

  // an unknown hook event doesn't change state, only touches updatedAt
  const s5 = deriveStatus(s4, { hookEvent: 'Xyz' }, 5000);
  assert.equal(s5.state, 'done');
  assert.equal(s5.updatedAt, 5000);
});

test('deriveStatus folds assistant text into message without a hook event', () => {
  const s = deriveStatus({ state: 'working', stateStartedAt: 100, updatedAt: 100 }, { text: 'hello world' }, 200);
  assert.equal(s.message, 'hello world');
  assert.equal(s.state, 'working');
  assert.equal(s.updatedAt, 200);
});

test('isStalled: working past the threshold is stalled; done never is', () => {
  assert.equal(isStalled({ state: 'working', updatedAt: 0 }, 10 * 60000, 300000), true);
  assert.equal(isStalled({ state: 'working', updatedAt: 0 }, 60000, 300000), false);
  assert.equal(isStalled({ state: 'done', updatedAt: 0 }, 10 * 60000, 300000), false);
  assert.equal(isStalled({ state: 'waiting', updatedAt: 0 }, 10 * 60000, 300000), false, 'waiting is intentional, not stalled');
  assert.equal(isStalled(null, 1, 1), false);
  assert.equal(typeof STALE_MS_DEFAULT, 'number');
});

test('phaseFromMode maps executor run modes to phase labels', () => {
  assert.equal(phaseFromMode('plan'), 'plan');
  assert.equal(phaseFromMode('execute'), 'implement');
  assert.equal(phaseFromMode('verify'), 'verify');
  assert.equal(phaseFromMode('input_answer'), 'implement');
  assert.equal(phaseFromMode(undefined), 'implement');
});
