import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, canTransition, assertTransition } from '../src/tasks/lifecycle.js';

test("'archived' is a known terminal state reachable from every other state", () => {
  assert.ok(STATES.includes('archived'), "STATES must include 'archived'");

  // A user may soft-archive a task at ANY stage — every existing state can transition to archived.
  for (const from of STATES) {
    if (from === 'archived') continue;
    assert.doesNotThrow(
      () => assertTransition(from, 'archived'),
      `${from} -> archived should be legal`
    );
    assert.equal(canTransition(from, 'archived'), true, `${from} -> archived`);
  }
});

test("'archived' is terminal — nothing transitions out of it", () => {
  assert.throws(() => assertTransition('archived', 'in_progress'), /ILLEGAL_TRANSITION/);
  assert.equal(canTransition('archived', 'in_progress'), false);
  assert.equal(canTransition('archived', 'backlog'), false);
  assert.equal(canTransition('archived', 'done'), false);
});
