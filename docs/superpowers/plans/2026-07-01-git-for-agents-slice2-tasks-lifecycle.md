# Git for Agents — Slice 2: Typed-Task Engine + Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Build the tested task engine — a typed task model over SQLite with a pluggable type registry (content contract + flow + definition-of-done), an explicit lifecycle state machine, an append-only event log, plus replan/retry and self-rating — all as pure core modules (no HTTP/MCP; that's Slice 4).

**Architecture:** Extend the Slice 1 store with `tasks` and `task_events` tables. `types.js` is a registry: each type declares required/optional content fields, a flow, and whether it's agent-executable. `lifecycle.js` is a pure transition map. `tasks.js` ties them together — every mutation validates, updates `tasks`, and appends to `task_events` via `events.js`.

**Tech Stack:** Same as Slice 1 — Node ESM, `better-sqlite3`, `node:crypto`, `node:test`. Reuses Slice 1 modules (`openDb`, `createUser`, `createTeam`) in tests for FK setup.

## Global Constraints

All Slice 1 constraints apply (ESM, `db` first arg, `node --test`, `crypto.randomUUID()`, `Date.now()`, UPPER_SNAKE error codes, Conventional Commits with **NO AI attribution**, one commit per task). Additionally:
- **JSON columns** (`content_json`, `plan_json`, `research_json`, `rating_json`, `refs_json`, `payload_json`) are stored as `JSON.stringify(...)` and parsed on read; nullable columns read back as `null` when unset.
- **`human_id`** is `GFA-NNN`, zero-padded, sequential by task count.
- **Every task mutation appends a `task_events` row** (the append-only history) and bumps `updated_at`.

## File Structure

```
src/db/schema.sql        # + tasks, task_events tables            [Task 1, modify]
src/tasks/events.js      # appendEvent / listEvents               [Task 1]
src/tasks/types.js       # TASK_TYPES / getType / validateContent [Task 2]
src/tasks/lifecycle.js   # STATES / canTransition / assertTransition [Task 3]
src/tasks/tasks.js       # createTask/getTask/listTasks (T4) + mutations (T5) + rating/refs (T6)
test/db.test.js          # updated expected table list            [Task 1, modify]
test/events.test.js  test/types.test.js  test/lifecycle.test.js  test/tasks.test.js
```

---

### Task 1: Extend the store + event log

**Files:** Modify `src/db/schema.sql`, `test/db.test.js`. Create `src/tasks/events.js`, `test/events.test.js`.

**Interfaces:**
- Produces: `appendEvent(db, taskId, actor, kind, payload = {}) → { id, taskId, actor, kind, payload }`; `listEvents(db, taskId) → Array<{ id, actor, kind, payload, createdAt }>` (oldest first, payload parsed).

- [ ] **Step 1: Append the two tables to `src/db/schema.sql`**

```sql

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  human_id      TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('personal','project','team')),
  team_id       TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id    TEXT,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  assignee_id   TEXT REFERENCES users(id),
  reviewer_id   TEXT REFERENCES users(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'medium',
  content_json  TEXT NOT NULL DEFAULT '{}',
  plan_json     TEXT,
  research_json TEXT,
  rating_json   TEXT,
  refs_json     TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
```

- [ ] **Step 2: Update `test/db.test.js` expected table list**

Replace the `assert.deepEqual(tables, [...])` line with:

```js
  assert.deepEqual(tables, ['memberships', 'sessions', 'task_events', 'tasks', 'teams', 'tokens', 'users']);
```

- [ ] **Step 3: Write `test/events.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { appendEvent, listEvents } from '../src/tasks/events.js';

function seedTask(db) {
  const uid = createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, human_id, type, scope, owner_id, title, status, content_json, retry_count, created_at, updated_at)
     VALUES ('t1', 'GFA-001', 'general', 'personal', ?, 'T', 'backlog', '{}', 0, ?, ?)`
  ).run(uid, now, now);
  return 't1';
}

test('appendEvent then listEvents returns events oldest-first with parsed payload', () => {
  const db = openDb(':memory:');
  const tid = seedTask(db);
  appendEvent(db, tid, 'user', 'created', { a: 1 });
  appendEvent(db, tid, 'agent', 'status', { from: 'backlog', to: 'researching' });
  const evs = listEvents(db, tid);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'created');
  assert.deepEqual(evs[0].payload, { a: 1 });
  assert.equal(evs[1].payload.to, 'researching');
});
```

- [ ] **Step 4: Implement `src/tasks/events.js`**

```js
// ABOUTME: Append-only task event log — the activity feed / audit trail behind every task.
import { randomUUID } from 'node:crypto';

export function appendEvent(db, taskId, actor, kind, payload = {}) {
  const id = randomUUID();
  db.prepare('INSERT INTO task_events (id, task_id, actor, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    taskId,
    actor,
    kind,
    JSON.stringify(payload),
    Date.now()
  );
  return { id, taskId, actor, kind, payload };
}

export function listEvents(db, taskId) {
  return db
    .prepare('SELECT id, actor, kind, payload_json AS payload, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY created_at, id')
    .all(taskId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
```

- [ ] **Step 5:** Run `node --test test/db.test.js test/events.test.js` → both pass. **Commit:** `git add src/db/schema.sql test/db.test.js src/tasks/events.js test/events.test.js && git commit -m "feat: add tasks + task_events tables and the append-only event log"`

---

### Task 2: Task type registry

**Files:** Create `src/tasks/types.js`, `test/types.test.js`.

**Interfaces:**
- Produces: `TASK_TYPES` (object); `getType(type) → typeDef` (throws `UNKNOWN_TYPE`); `validateContent(type, content) → true` (throws `MISSING_FIELD:<field>` when a required field is empty).

- [ ] **Step 1: Write `test/types.test.js`**

```js
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
```

- [ ] **Step 2: Implement `src/tasks/types.js`**

```js
// ABOUTME: Task-type registry. Each type is a plugin: required/optional content fields, a flow, and
// ABOUTME: whether the worker may auto-execute it. v1 ships two types: code-issue and general.
export const TASK_TYPES = {
  'code-issue': {
    label: 'Code issue',
    required: ['symptom'],
    optional: ['rootCause', 'solution', 'diagram', 'files'],
    flow: ['research', 'plan', 'implement', 'verify', 'ship'],
    agentExecutable: true,
  },
  general: {
    label: 'General / idea / research',
    required: ['summary'],
    optional: ['proposal', 'rationale', 'findings', 'sources', 'acceptance'],
    flow: ['research', 'plan', 'discuss', 'decide'],
    agentExecutable: false,
  },
};

export function getType(type) {
  const t = TASK_TYPES[type];
  if (!t) throw new Error('UNKNOWN_TYPE');
  return t;
}

export function validateContent(type, content) {
  const t = getType(type);
  for (const field of t.required) {
    const v = content[field];
    if (v === undefined || v === null || v === '') throw new Error('MISSING_FIELD:' + field);
  }
  return true;
}
```

- [ ] **Step 3:** Run `node --test test/types.test.js` → pass. **Commit:** `git add src/tasks/types.js test/types.test.js && git commit -m "feat: add task-type registry with content-contract validation"`

---

### Task 3: Lifecycle state machine

**Files:** Create `src/tasks/lifecycle.js`, `test/lifecycle.test.js`.

**Interfaces:**
- Produces: `STATES` (array); `canTransition(from, to) → boolean`; `assertTransition(from, to) → void` (throws `ILLEGAL_TRANSITION`).

- [ ] **Step 1: Write `test/lifecycle.test.js`**

```js
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
  assert.equal(STATES.length, 11);
});
```

- [ ] **Step 2: Implement `src/tasks/lifecycle.js`**

```js
// ABOUTME: The task lifecycle state machine — legal transitions only. The board is this machine.
export const STATES = [
  'backlog',
  'researching',
  'plan_review',
  'ready_to_work',
  'in_progress',
  'needs_input',
  'verifying',
  'done',
  'blocked',
  'not_a_bug',
  'wont_fix',
];

const TRANSITIONS = {
  backlog: ['researching', 'ready_to_work', 'not_a_bug', 'wont_fix', 'blocked'],
  researching: ['plan_review', 'blocked'],
  plan_review: ['researching', 'ready_to_work', 'not_a_bug', 'wont_fix', 'blocked'],
  ready_to_work: ['in_progress', 'plan_review', 'blocked'],
  in_progress: ['needs_input', 'verifying', 'plan_review', 'blocked'],
  needs_input: ['in_progress', 'blocked'],
  verifying: ['done', 'in_progress', 'plan_review'],
  blocked: ['backlog', 'researching', 'plan_review', 'ready_to_work', 'in_progress'],
  done: [],
  not_a_bug: [],
  wont_fix: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error('ILLEGAL_TRANSITION');
}
```

- [ ] **Step 3:** Run `node --test test/lifecycle.test.js` → pass. **Commit:** `git add src/tasks/lifecycle.js test/lifecycle.test.js && git commit -m "feat: add task lifecycle state machine with legal-transition guard"`

---

### Task 4: Tasks core — create / get / list

**Files:** Create `src/tasks/tasks.js`, `test/tasks.test.js`.

**Interfaces:**
- Consumes: `getType`/`validateContent` (T2), `appendEvent` (T1); `createUser`/`createTeam` (Slice 1) in tests.
- Produces:
  - `createTask(db, { type, scope, title, ownerId, content = {}, teamId = null, projectId = null, severity = 'medium' }) → task` — starts in `backlog`, assigns `human_id`, appends a `created` event.
  - `getTask(db, id) → task | null` — hydrated (camelCase, JSON parsed, nullable fields `null`).
  - `listTasks(db, { scope, teamId, status, ownerId } = {}) → task[]` — filtered, oldest first.
  - A `task` object: `{ id, humanId, type, scope, teamId, projectId, ownerId, assigneeId, reviewerId, title, status, severity, content, plan, research, rating, refs, retryCount, createdAt, updatedAt }`.

- [ ] **Step 1: Write `test/tasks.test.js`** (core section — mutations added in Task 5/6)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTask, getTask, listTasks } from '../src/tasks/tasks.js';

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
```

- [ ] **Step 2: Implement `src/tasks/tasks.js`** (create/get/list + the shared `hydrate`)

```js
// ABOUTME: The task engine — typed tasks over SQLite. Every mutation validates, updates the row,
// ABOUTME: bumps updated_at, and appends a task_events row. Pure core; no HTTP/MCP.
import { randomUUID } from 'node:crypto';
import { getType, validateContent } from './types.js';
import { assertTransition } from './lifecycle.js';
import { appendEvent } from './events.js';

function hydrate(row) {
  return {
    id: row.id,
    humanId: row.human_id,
    type: row.type,
    scope: row.scope,
    teamId: row.team_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    assigneeId: row.assignee_id,
    reviewerId: row.reviewer_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    content: JSON.parse(row.content_json),
    plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    research: row.research_json ? JSON.parse(row.research_json) : null,
    rating: row.rating_json ? JSON.parse(row.rating_json) : null,
    refs: row.refs_json ? JSON.parse(row.refs_json) : null,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextHumanId(db) {
  const c = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  return 'GFA-' + String(c + 1).padStart(3, '0');
}

export function createTask(db, { type, scope, title, ownerId, content = {}, teamId = null, projectId = null, severity = 'medium' }) {
  getType(type);
  validateContent(type, content);
  const id = randomUUID();
  const humanId = nextHumanId(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, human_id, type, scope, team_id, project_id, owner_id, title, status, severity, content_json, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, 0, ?, ?)`
  ).run(id, humanId, type, scope, teamId, projectId, ownerId, title, severity, JSON.stringify(content), now, now);
  appendEvent(db, id, ownerId, 'created', { type, scope, title });
  return getTask(db, id);
}

export function getTask(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function listTasks(db, { scope, teamId, status, ownerId } = {}) {
  const where = [];
  const args = [];
  if (scope) { where.push('scope = ?'); args.push(scope); }
  if (teamId) { where.push('team_id = ?'); args.push(teamId); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (ownerId) { where.push('owner_id = ?'); args.push(ownerId); }
  const sql = 'SELECT * FROM tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at';
  return db.prepare(sql).all(...args).map(hydrate);
}
```

Note: `assertTransition` and `appendEvent` are imported now; used by Task 5's mutations added to this same file.

- [ ] **Step 3:** Run `node --test test/tasks.test.js` → pass. **Commit:** `git add src/tasks/tasks.js test/tasks.test.js && git commit -m "feat: add task create/get/list with typed content and human ids"`

---

### Task 5: Task mutations — research / plan / content / transition / retry

**Files:** Modify `src/tasks/tasks.js`, `test/tasks.test.js`.

**Interfaces:**
- Produces (append to `tasks.js`):
  - `setResearch(db, id, research, actor) → task` (event `research`).
  - `setPlan(db, id, plan, actor) → task` (event `plan`; also used for replan).
  - `updateContent(db, id, patch, actor) → task` (merges patch into content; event `content`; throws `NO_TASK`).
  - `transition(db, id, to, actor, meta = {}) → task` (guards via `assertTransition`; event `status` with `{from,to}`; throws `NO_TASK`).
  - `retryTask(db, id, actor) → task` (increments `retryCount`; event `retry`).

- [ ] **Step 1: Append tests to `test/tasks.test.js`**

```js
import { setResearch, setPlan, updateContent, transition, retryTask } from '../src/tasks/tasks.js';
import { listEvents } from '../src/tasks/events.js';

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
```

- [ ] **Step 2: Append implementations to `src/tasks/tasks.js`**

```js

export function setResearch(db, id, research, actor) {
  db.prepare('UPDATE tasks SET research_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(research), Date.now(), id);
  appendEvent(db, id, actor, 'research', { research });
  return getTask(db, id);
}

export function setPlan(db, id, plan, actor) {
  db.prepare('UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), Date.now(), id);
  appendEvent(db, id, actor, 'plan', { plan });
  return getTask(db, id);
}

export function updateContent(db, id, patch, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const merged = { ...task.content, ...patch };
  db.prepare('UPDATE tasks SET content_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), Date.now(), id);
  appendEvent(db, id, actor, 'content', { patch });
  return getTask(db, id);
}

export function transition(db, id, to, actor, meta = {}) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  assertTransition(task.status, to);
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, Date.now(), id);
  appendEvent(db, id, actor, 'status', { from: task.status, to, ...meta });
  return getTask(db, id);
}

export function retryTask(db, id, actor) {
  const task = getTask(db, id);
  if (!task) throw new Error('NO_TASK');
  const n = task.retryCount + 1;
  db.prepare('UPDATE tasks SET retry_count = ?, updated_at = ? WHERE id = ?').run(n, Date.now(), id);
  appendEvent(db, id, actor, 'retry', { retryCount: n });
  return getTask(db, id);
}
```

- [ ] **Step 3:** Run `node --test test/tasks.test.js` → pass. **Commit:** `git add src/tasks/tasks.js test/tasks.test.js && git commit -m "feat: add task mutations (research, plan/replan, content, transition, retry)"`

---

### Task 6: Self-rating + refs + end-to-end lifecycle walk

**Files:** Modify `src/tasks/tasks.js`, `test/tasks.test.js`.

**Interfaces:**
- Produces (append to `tasks.js`):
  - `rateTask(db, id, rating, actor) → task` (event `rating`).
  - `setRefs(db, id, refs, actor) → task` (ship/output refs; event `ship`).

- [ ] **Step 1: Append tests to `test/tasks.test.js`** (including the DoD full-lifecycle walk)

```js
import { rateTask, setRefs } from '../src/tasks/tasks.js';

test('rateTask and setRefs attach data and log events', () => {
  const db = openDb(':memory:');
  const uid = owner(db);
  const t = createTask(db, { type: 'code-issue', scope: 'personal', title: 'Bug', ownerId: uid, content: { symptom: 'x' } });
  assert.deepEqual(rateTask(db, t.id, { score: 0.9 }, 'agent').rating, { score: 0.9 });
  assert.deepEqual(setRefs(db, t.id, { pr: 'http://x/1' }, 'agent').refs, { pr: 'http://x/1' });
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
```

- [ ] **Step 2: Append implementations to `src/tasks/tasks.js`**

```js

export function rateTask(db, id, rating, actor) {
  db.prepare('UPDATE tasks SET rating_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rating), Date.now(), id);
  appendEvent(db, id, actor, 'rating', { rating });
  return getTask(db, id);
}

export function setRefs(db, id, refs, actor) {
  db.prepare('UPDATE tasks SET refs_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(refs), Date.now(), id);
  appendEvent(db, id, actor, 'ship', { refs });
  return getTask(db, id);
}
```

- [ ] **Step 3:** Run the whole suite `node --test test/*.test.js` → all pass. **Commit:** `git add src/tasks/tasks.js test/tasks.test.js && git commit -m "feat: add task self-rating and ship/output refs"`

---

## Slice 2 Definition of Done

Create a typed task (validated against its type's content contract), attach research + a plan (and replan), move it through every legal lifecycle state (illegal moves rejected), pause/resume via `needs_input`, retry, self-rate, and record ship/output refs — with every mutation captured in the append-only `task_events` log. All over an in-memory SQLite DB, no HTTP/MCP. Pairs with Slice 1's auth/teams so tasks can be scoped and owned.
