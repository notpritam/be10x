import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, transition } from '../src/tasks/tasks.js';
import { requestInput, answerInput, getOpenInputRequest } from '../src/tasks/input_requests.js';

function seedInProgress(db) {
  const uid = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  for (const s of ['researching', 'plan_review', 'ready_to_work', 'in_progress']) transition(db, t.id, s, uid);
  return { uid, taskId: t.id };
}

test('requestInput pauses the task in needs_input and exposes choices', () => {
  const db = openDb(':memory:');
  const { taskId } = seedInProgress(db);
  const req = requestInput(db, taskId, 'A or B?', { choices: ['A', 'B'], allowCustom: true }, 'agent');
  assert.equal(getTask(db, taskId).status, 'needs_input');
  assert.equal(req.question, 'A or B?');
  assert.deepEqual(req.choices, ['A', 'B']);
  assert.equal(req.allowCustom, true);
  assert.equal(getOpenInputRequest(db, taskId).id, req.id);
});

test('answerInput records the answer and resumes the task', () => {
  const db = openDb(':memory:');
  const { uid, taskId } = seedInProgress(db);
  const req = requestInput(db, taskId, 'A or B?', { choices: ['A', 'B'] }, 'agent');
  answerInput(db, req.id, 'A', uid);
  assert.equal(getTask(db, taskId).status, 'in_progress');
  assert.equal(getOpenInputRequest(db, taskId), null);
});

test('answering an already-answered request throws', () => {
  const db = openDb(':memory:');
  const { uid, taskId } = seedInProgress(db);
  const req = requestInput(db, taskId, 'A or B?', {}, 'agent');
  answerInput(db, req.id, 'A', uid);
  assert.throws(() => answerInput(db, req.id, 'B', uid), /ALREADY_ANSWERED/);
});
