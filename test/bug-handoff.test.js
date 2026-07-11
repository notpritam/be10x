// ABOUTME: Tests the bug→task hand-off core (src/bugs/handoff.js) — composing a code-issue task from a bug's
// ABOUTME: capture, seeding the RCA artifact, linking bug ⇄ task, and not spawning duplicates on re-hand-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug, getBug } from '../src/bugs/bugs.js';
import { getTask } from '../src/tasks/tasks.js';
import { handoffBugToTask } from '../src/bugs/handoff.js';

function seed() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@be10x.co', displayName: 'QA', password: 'pw123456' });
  const bug = createBug(db, {
    reporterId: user.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    severity: 'critical',
    meta: {
      notes: 'Click pay, nothing happens.',
      errorCount: 1,
      console: [{ ts: 1000, level: 'error', text: "TypeError: can't read 'total'\n at Pay.tsx:42" }],
      pickedElements: [{ selector: 'button#pay', tag: 'BUTTON', rect: { x: 0, y: 0, w: 1, h: 1 }, react: { component: 'PayButton', source: 'src/checkout/Pay.tsx:42' } }],
      credentials: { username: 'qa@example.com', password: 'Secret1!' },
      recording: { startedAt: 0, endedAt: 5000, durationMs: 5000, mode: 'explicit' },
    },
  });
  return { db, user, bug };
}

test('handoffBugToTask creates a code-issue task and links both ways', () => {
  const { db, user, bug } = seed();
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  assert.equal(task.type, 'code-issue');
  assert.match(task.title, /Pay button dead/);
  assert.equal(task.severity, 'high'); // critical folds to high
  assert.equal(task.content.bugId, bug.id);
  assert.equal(task.content.bugHumanId, bug.humanId);
  assert.equal(task.content.suspectedComponent, 'PayButton');
  assert.match(task.content.symptom, /Suspected component/);
  assert.match(task.content.symptom, /Test login: qa@example.com/);
  // Reverse link on the bug + a 'handoff' event on its timeline.
  assert.equal(getBug(db, bug.id).taskId, task.id);
});

test('the task is seeded with the RCA capture artifact', () => {
  const { db, user, bug } = seed();
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  const full = getTask(db, task.id);
  const art = (full.artifacts || []).find((a) => a.key === 'bug-capture');
  assert.ok(art, 'RCA artifact seeded on the task');
  assert.match(String(art.content), /Suspected cause/);
});

test('re-handoff of a linked bug returns the existing link, not a duplicate task', () => {
  const { db, user, bug } = seed();
  const first = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  const second = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  assert.equal(second.alreadyLinked, true);
  assert.equal(second.task, null);
  assert.equal(second.bug.taskId, first.task.id);
});

test('handoff of a missing bug throws NOT_FOUND', () => {
  const { db, user } = seed();
  assert.throws(() => handoffBugToTask(db, { bugId: 'nope', actorId: user.id }), /NOT_FOUND/);
});
