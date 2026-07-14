import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, canTransition, assertTransition } from '../src/tasks/lifecycle.js';

test('the canonical happy path is legal end to end', () => {
  const path = ['backlog', 'researching', 'plan_review', 'ready_to_work', 'in_progress', 'verifying', 'done'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test('needs_input pauses and resumes in_progress', () => {
  assert.equal(canTransition('in_progress', 'needs_input'), true);
  assert.equal(canTransition('needs_input', 'in_progress'), true);
});

test('illegal transitions are rejected', () => {
  assert.equal(canTransition('backlog', 'done'), false);
  assert.equal(canTransition('done', 'in_progress'), false);
  assert.throws(() => assertTransition('done', 'backlog'), /ILLEGAL_TRANSITION/);
});

test('STATES lists every known state', () => {
  assert.equal(STATES.includes('needs_input'), true);
  assert.equal(STATES.includes('archived'), true);
  assert.equal(STATES.length, 12);
});
