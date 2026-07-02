// ABOUTME: Tests the pure MCP tool registry (src/mcp/tools.js) by calling handler(db, ctx, args) directly.
// ABOUTME: No transport / SDK — the server.js wiring is intentionally thin; correctness lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createToken, verifyToken } from '../src/auth/tokens.js';
import { transition, getTask } from '../src/tasks/tasks.js';
import { getOpenInputRequest } from '../src/tasks/input_requests.js';
import { TOOLS } from '../src/mcp/tools.js';

// Invoke a tool the way the server would: find it in TOOLS by name, call its handler.
function call(db, ctx, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" is registered`);
  return tool.handler(db, ctx, args);
}

function seed() {
  const db = openDb(':memory:');
  const owner = createUser(db, { email: 'owner@be10x.co', displayName: 'Owner', password: 'pw123456' });
  const reviewer = createUser(db, { email: 'rev@be10x.co', displayName: 'Reviewer', password: 'pw123456' });
  const tok = createToken(db, owner.id, 'mcp');
  const ctx = { userId: owner.id };
  return { db, owner, reviewer, tok, ctx };
}

test('TOOLS registers exactly the 16 be10x front-door tools, all well-formed', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'gfa_answer_input',
    'gfa_claim_task',
    'gfa_create_task',
    'gfa_get_task',
    'gfa_list_tasks',
    'gfa_mark_ready',
    'gfa_plan_task',
    'gfa_post_artifact',
    'gfa_rate_task',
    'gfa_reply',
    'gfa_request_input',
    'gfa_research_task',
    'gfa_submit_for_review',
    'gfa_submit_output',
    'gfa_submit_plan',
    'gfa_update_progress',
  ]);
  for (const t of TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.handler, 'function');
  }
});

test('gfa_submit_plan sends a researching task to plan_review, defaulting the reviewer to the owner', () => {
  const { db, ctx, owner } = seed();
  const t = call(db, ctx, 'gfa_create_task', { type: 'general', scope: 'personal', title: 'Plan me', content: { summary: 'x' } });
  transition(db, t.id, 'researching', owner.id);
  const res = call(db, ctx, 'gfa_submit_plan', { taskId: t.id });
  assert.equal(res.status, 'plan_review');
  assert.equal(res.reviewerId, owner.id);
});

test('gfa_create_task (owned by ctx user) then gfa_get_task returns the same task', () => {
  const { db, ctx } = seed();
  const created = call(db, ctx, 'gfa_create_task', {
    type: 'code-issue',
    scope: 'personal',
    title: 'Login 500',
    content: { symptom: 'boom' },
  });
  assert.equal(created.status, 'backlog');
  assert.equal(created.ownerId, ctx.userId);
  assert.match(created.humanId, /^GFA-\d{3}$/);

  const got = call(db, ctx, 'gfa_get_task', { id: created.id });
  assert.equal(got.id, created.id);
  assert.deepEqual(got.content, { symptom: 'boom' });

  const listed = call(db, ctx, 'gfa_list_tasks', { status: 'backlog' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
});

test('research -> plan -> submit_for_review -> mark_ready walks the plan-review gate', () => {
  const { db, ctx, reviewer } = seed();
  const t = call(db, ctx, 'gfa_create_task', { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } });

  // No dedicated "start research" tool: enter the research phase directly (mirrors the core reviews/input tests).
  transition(db, t.id, 'researching', ctx.userId);

  const researched = call(db, ctx, 'gfa_research_task', { id: t.id, research: { rootCause: 'race' } });
  assert.deepEqual(researched.research, { rootCause: 'race' });

  const planned = call(db, ctx, 'gfa_plan_task', { id: t.id, plan: { steps: ['a', 'b'] } });
  assert.deepEqual(planned.plan, { steps: ['a', 'b'] });

  const inReview = call(db, ctx, 'gfa_submit_for_review', { taskId: t.id, reviewerId: reviewer.id });
  assert.equal(inReview.status, 'plan_review');
  assert.equal(inReview.reviewerId, reviewer.id);

  const ready = call(db, ctx, 'gfa_mark_ready', { id: t.id });
  assert.equal(ready.status, 'ready_to_work');
});

test('gfa_claim_task then gfa_request_input pauses the task and gfa_answer_input resumes it', () => {
  const { db, ctx } = seed();
  const t = call(db, ctx, 'gfa_create_task', { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } });

  call(db, ctx, 'gfa_mark_ready', { id: t.id }); // backlog -> ready_to_work
  const claimed = call(db, ctx, 'gfa_claim_task', {}); // ready_to_work -> in_progress (code-issue is agent-executable)
  assert.equal(claimed.id, t.id);
  assert.equal(claimed.status, 'in_progress');

  const req = call(db, ctx, 'gfa_request_input', { taskId: t.id, question: 'A or B?', choices: ['A', 'B'] });
  assert.equal(getTask(db, t.id).status, 'needs_input');
  assert.deepEqual(req.choices, ['A', 'B']);

  // answerInput (answeredBy = ctx.userId) returns the now-empty open request => null, and resumes the task.
  const resumed = call(db, ctx, 'gfa_answer_input', { requestId: req.id, answer: 'A' });
  assert.equal(resumed, null);
  assert.equal(getTask(db, t.id).status, 'in_progress');
  assert.equal(getOpenInputRequest(db, t.id), null);
});

test('gfa_update_progress, gfa_submit_output and gfa_rate_task record onto the task', () => {
  const { db, ctx } = seed();
  const t = call(db, ctx, 'gfa_create_task', { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } });
  call(db, ctx, 'gfa_mark_ready', { id: t.id });
  call(db, ctx, 'gfa_claim_task', {});

  const prog = call(db, ctx, 'gfa_update_progress', {
    taskId: t.id,
    state: 'working',
    step: 'edit',
    message: 'wip',
    todos: ['a'],
    changes: { files: 1 },
  });
  assert.equal(prog.agent.state, 'working');
  assert.equal(prog.agent.step, 'edit');

  const shipped = call(db, ctx, 'gfa_submit_output', { id: t.id, refs: { pr: 'http://x/1' } });
  assert.deepEqual(shipped.refs, { pr: 'http://x/1' });

  const rated = call(db, ctx, 'gfa_rate_task', { id: t.id, rating: { score: 0.9 } });
  assert.deepEqual(rated.rating, { score: 0.9 });
});

test('gfa_post_artifact posts a visual artifact and upserts by key', () => {
  const { db, ctx } = seed();
  const t = call(db, ctx, 'gfa_create_task', { type: 'code-issue', scope: 'personal', title: 'Bug', content: { symptom: 'x' } });

  const posted = call(db, ctx, 'gfa_post_artifact', {
    id: t.id,
    kind: 'rca',
    title: 'Why it crashed',
    key: 'rca',
    content: '<div>the failure path</div>',
  });
  assert.equal(posted.artifacts.length, 1);
  assert.equal(posted.artifacts[0].kind, 'rca');
  assert.equal(posted.artifacts[0].content, '<div>the failure path</div>');

  // Re-posting the same key refines it in place.
  const refined = call(db, ctx, 'gfa_post_artifact', { id: t.id, key: 'rca', kind: 'rca', content: '<div>refined</div>' });
  assert.equal(refined.artifacts.length, 1);
  assert.equal(refined.artifacts[0].content, '<div>refined</div>');
});

test('verifyToken rejects a bogus secret and accepts a freshly created one', () => {
  const { db, tok, owner } = seed();
  assert.equal(verifyToken(db, 'bogus'), null);
  const ok = verifyToken(db, tok.token);
  assert.equal(ok.userId, owner.id);
});
