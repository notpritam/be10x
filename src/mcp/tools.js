// ABOUTME: Pure, transport-agnostic MCP tool registry for be10x — the agent-facing "front door".
// ABOUTME: Each tool wraps a core function; ctx.userId is the authenticated actor/owner. No I/O, no SDK here.
import { createTask, getTask, listTasks, setResearch, setPlan, transition, rateTask, setRefs } from '../tasks/tasks.js';
import { requestReview } from '../reviews/reviews.js';
import { requestInput, answerInput } from '../tasks/input_requests.js';
import { addComment } from '../tasks/comments.js';
import { claimNextReadyTask, recordProgress } from '../worker/worker.js';
import { STATES } from '../tasks/lifecycle.js';

const SCOPES = ['personal', 'project', 'team'];
const TYPES = ['code-issue', 'general'];
// Free-form JSON object stored verbatim on the task (fields vary by task type / board convention).
const freeObject = (description) => ({ type: 'object', additionalProperties: true, description });

// The registry. Every entry: { name, description, inputSchema (JSON Schema), handler(db, ctx, args) }.
// Handlers call core and return the JSON-serializable result — core errors are allowed to throw.
export const TOOLS = [
  {
    name: 'gfa_list_tasks',
    description: 'List tasks on the board, optionally filtered by scope, team, lifecycle status, or owner.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES, description: 'Filter by scope.' },
        teamId: { type: 'string', description: 'Filter by team id.' },
        status: { type: 'string', enum: STATES, description: 'Filter by lifecycle status.' },
        ownerId: { type: 'string', description: 'Filter by owner user id.' },
      },
      additionalProperties: false,
    },
    handler: (db, ctx, args = {}) =>
      listTasks(db, { scope: args.scope, teamId: args.teamId, status: args.status, ownerId: args.ownerId }),
  },
  {
    name: 'gfa_get_task',
    description: 'Fetch a single task (with content, plan, research, refs, agent progress) by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id (uuid).' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => getTask(db, args.id),
  },
  {
    name: 'gfa_create_task',
    description:
      'Create a task owned by the authenticated user. Starts in "backlog". code-issue requires content.symptom; general requires content.summary.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: TYPES, description: 'Task type.' },
        scope: { type: 'string', enum: SCOPES, description: 'Visibility scope.' },
        title: { type: 'string', description: 'Short human-readable title.' },
        content: freeObject('Type-specific fields (e.g. { symptom } or { summary }).'),
        teamId: { type: 'string', description: 'Team id (used when scope="team").' },
        severity: { type: 'string', description: 'Priority: low | medium | high | critical (default medium).' },
      },
      required: ['type', 'scope', 'title'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) =>
      createTask(db, {
        type: args.type,
        scope: args.scope,
        title: args.title,
        ownerId: ctx.userId,
        content: args.content ?? {},
        teamId: args.teamId ?? null,
        severity: args.severity ?? 'medium',
      }),
  },
  {
    name: 'gfa_research_task',
    description: 'Attach a research payload (root cause, findings, sources) to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        research: freeObject('Research findings for the task.'),
      },
      required: ['id', 'research'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => setResearch(db, args.id, args.research, ctx.userId),
  },
  {
    name: 'gfa_plan_task',
    description:
      'Attach the task plan (shown on the board). The plan can be a rich HTML string (rendered safely in a sandbox — use it for diagrams, wireframes, tables, and visualizations), a markdown string, a structured { steps, diagram }, or a { blocks: [...] } mix — choose what best explains the task. Favour showing over prose.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        // No `type` constraint: the plan may be a string (HTML/markdown) or an object/array.
        plan: { description: 'The plan: a rich HTML string, markdown string, or an object like { steps, diagram, html } or { blocks: [...] }.' },
      },
      required: ['id', 'plan'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => setPlan(db, args.id, args.plan, ctx.userId),
  },
  {
    name: 'gfa_submit_for_review',
    description: 'Tag a reviewer and move the task into "plan_review". The task must be in "researching" first.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id.' },
        reviewerId: { type: 'string', description: 'User id to tag as reviewer.' },
      },
      required: ['taskId', 'reviewerId'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => requestReview(db, args.taskId, args.reviewerId, ctx.userId),
  },
  {
    name: 'gfa_submit_plan',
    description:
      'Submit the task plan for review — moves it into "plan_review" and tags a reviewer (defaults to the task owner). Call this after gfa_plan_task when the plan is ready for a human to approve.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id.' },
        reviewerId: { type: 'string', description: 'Optional reviewer user id (defaults to the task owner).' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      const task = getTask(db, args.taskId);
      if (!task) throw new Error('NO_TASK');
      return requestReview(db, args.taskId, args.reviewerId || task.ownerId, ctx.userId);
    },
  },
  {
    name: 'gfa_mark_ready',
    description: 'Transition a task to "ready_to_work" so the worker can claim it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => transition(db, args.id, 'ready_to_work', ctx.userId),
  },
  {
    name: 'gfa_claim_task',
    description:
      'Atomically claim the oldest ready_to_work, agent-executable task and move it to "in_progress". Returns the task, or null if none are available.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Optional worker label; defaults to the authenticated user.' },
      },
      additionalProperties: false,
    },
    handler: (db, ctx, args = {}) => claimNextReadyTask(db, args.workerId ?? ctx.userId),
  },
  {
    name: 'gfa_update_progress',
    description: 'Stream agent progress (state, current step, message, todos, changes) onto a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id.' },
        state: { type: 'string', description: 'e.g. working | blocked | done (default working).' },
        step: { type: 'string', description: 'Short label for the current step.' },
        message: { type: 'string', description: 'Human-readable progress note.' },
        todos: { type: 'array', items: {}, description: 'Ordered implementation task list. Each item is { text, status } where status is "pending" | "in_progress" | "done" (plain strings also accepted). Keep it updated as steps complete so the human sees live progress.' },
        changes: { description: 'Free-form summary of files/diffs changed this step.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) =>
      recordProgress(
        db,
        args.taskId,
        { state: args.state, step: args.step, message: args.message, todos: args.todos, changes: args.changes },
        ctx.userId
      ),
  },
  {
    name: 'gfa_reply',
    description:
      'Post a conversational reply to the task discussion — this is how you talk back to the human on a query/chat task. Your reply shows as from the agent. For code tasks use gfa_plan_task / gfa_update_progress instead.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id.' },
        message: { type: 'string', description: 'Your reply to the human.' },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => addComment(db, args.taskId, { author: 'agent', body: args.message, anchor: 'general' }),
  },
  {
    name: 'gfa_request_input',
    description: 'Ask the human a scoped question. If the task is in_progress it pauses in "needs_input".',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id.' },
        question: { type: 'string', description: 'The question to ask.' },
        choices: { type: 'array', items: { type: 'string' }, description: 'Optional quick-choice options.' },
        allowCustom: { type: 'boolean', description: 'Allow a free-text answer (default true).' },
      },
      required: ['taskId', 'question'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) =>
      requestInput(db, args.taskId, args.question, { choices: args.choices, allowCustom: args.allowCustom }, ctx.userId),
  },
  {
    name: 'gfa_answer_input',
    description: 'Answer an open input request (answeredBy is the authenticated user). Resumes a paused task.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Input request id.' },
        answer: { type: 'string', description: 'The answer.' },
      },
      required: ['requestId', 'answer'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => answerInput(db, args.requestId, args.answer, ctx.userId),
  },
  {
    name: 'gfa_rate_task',
    description: 'Attach a rating to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        rating: freeObject('Rating payload (e.g. { score: 0.9, comment }).'),
      },
      required: ['id', 'rating'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => rateTask(db, args.id, args.rating, ctx.userId),
  },
  {
    name: 'gfa_submit_output',
    description: 'Record output references / artifacts (the "ship" step), e.g. { pr: "https://..." }.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        refs: freeObject('Output artifacts / links.'),
      },
      required: ['id', 'refs'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => setRefs(db, args.id, args.refs, ctx.userId),
  },
];

// Convenience lookup shared by the server wiring and tests.
export function getTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}
