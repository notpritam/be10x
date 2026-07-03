// ABOUTME: Pure, transport-agnostic MCP tool registry for be10x — the agent-facing "front door".
// ABOUTME: Each tool wraps a core function; ctx.userId is the authenticated actor/owner. No I/O, no SDK here.
import {
  createTask,
  getTask,
  listTasksForUser,
  setResearch,
  setPlan,
  transition,
  rateTask,
  setRefs,
  postArtifact,
  importTask,
  IMPORT_PHASES,
  handoffReasonForPhase,
} from '../tasks/tasks.js';
import { requestReview } from '../reviews/reviews.js';
import { requestInput, answerInput, getRequestTaskId } from '../tasks/input_requests.js';
import { addComment } from '../tasks/comments.js';
import { claimNextReadyTask, recordProgress } from '../worker/worker.js';
import { listProjectsForUser } from '../projects/projects.js';
import { enqueueWake } from '../executor/wake.js';
import { STATES } from '../tasks/lifecycle.js';
import { assertCan, assertCanAccessTask } from '../authz/authz.js';

const SCOPES = ['personal', 'project', 'team'];
const TYPES = ['code-issue', 'general'];
// Free-form JSON object stored verbatim on the task (fields vary by task type / board convention).
const freeObject = (description) => ({ type: 'object', additionalProperties: true, description });

// The task id may arrive as `id` (this file's convention) OR `taskId` (the convention of
// gfa_update_progress / gfa_submit_plan / gfa_reply). Accept either everywhere so the agent mixing them
// up can't wedge a task — passing `taskId` to gfa_submit_output(id) is exactly what silently produced a
// "NOT NULL constraint failed: task_events.task_id" crash and left the task looping in verify.
const taskIdOf = (args = {}) => args.id ?? args.taskId;
const ID_OR_TASKID = {
  id: { type: 'string', description: 'Task id (uuid).' },
  taskId: { type: 'string', description: 'Alias for id — either is accepted.' },
};

// Every handler below that touches an existing task must go through this first: fetch it, and verify
// ctx.userId (the token owner) can actually reach it — owns it, is on its team, or can see its project
// (see authz.js canAccessTask). A personal access token is bearer-only, so without this a token minted for
// one account's own work could read or mutate ANY task on the board by id (see RCA issue 1). Throws
// NO_TASK / FORBIDDEN exactly like the equivalent HTTP routes.
function requireTaskAccess(db, ctx, taskId, action = 'task.read') {
  const task = getTask(db, taskId);
  if (!task) throw new Error('NO_TASK');
  assertCanAccessTask(db, ctx.userId, task, action);
  return task;
}

// The registry. Every entry: { name, description, inputSchema (JSON Schema), handler(db, ctx, args) }.
// Handlers call core and return the JSON-serializable result — core errors are allowed to throw.
export const TOOLS = [
  {
    name: 'gfa_list_tasks',
    description: 'List tasks on the board, optionally filtered by scope, team, or lifecycle status. Always scoped to what the authenticated user can see.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES, description: 'Filter by scope.' },
        teamId: { type: 'string', description: 'Filter by team id.' },
        status: { type: 'string', enum: STATES, description: 'Filter by lifecycle status.' },
      },
      additionalProperties: false,
    },
    handler: (db, ctx, args = {}) =>
      listTasksForUser(db, ctx.userId, { scope: args.scope, teamId: args.teamId, status: args.status }),
  },
  {
    name: 'gfa_get_task',
    description: 'Fetch a single task (with content, plan, research, refs, agent progress) by id.',
    inputSchema: {
      type: 'object',
      properties: { ...ID_OR_TASKID },
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      const task = getTask(db, taskIdOf(args));
      if (task) assertCanAccessTask(db, ctx.userId, task);
      return task;
    },
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
    handler: (db, ctx, args) => {
      if (args.teamId) assertCan(db, ctx.userId, 'task.create', { teamId: args.teamId });
      return createTask(db, {
        type: args.type,
        scope: args.scope,
        title: args.title,
        ownerId: ctx.userId,
        content: args.content ?? {},
        teamId: args.teamId ?? null,
        severity: args.severity ?? 'medium',
      });
    },
  },
  {
    name: 'gfa_research_task',
    description: 'Attach a research payload (root cause, findings, sources) to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ID_OR_TASKID,
        research: freeObject('Research findings for the task.'),
      },
      required: ['research'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return setResearch(db, taskIdOf(args), args.research, ctx.userId);
    },
  },
  {
    name: 'gfa_plan_task',
    description:
      'Attach the task plan (shown on the board). The plan can be a rich HTML string (rendered safely in a sandbox — use it for diagrams, wireframes, tables, and visualizations), a markdown string, a structured { steps, diagram }, or a { blocks: [...] } mix — choose what best explains the task. Favour showing over prose.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ID_OR_TASKID,
        // No `type` constraint: the plan may be a string (HTML/markdown) or an object/array.
        plan: { description: 'The plan: a rich HTML string, markdown string, or an object like { steps, diagram, html } or { blocks: [...] }.' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return setPlan(db, taskIdOf(args), args.plan, ctx.userId);
    },
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
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, args.taskId, 'task.update');
      return requestReview(db, args.taskId, args.reviewerId, ctx.userId);
    },
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
      const task = requireTaskAccess(db, ctx, args.taskId, 'task.update');
      return requestReview(db, args.taskId, args.reviewerId || task.ownerId, ctx.userId);
    },
  },
  {
    name: 'gfa_mark_ready',
    description: 'Transition a task to "ready_to_work" so the worker can claim it.',
    inputSchema: {
      type: 'object',
      properties: { ...ID_OR_TASKID },
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return transition(db, taskIdOf(args), 'ready_to_work', ctx.userId);
    },
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
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, args.taskId, 'task.update');
      return recordProgress(
        db,
        args.taskId,
        { state: args.state, step: args.step, message: args.message, todos: args.todos, changes: args.changes },
        ctx.userId
      );
    },
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
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, args.taskId, 'task.update');
      return addComment(db, args.taskId, { author: 'agent', body: args.message, anchor: 'general' });
    },
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
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, args.taskId, 'task.update');
      return requestInput(db, args.taskId, args.question, { choices: args.choices, allowCustom: args.allowCustom }, ctx.userId);
    },
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
    handler: (db, ctx, args) => {
      const taskId = getRequestTaskId(db, args.requestId);
      if (taskId) requireTaskAccess(db, ctx, taskId, 'task.update');
      return answerInput(db, args.requestId, args.answer, ctx.userId);
    },
  },
  {
    name: 'gfa_rate_task',
    description: 'Attach a rating to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ID_OR_TASKID,
        rating: freeObject('Rating payload (e.g. { score: 0.9, comment }).'),
      },
      required: ['rating'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return rateTask(db, taskIdOf(args), args.rating, ctx.userId);
    },
  },
  {
    name: 'gfa_import_task',
    description:
      'Adopt work from your current (terminal/CLI) session onto the be10x board as ONE task — "move this to the 10x board". Use this when the human asks to move/adopt/push the work you are doing into be10x. In a single call it files the task in a project and lands it at the phase it is ACTUALLY in, attaching whatever already exists: title, a summary or symptom, a plan, findings as artifacts, and output refs. Capture only what fits the phase — an early idea needs just a title/summary; a task under review needs the plan; work in flight can carry artifacts and refs. Prefer passing real findings as artifacts (HTML). Pass handoff:true to have the board\'s agent CONTINUE the work; omit it to let the human drive from the board. Returns the created task and its board path.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable title for the task.' },
        type: { type: 'string', enum: TYPES, description: 'Task type (default general).' },
        projectKey: {
          type: 'string',
          description: 'File the task under this project (its key from `be10x link`). Omit for a personal task.',
        },
        scope: { type: 'string', enum: SCOPES, description: 'Visibility scope (defaults to project when a projectKey resolves, else personal).' },
        teamId: { type: 'string', description: 'Team id (used when scope="team").' },
        phase: {
          type: 'string',
          enum: IMPORT_PHASES,
          description:
            'Where the work is: idea (just a title/summary → backlog) | researching | plan_review (needs a plan) | ready | in_progress. The task is walked to this phase.',
        },
        summary: { type: 'string', description: 'One-line summary (general tasks). Falls back to the title.' },
        symptom: { type: 'string', description: 'The problem (code-issue tasks). Falls back to summary/title.' },
        content: freeObject('Extra type-specific fields to store on the task.'),
        research: freeObject('Research findings gathered so far (root cause, sources).'),
        plan: { description: 'The plan, if one exists: rich HTML / markdown / { steps, diagram } / { blocks }.' },
        artifacts: {
          type: 'array',
          items: freeObject('An artifact: { kind, title, key, content } — HTML preferred (rendered in a sandbox).'),
          description: 'Visual artifacts to seed (RCA / diagram / finding / suggestion / verification).',
        },
        refs: freeObject('Output references already produced (e.g. { pr, branch }).'),
        severity: { type: 'string', description: 'Priority: low | medium | high (default medium).' },
        handoff: { type: 'boolean', description: 'If true, enqueue a wake so the board agent continues the work (default false).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      if (args.teamId) assertCan(db, ctx.userId, 'task.create', { teamId: args.teamId });
      let projectId = null;
      if (args.projectKey) {
        // Resolved against what THIS user can see, not a bare global key lookup — two accounts can
        // register the same key as separate, unrelated projects (see projects.js registerProject).
        const p = listProjectsForUser(db, ctx.userId).find((proj) => proj.key === args.projectKey);
        if (!p) throw new Error('NO_PROJECT'); // link the repo first: `be10x link`
        projectId = p.id;
      }
      const task = importTask(
        db,
        {
          title: args.title,
          type: args.type,
          scope: args.scope,
          projectId,
          teamId: args.teamId,
          severity: args.severity,
          summary: args.summary,
          symptom: args.symptom,
          content: args.content,
          research: args.research,
          plan: args.plan,
          artifacts: args.artifacts,
          refs: args.refs,
          phase: args.phase,
          source: 'agent-adopt',
        },
        ctx.userId
      );
      let handoff = false;
      if (args.handoff) {
        const reason = handoffReasonForPhase(args.phase || 'idea');
        if (reason) {
          enqueueWake(db, task.id, reason);
          handoff = true;
        }
      }
      return { task, boardPath: `/t/${task.id}/full`, handoff };
    },
  },
  {
    name: 'gfa_post_artifact',
    description:
      'Post a VISUAL artifact to the task so the human sees it directly in the task view. This is the primary way to convey what you found and what you propose — prefer it over long prose. Use it to: explain a root cause (kind:"rca") with a diagram of the failure path, show a flow/architecture/file-structure diagram (kind:"diagram"), report findings (kind:"finding"), propose options/suggestions (kind:"suggestion"), or show verification results (kind:"verification"). content is rich like a plan and HTML is the preferred medium — write real HTML (rendered safely in a sandbox) for diagrams, tables, side-by-side comparisons, annotated mock-ups; markdown or { blocks|html|steps|diagram } also work. Pass a stable "key" to UPDATE an existing artifact (e.g. refine the RCA as you learn) instead of adding duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ID_OR_TASKID,
        kind: { type: 'string', description: 'rca | diagram | finding | suggestion | verification | doc | note' },
        title: { type: 'string', description: 'Short human label for the artifact.' },
        key: { type: 'string', description: 'Stable id; posting the same key updates that artifact instead of adding a new one.' },
        content: freeObject('The artifact body — rich content, HTML preferred (rendered in a sandbox), or markdown / { blocks|html|steps|diagram }.'),
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return postArtifact(db, taskIdOf(args), { key: args.key, kind: args.kind, title: args.title, content: args.content }, ctx.userId);
    },
  },
  {
    name: 'gfa_submit_output',
    description: 'Record output references / artifacts (the "ship" step), e.g. { pr: "https://..." }. Accepts the task id as either `id` or `taskId`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ID_OR_TASKID,
        refs: freeObject('Output artifacts / links.'),
      },
      required: ['refs'],
      additionalProperties: false,
    },
    handler: (db, ctx, args) => {
      requireTaskAccess(db, ctx, taskIdOf(args), 'task.update');
      return setRefs(db, taskIdOf(args), args.refs, ctx.userId);
    },
  },
];

// Convenience lookup shared by the server wiring and tests.
export function getTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}
