import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, isRetryable, maxAttempts, backoffMs, guidance } from '../src/executor/failures.js';

test('classifyFailure maps real CLI failure text to a kind', () => {
  // auth (the dominant GFA-003 cause)
  assert.equal(classifyFailure('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyFailure('Invalid API key'), 'auth');
  assert.equal(classifyFailure('401 Unauthorized'), 'auth');
  // network / upstream
  assert.equal(classifyFailure('API Error: Unable to connect to API (ECONNRESET)'), 'network');
  assert.equal(classifyFailure('API Error: Unable to connect to API (ConnectionRefused)'), 'network');
  assert.equal(classifyFailure('503 overloaded'), 'network');
  // process death
  assert.equal(classifyFailure('orphaned: process gone before completion'), 'crash');
  assert.equal(classifyFailure('agent exited without a result'), 'crash');
  // a genuine code error
  assert.equal(classifyFailure('TypeError: x is not a function'), 'other');
  assert.equal(classifyFailure(''), 'other');
});

test('retry policy: environmental kinds retry; a genuine error does not', () => {
  assert.equal(isRetryable('auth'), true);
  assert.equal(isRetryable('network'), true);
  assert.equal(isRetryable('crash'), true);
  assert.equal(isRetryable('other'), false);
});

test('backoff is bounded and monotonic; auth waits longer than a network blip', () => {
  assert.ok(backoffMs('network', 1) < backoffMs('network', 4));
  assert.ok(backoffMs('network', 99) <= 60_000);
  assert.equal(backoffMs('auth', 1), 30_000);
  assert.ok(maxAttempts('auth') <= maxAttempts('network'));
});

test('guidance gives an actionable line for auth (and none for a plain code error)', () => {
  assert.match(guidance('auth'), /ANTHROPIC_API_KEY|login/i);
  assert.equal(guidance('other'), null);
});
