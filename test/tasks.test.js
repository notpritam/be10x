import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import {
  createTask,
  getTask,
  listTasks,
  setResearch,
  setPlan,
  updateContent,
  transition,
  retryTask,
  rateTask,
  setRefs,
  postArtifact,
  importTask,
  handoffReasonForPhase,
} from '../src/tasks/tasks.js';
import { listEvents } from '../src/tasks/events.js';

function owner(db) {
  return createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
}

test('createTask starts in backlog with a GFA human id and parsed content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  assert.equal(t.status, 'backlog');
  assert.match(t.humanId, /^GFA-\d{3}$/);
  assert.deepEqual(t.content, { summary: 's' });
  assert.equal(t.plan, null);
  assert.equal(getTask(db, t.id).title, 'Idea');
});

test('createTask rejects unknown type and missing required content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  assert.throws(() => createTask(db, { type: 'nope', scope: 'personal', title: 'x', ownerId: uid }), /UNKNOWN_TYPE/);
  assert.throws(
    () => createTask(db, { type: 'code-issue', scope: 'personal', title: 'x', ownerId: uid, content: {} }),
    /MISSING_FIELD:symptom/
  );
});

test('human ids increment', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const a = createTask(db, { type: 'general', scope: 'personal', title: 'A', ownerId: uid, content: { summary: 's' } });
  const b = createTask(db, { type: 'general', scope: 'personal', title: 'B', ownerId: uid, content: { summary: 's' } });
  assert.equal(a.humanId, 'GFA-001');
  assert.equal(b.humanId, 'GFA-002');
});

test('listTasks filters by status', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  createTask(db, { type: 'general', scope: 'personal', title: 'A', ownerId: uid, content: { summary: 's' } });
  assert.equal(listTasks(db, { status: 'backlog' }).length, 1);
  assert.equal(listTasks(db, { status: 'done' }).length, 0);
});

test('setPlan and setResearch attach data and log events; replan overwrites', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  setResearch(db, t.id, { confidence: 'high' }, uid);
  setPlan(db, t.id, { steps: ['a'] }, uid);
  const replanned = setPlan(db, t.id, { steps: ['a', 'b'] }, uid);
  assert.deepEqual(replanned.plan, { steps: ['a', 'b'] });
  assert.deepEqual(replanned.research, { confidence: 'high' });
  const kinds = listEvents(db, t.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'research', 'plan', 'plan']);
});

test('updateContent merges into existing content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  const u = updateContent(db, t.id, { rootCause: 'race' }, uid);
  assert.deepEqual(u.content, { symptom: 'x', rootCause: 'race' });
});

test('transition enforces the state machine and logs from/to', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  const moved = transition(db, t.id, 'researching', uid);
  assert.equal(moved.status, 'researching');
  assert.throws(() => transition(db, t.id, 'done', uid), /ILLEGAL_TRANSITION/);
  const last = listEvents(db, t.id).at(-1);
  assert.deepEqual([last.kind, last.payload.from, last.payload.to], ['status', 'backlog', 'researching']);
});

test('retryTask increments the retry counter', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  assert.equal(retryTask(db, t.id, uid).retryCount, 1);
  assert.equal(retryTask(db, t.id, uid).retryCount, 2);
});

test('rateTask and setRefs attach data and log events', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  assert.deepEqual(rateTask(db, t.id, { score: 0.9 }, 'agent').rating, { score: 0.9 });
  assert.deepEqual(setRefs(db, t.id, { pr: 'http://x/1' }, 'agent').refs, { pr: 'http://x/1' });
});

test('setRefs reconciles the checklist: shipping flips an in-progress step to done (no stale spinner)', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  // Simulate the agent's last checklist: one step still in-progress when it ships.
  const agent = { state: 'working', step: 'ship', message: 'submitting', todos: [
    { text: 'implement', status: 'done' },
    { text: 'submit output', status: 'in_progress' },
  ], updatedAt: 1 };
  db.prepare('UPDATE tasks SET agent_json = ? WHERE id = ?').run(JSON.stringify(agent), t.id);

  const after = setRefs(db, t.id, { pr: 'http://x/1' }, 'agent');
  assert.equal(after.agent.todos[1].status, 'done', 'the in-progress step is completed on ship');
  assert.equal(after.agent.todos[0].status, 'done');
});

test('postArtifact appends a keyed artifact, upserts by key, and logs an event', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });

  // First post — an RCA with HTML content.
  const a = postArtifact(db, t.id, { key: 'rca', kind: 'rca', title: 'Root cause', content: '<b>race</b>' }, 'agent');
  assert.equal(a.artifacts.length, 1);
  assert.equal(a.artifacts[0].key, 'rca');
  assert.equal(a.artifacts[0].kind, 'rca');
  assert.equal(a.artifacts[0].content, '<b>race</b>');
  assert.ok(a.artifacts[0].createdAt);

  // Same key updates in place (refine the RCA) rather than adding a duplicate.
  const b = postArtifact(db, t.id, { key: 'rca', kind: 'rca', title: 'Root cause (refined)', content: '<b>lock order</b>' }, 'agent');
  assert.equal(b.artifacts.length, 1);
  assert.equal(b.artifacts[0].title, 'Root cause (refined)');
  assert.equal(b.artifacts[0].content, '<b>lock order</b>');
  assert.ok(b.artifacts[0].updatedAt);

  // A different key appends a second artifact.
  const c = postArtifact(db, t.id, { key: 'fix', kind: 'suggestion', title: 'Proposed fix', content: 'reorder locks' }, 'agent');
  assert.equal(c.artifacts.length, 2);

  const arts = listEvents(db, t.id).filter((e) => e.kind === 'artifact');
  assert.equal(arts.length, 3);
  assert.equal(arts[0].payload.key, 'rca');
});

test('postArtifact defaults kind to note, generates a key, and accepts structured content', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'general', scope: 'personal', title: 'Idea', ownerId: uid, content: { summary: 's' } });
  const a = postArtifact(db, t.id, { content: { blocks: [{ type: 'text', text: 'hi' }] } }, 'agent');
  assert.equal(a.artifacts[0].kind, 'note');
  assert.ok(a.artifacts[0].key, 'a key is generated when none is given');
  assert.deepEqual(a.artifacts[0].content, { blocks: [{ type: 'text', text: 'hi' }] });
});

test('importTask: an early idea just lands in the backlog with a summary (falls back to title)', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = importTask(db, { title: 'Just an idea', phase: 'idea' }, uid);
  assert.equal(t.status, 'backlog');
  assert.equal(t.type, 'general');
  assert.equal(t.scope, 'personal');
  assert.equal(t.content.summary, 'Just an idea');
  assert.ok(listEvents(db, t.id).some((e) => e.kind === 'imported'));
});

test('importTask: plan_review adopts a code-issue with plan + artifacts attached', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = importTask(
    db,
    {
      title: 'Adopt me',
      type: 'code-issue',
      symptom: 'boom',
      phase: 'plan_review',
      plan: '<b>the plan</b>',
      artifacts: [{ key: 'rca', kind: 'rca', content: '<i>why</i>' }],
    },
    uid
  );
  assert.equal(t.status, 'plan_review');
  assert.equal(t.plan, '<b>the plan</b>');
  assert.equal(t.artifacts.length, 1);
  assert.equal(t.content.symptom, 'boom');
});

test('importTask: phase in_progress walks backlog→ready_to_work→in_progress', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = importTask(db, { title: 'WIP', phase: 'in_progress', summary: 'doing it' }, uid);
  assert.equal(t.status, 'in_progress');
});

test('importTask: plan_review WITHOUT a plan stops at researching (nothing to review)', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = importTask(db, { title: 'no plan yet', phase: 'plan_review' }, uid);
  assert.equal(t.status, 'researching');
});

test('importTask requires a title; handoffReasonForPhase maps phases to wake reasons', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  assert.throws(() => importTask(db, { phase: 'idea' }, uid), /MISSING_FIELD:title/);
  assert.equal(handoffReasonForPhase('ready'), 'execute');
  assert.equal(handoffReasonForPhase('in_progress'), 'pick_up_now');
  assert.equal(handoffReasonForPhase('idea'), 'plan');
  assert.equal(handoffReasonForPhase('plan_review'), null);
});

test('DoD: a task walks the full legal lifecycle and records every event', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  const steps = ['researching', 'plan_review', 'ready_to_work', 'in_progress', 'needs_input', 'in_progress', 'verifying', 'done'];
  for (const s of steps) transition(db, t.id, s, 'agent');
  assert.equal(getTask(db, t.id).status, 'done');
  const statusEvents = listEvents(db, t.id).filter((e) => e.kind === 'status');
  assert.equal(statusEvents.length, steps.length);
  assert.equal(statusEvents.at(-1).payload.to, 'done');
});
