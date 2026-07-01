import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getType, validateContent, TASK_TYPES } from '../src/tasks/types.js';

test('getType returns a known type and throws on an unknown one', () => {
  assert.equal(getType('code-issue').agentExecutable, true);
  assert.equal(TASK_TYPES.general.agentExecutable, false);
  assert.throws(() => getType('nope'), /UNKNOWN_TYPE/);
});

test('validateContent passes when required fields are present', () => {
  assert.equal(validateContent('code-issue', { symptom: 'crash on load' }), true);
  assert.equal(validateContent('general', { summary: 'explore idea' }), true);
});

test('validateContent throws naming the missing required field', () => {
  assert.throws(() => validateContent('code-issue', {}), /MISSING_FIELD:symptom/);
  assert.throws(() => validateContent('general', { summary: '' }), /MISSING_FIELD:summary/);
});
