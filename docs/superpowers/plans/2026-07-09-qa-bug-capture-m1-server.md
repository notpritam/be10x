# QA Bug Capture — M1 (Server `bugs` module) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side `bugs` module to be10x — a bug ticket created by the QA extension's Bearer-authenticated ingest call, browsable/resolvable via session-authenticated dashboard routes, with capture artifacts stored on UploadThing (be10x mints signed upload URLs; it never receives the binaries).

**Architecture:** A new pure-core domain module (`src/bugs/bugs.js`) over SQLite following the exact `src/tasks/tasks.js` pattern (db-first functions, `hydrate` snake→camel, `randomUUID()` + `Date.now()`), a zero-dependency UploadThing signer (`src/bugs/uploadthing.js`) using only `node:crypto`, and thin HTTP routes added to `src/http/server.js` (`AGENT_ROUTES` for Bearer ingest + upload-url minting, `ROUTES` for session list/detail/status/comment/stats). This is the curl-verifiable foundation; the extension (M2) and dashboard (M3) build on it.

**Tech Stack:** Node 18+ ESM (plain JS), `better-sqlite3`, Node built-in `http` + `crypto`, `node --test`. UploadThing v7 (signed ingest URLs generated locally from `UPLOADTHING_TOKEN`).

## Global Constraints

- **Language:** plain JavaScript, ESM (`import`/`export`, `.js` extensions). No TypeScript in `src/`.
- **Zero new runtime dependencies.** UploadThing is accessed via `node:crypto` HMAC + the built-in URL — do NOT add the `uploadthing` npm package to the server.
- **File header:** every new source file starts with two `// ABOUTME:` lines.
- **Architecture boundary:** pure core in `src/bugs/*` (functions take `db` first, return plain objects, no `res`/HTTP); HTTP lives only in `src/http/server.js`.
- **Errors:** throw `new Error('CODE')`; `statusFor()` in `server.js` maps it. Reuse existing codes — `NOT_FOUND` → 404, `MISSING_FIELD:<x>` → 400. Do NOT invent codes `statusFor` doesn't know (they become 400).
- **Tests:** `node --test`, files in `test/*.test.js`, real `openDb(':memory:')`, `node:assert/strict`. No mocks of the DB.
- **Timestamps:** integer epoch-ms via `Date.now()`. **IDs:** `randomUUID()`.
- **Route ordering:** in `ROUTES`, register `GET /api/bugs/stats` BEFORE `GET /api/bugs/:id` — `match()` compares segment counts only, so `:id` would otherwise capture the literal `stats`.
- **Body cap:** the ingest payload is keys + small JSON metadata (well under the 2 MB `readJson` cap). Do NOT send screenshot/DOM/network bytes to be10x.

---

### Task 1: `bugs` + `bug_events` schema and `createBug` / `getBug`

**Files:**
- Modify: `src/db/schema.sql` (append at end)
- Create: `src/bugs/bugs.js`
- Test: `test/bugs.test.js`

**Interfaces:**
- Consumes: `openDb` from `../src/db/db.js`; `createUser` from `../src/auth/users.js` (`createUser(db, { email, displayName, password }) -> { id, ... }`).
- Produces:
  - `createBug(db, { reporterId, pageUrl, title, description?, severity?, projectId?, teamId?, screenshotKey?, domKey?, networkKey?, identity?, meta? }) -> bug`
  - `getBug(db, id) -> bug | null`
  - `bug` shape: `{ id, humanId, reporterId, projectId, teamId, pageUrl, title, description, status, severity, assigneeId, resolution, screenshotKey, domKey, networkKey, identity, meta, createdAt, updatedAt }`
  - Constants `VALID_STATUS = ['open','in_progress','resolved','not_a_bug','wont_fix']`, `VALID_SEVERITY = ['low','medium','high','critical']`

- [ ] **Step 1: Write the failing test**

Create `test/bugs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug, getBug } from '../src/bugs/bugs.js';

function seedUser(db, email = 'qa@b.co') {
  return createUser(db, { email, displayName: 'QA', password: 'pw12345' });
}

test('createBug stores a bug and getBug hydrates it', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const bug = createBug(db, {
    reporterId: u.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    description: 'Nothing happens on click',
    severity: 'high',
    screenshotKey: 'k-shot',
    domKey: 'k-dom',
    networkKey: 'k-net',
    identity: { loggedIn: true, email: 'buyer@x.co' },
    meta: { selector: '#pay', viewport: { w: 1440, h: 900 } },
  });
  assert.equal(bug.humanId, 'BUG-001');
  assert.equal(bug.status, 'open');
  assert.equal(bug.severity, 'high');
  assert.equal(bug.reporterId, u.id);
  assert.equal(bug.pageUrl, 'https://app.example.com/checkout');
  assert.equal(bug.identity.email, 'buyer@x.co');
  assert.equal(bug.meta.selector, '#pay');
  const got = getBug(db, bug.id);
  assert.equal(got.title, 'Pay button dead');
  assert.equal(getBug(db, 'nope'), null);
});

test('createBug rejects an unknown severity', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  assert.throws(
    () => createBug(db, { reporterId: u.id, pageUrl: 'x', title: 't', severity: 'spicy' }),
    /INVALID_SEVERITY/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/bugs.test.js`
Expected: FAIL — `Cannot find module '../src/bugs/bugs.js'`.

- [ ] **Step 3: Append the schema**

Append to `src/db/schema.sql`:

```sql

CREATE TABLE IF NOT EXISTS bugs (
  id             TEXT PRIMARY KEY,
  human_id       TEXT NOT NULL UNIQUE,
  reporter_id    TEXT NOT NULL REFERENCES users(id),
  project_id     TEXT,
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL,
  page_url       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','resolved','not_a_bug','wont_fix')),
  severity       TEXT NOT NULL DEFAULT 'medium'
                   CHECK (severity IN ('low','medium','high','critical')),
  assignee_id    TEXT REFERENCES users(id),
  resolution     TEXT,
  screenshot_key TEXT,
  dom_key        TEXT,
  network_key    TEXT,
  identity_json  TEXT NOT NULL DEFAULT '{}',
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bugs_reporter ON bugs (reporter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bugs_status   ON bugs (status, created_at);

CREATE TABLE IF NOT EXISTS bug_events (
  id           TEXT PRIMARY KEY,
  bug_id       TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bug_events_bug ON bug_events (bug_id, created_at);
```

- [ ] **Step 4: Write the module**

Create `src/bugs/bugs.js`:

```js
// ABOUTME: The QA bug store — bug tickets filed by the capture extension, over SQLite. Every mutation
// ABOUTME: bumps updated_at and appends a bug_events row. Pure core; no HTTP. Mirrors src/tasks/tasks.js.
import { randomUUID } from 'node:crypto';

export const VALID_STATUS = ['open', 'in_progress', 'resolved', 'not_a_bug', 'wont_fix'];
export const VALID_SEVERITY = ['low', 'medium', 'high', 'critical'];

function hydrate(row) {
  return {
    id: row.id,
    humanId: row.human_id,
    reporterId: row.reporter_id,
    projectId: row.project_id,
    teamId: row.team_id,
    pageUrl: row.page_url,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    assigneeId: row.assignee_id,
    resolution: row.resolution,
    screenshotKey: row.screenshot_key,
    domKey: row.dom_key,
    networkKey: row.network_key,
    identity: JSON.parse(row.identity_json),
    meta: JSON.parse(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextBugHumanId(db) {
  const c = db.prepare('SELECT COUNT(*) AS c FROM bugs').get().c;
  return 'BUG-' + String(c + 1).padStart(3, '0');
}

export function appendBugEvent(db, bugId, actor, kind, payload = {}) {
  if (!bugId) throw new Error('NOT_FOUND');
  const id = randomUUID();
  db.prepare(
    'INSERT INTO bug_events (id, bug_id, actor, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, bugId, actor, kind, JSON.stringify(payload), Date.now());
  return { id, bugId, actor, kind, payload };
}

export function createBug(db, spec = {}) {
  const {
    reporterId,
    pageUrl,
    title,
    description = '',
    severity = 'medium',
    projectId = null,
    teamId = null,
    screenshotKey = null,
    domKey = null,
    networkKey = null,
    identity = {},
    meta = {},
  } = spec;
  if (!reporterId) throw new Error('MISSING_FIELD:reporterId');
  if (!pageUrl) throw new Error('MISSING_FIELD:pageUrl');
  if (!title) throw new Error('MISSING_FIELD:title');
  if (!VALID_SEVERITY.includes(severity)) throw new Error('INVALID_SEVERITY');
  const id = randomUUID();
  const humanId = nextBugHumanId(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO bugs (id, human_id, reporter_id, project_id, team_id, page_url, title, description,
       status, severity, screenshot_key, dom_key, network_key, identity_json, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, humanId, reporterId, projectId, teamId, pageUrl, title, description,
    severity, screenshotKey, domKey, networkKey, JSON.stringify(identity), JSON.stringify(meta), now, now
  );
  appendBugEvent(db, id, reporterId, 'created', { title, severity, pageUrl });
  return getBug(db, id);
}

export function getBug(db, id) {
  const row = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/bugs.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/bugs/bugs.js test/bugs.test.js
git commit -m "feat(bugs): bugs + bug_events schema, createBug/getBug"
```

---

### Task 2: `listBugs` with filters

**Files:**
- Modify: `src/bugs/bugs.js`
- Test: `test/bugs.test.js`

**Interfaces:**
- Produces: `listBugs(db, { status?, reporterId? } = {}) -> bug[]` (newest first).

- [ ] **Step 1: Write the failing test**

Append to `test/bugs.test.js`:

```js
import { listBugs } from '../src/bugs/bugs.js';

test('listBugs returns newest-first and filters by status and reporter', () => {
  const db = openDb(':memory:');
  const a = seedUser(db, 'a@b.co');
  const b = seedUser(db, 'b@b.co');
  const b1 = createBug(db, { reporterId: a.id, pageUrl: 'p1', title: 'one' });
  const b2 = createBug(db, { reporterId: b.id, pageUrl: 'p2', title: 'two' });
  const all = listBugs(db);
  assert.deepEqual(all.map((x) => x.id), [b2.id, b1.id]); // newest first
  assert.equal(listBugs(db, { reporterId: a.id }).length, 1);
  assert.equal(listBugs(db, { reporterId: a.id })[0].title, 'one');
  assert.equal(listBugs(db, { status: 'resolved' }).length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/bugs.test.js`
Expected: FAIL — `listBugs` is not exported.

- [ ] **Step 3: Add `listBugs`**

Append to `src/bugs/bugs.js`:

```js
export function listBugs(db, { status, reporterId } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (reporterId) { where.push('reporter_id = ?'); args.push(reporterId); }
  const sql =
    'SELECT * FROM bugs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...args).map(hydrate);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/bugs.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bugs/bugs.js test/bugs.test.js
git commit -m "feat(bugs): listBugs with status/reporter filters"
```

---

### Task 3: `updateBugStatus`, `addBugComment`, `listBugEvents`

**Files:**
- Modify: `src/bugs/bugs.js`
- Test: `test/bugs.test.js`

**Interfaces:**
- Produces:
  - `updateBugStatus(db, id, status, actor, { resolution? } = {}) -> bug` (throws `NOT_FOUND` if no bug, `INVALID_STATUS` if not in `VALID_STATUS`).
  - `addBugComment(db, id, actor, body) -> event` (throws `NOT_FOUND` if no bug).
  - `listBugEvents(db, id) -> event[]` (oldest first; `{ id, actor, kind, payload, createdAt }`).

- [ ] **Step 1: Write the failing test**

Append to `test/bugs.test.js`:

```js
import { updateBugStatus, addBugComment, listBugEvents } from '../src/bugs/bugs.js';

test('updateBugStatus transitions and records resolution + event', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const dev = seedUser(db, 'dev@b.co');
  const bug = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 't' });
  const moved = updateBugStatus(db, bug.id, 'in_progress', dev.id);
  assert.equal(moved.status, 'in_progress');
  const done = updateBugStatus(db, bug.id, 'resolved', dev.id, { resolution: 'fixed in #42' });
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolution, 'fixed in #42');
  assert.ok(done.updatedAt >= bug.updatedAt);
  assert.throws(() => updateBugStatus(db, bug.id, 'banana', dev.id), /INVALID_STATUS/);
  assert.throws(() => updateBugStatus(db, 'nope', 'resolved', dev.id), /NOT_FOUND/);
});

test('addBugComment and listBugEvents record the trail', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const bug = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 't' });
  addBugComment(db, bug.id, u.id, 'still broken on staging');
  updateBugStatus(db, bug.id, 'in_progress', u.id);
  const events = listBugEvents(db, bug.id);
  assert.equal(events[0].kind, 'created');
  assert.equal(events[1].kind, 'comment');
  assert.equal(events[1].payload.body, 'still broken on staging');
  assert.equal(events[2].kind, 'status');
  assert.equal(events[2].payload.to, 'in_progress');
  assert.throws(() => addBugComment(db, 'nope', u.id, 'x'), /NOT_FOUND/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/bugs.test.js`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Add the mutations**

Append to `src/bugs/bugs.js`:

```js
export function updateBugStatus(db, id, status, actor, { resolution } = {}) {
  const bug = getBug(db, id);
  if (!bug) throw new Error('NOT_FOUND');
  if (!VALID_STATUS.includes(status)) throw new Error('INVALID_STATUS');
  const now = Date.now();
  if (resolution !== undefined) {
    db.prepare('UPDATE bugs SET status = ?, resolution = ?, updated_at = ? WHERE id = ?')
      .run(status, resolution, now, id);
  } else {
    db.prepare('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }
  appendBugEvent(db, id, actor, 'status', { from: bug.status, to: status, resolution: resolution ?? null });
  return getBug(db, id);
}

export function addBugComment(db, id, actor, body) {
  if (!getBug(db, id)) throw new Error('NOT_FOUND');
  db.prepare('UPDATE bugs SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  return appendBugEvent(db, id, actor, 'comment', { body: String(body ?? '') });
}

export function listBugEvents(db, id) {
  return db
    .prepare('SELECT id, actor, kind, payload_json AS payload, created_at AS createdAt FROM bug_events WHERE bug_id = ? ORDER BY rowid')
    .all(id)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/bugs.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bugs/bugs.js test/bugs.test.js
git commit -m "feat(bugs): updateBugStatus, addBugComment, listBugEvents"
```

---

### Task 4: `bugStatsForUser`

**Files:**
- Modify: `src/bugs/bugs.js`
- Test: `test/bugs.test.js`

**Interfaces:**
- Produces: `bugStatsForUser(db, userId) -> { reported, resolved, open }` (`resolved` counts status `resolved`; `open` counts everything not in a closed state — closed = `resolved`/`not_a_bug`/`wont_fix`).

- [ ] **Step 1: Write the failing test**

Append to `test/bugs.test.js`:

```js
import { bugStatsForUser } from '../src/bugs/bugs.js';

test('bugStatsForUser counts reported / resolved / open', () => {
  const db = openDb(':memory:');
  const u = seedUser(db);
  const other = seedUser(db, 'o@b.co');
  const b1 = createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'a' });
  createBug(db, { reporterId: u.id, pageUrl: 'p', title: 'b' });
  createBug(db, { reporterId: other.id, pageUrl: 'p', title: 'c' });
  updateBugStatus(db, b1.id, 'resolved', u.id);
  const s = bugStatsForUser(db, u.id);
  assert.deepEqual(s, { reported: 2, resolved: 1, open: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/bugs.test.js`
Expected: FAIL — `bugStatsForUser` not exported.

- [ ] **Step 3: Add the stat query**

Append to `src/bugs/bugs.js`:

```js
export function bugStatsForUser(db, userId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS reported,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
         SUM(CASE WHEN status IN ('resolved','not_a_bug','wont_fix') THEN 0 ELSE 1 END) AS open
       FROM bugs WHERE reporter_id = ?`
    )
    .get(userId);
  return { reported: row.reported, resolved: row.resolved || 0, open: row.open || 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/bugs.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bugs/bugs.js test/bugs.test.js
git commit -m "feat(bugs): bugStatsForUser rollup"
```

---

### Task 5: HTTP routes — Bearer ingest + session list/detail/status/comment/stats

**Files:**
- Modify: `src/http/server.js` (add imports near line 19–20; add session routes into `ROUTES`; add the ingest route into `AGENT_ROUTES`)
- Test: `test/bugs-http.test.js`

**Interfaces:**
- Consumes: `createBug, getBug, listBugs, updateBugStatus, addBugComment, listBugEvents, bugStatsForUser` from `../bugs/bugs.js`.
- Produces HTTP:
  - `POST /api/agent/bugs` (Bearer) → `{ bug }` — reporter = `auth.userId`.
  - `GET /api/bugs?status=&reporterId=` (session) → `{ bugs }`.
  - `GET /api/bugs/stats` (session) → `{ stats }` for the calling user. **Registered before `/api/bugs/:id`.**
  - `GET /api/bugs/:id` (session) → `{ bug, events }` (404 `NOT_FOUND` if missing).
  - `POST /api/bugs/:id/status` (session) `{ status, resolution? }` → `{ bug }`.
  - `POST /api/bugs/:id/comment` (session) `{ body }` → `{ event }`.

- [ ] **Step 1: Write the failing HTTP test**

Create `test/bugs-http.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function json(res) {
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signup(base, email = 'qa@b.co') {
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'QA', password: 'pw12345' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const body = await res.json();
  return { cookie, userId: body.user.id };
}

async function mintToken(base, cookie) {
  const res = await fetch(base + '/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'extension' }),
  });
  return (await res.json()).token.token; // gfa_...
}

test('extension ingests a bug (Bearer); dashboard lists, reads, resolves it (session)', async () => {
  await withServer(async (base) => {
    const { cookie, userId } = await signup(base);
    const token = await mintToken(base, cookie);

    // Ingest as the extension would — Bearer token, keys + metadata only.
    const ingest = await json(
      await fetch(base + '/api/agent/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          pageUrl: 'https://app.example.com/x',
          title: 'Broken',
          description: 'oops',
          severity: 'high',
          screenshotKey: 'k1',
          domKey: 'k2',
          networkKey: 'k3',
          identity: { loggedIn: true, email: 'buyer@x.co' },
          meta: { selector: '#pay' },
        }),
      })
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.bug.humanId, 'BUG-001');
    assert.equal(ingest.body.bug.reporterId, userId);
    const bugId = ingest.body.bug.id;

    // A bad token is rejected.
    const bad = await fetch(base + '/api/agent/bugs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ pageUrl: 'x', title: 't' }),
    });
    assert.equal(bad.status, 401);

    // Dashboard: list (session cookie).
    const list = await json(await fetch(base + '/api/bugs', { headers: { cookie } }));
    assert.equal(list.body.bugs.length, 1);
    assert.equal(list.body.bugs[0].id, bugId);

    // Dashboard: detail with events.
    const detail = await json(await fetch(base + '/api/bugs/' + bugId, { headers: { cookie } }));
    assert.equal(detail.body.bug.title, 'Broken');
    assert.equal(detail.body.events[0].kind, 'created');

    // Dashboard: resolve.
    const resolved = await json(
      await fetch(base + '/api/bugs/' + bugId + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ status: 'resolved', resolution: 'fixed' }),
      })
    );
    assert.equal(resolved.body.bug.status, 'resolved');

    // Stats for the reporter (route must resolve before /:id).
    const stats = await json(await fetch(base + '/api/bugs/stats', { headers: { cookie } }));
    assert.deepEqual(stats.body.stats, { reported: 1, resolved: 1, open: 0 });

    // Listing requires a session.
    const noAuth = await fetch(base + '/api/bugs');
    assert.equal(noAuth.status, 401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/bugs-http.test.js`
Expected: FAIL — routes 404 (ingest returns 404 `NOT_FOUND`, list returns 404), assertions fail.

- [ ] **Step 3: Add the imports**

In `src/http/server.js`, immediately after the existing tasks import (line ~19), add:

```js
import { createBug, getBug as getBugById, listBugs, updateBugStatus, addBugComment, listBugEvents, bugStatsForUser } from '../bugs/bugs.js';
```

(Alias `getBug` → `getBugById` to avoid colliding with the imported task `getTask`; there is no `getBug` symbol in scope, but the alias keeps intent explicit.)

- [ ] **Step 4: Add the session routes into `ROUTES`**

Insert these four routes into the `ROUTES` array (e.g. right after the `/api/leaderboard` route, before the closing `];` at line ~631–632). **Keep `stats` before `:id`.**

```js
  // --- QA bug capture (dashboard side; session auth) -------------------------------------------------
  ['GET', '/api/bugs', true, async ({ db, req, res }) => {
    const q = new URL(req.url, 'http://x').searchParams;
    send(res, 200, { bugs: listBugs(db, { status: q.get('status') || undefined, reporterId: q.get('reporterId') || undefined }) });
  }],
  ['GET', '/api/bugs/stats', true, async ({ db, res, user }) => send(res, 200, { stats: bugStatsForUser(db, user.id) })],
  ['GET', '/api/bugs/:id', true, async ({ db, res, params }) => {
    const bug = getBugById(db, params.id);
    if (!bug) throw new Error('NOT_FOUND');
    send(res, 200, { bug, events: listBugEvents(db, params.id) });
  }],
  ['POST', '/api/bugs/:id/status', true, async ({ db, res, params, body, user }) => {
    send(res, 200, { bug: updateBugStatus(db, params.id, body.status, user.id, { resolution: body.resolution }) });
  }],
  ['POST', '/api/bugs/:id/comment', true, async ({ db, res, params, body, user }) => {
    send(res, 200, { event: addBugComment(db, params.id, user.id, body.body) });
  }],
```

- [ ] **Step 5: Add the Bearer ingest route into `AGENT_ROUTES`**

Insert into the `AGENT_ROUTES` array (e.g. after the `/api/agent/rpc` route, ~line 648):

```js
  // The QA capture extension files a bug. Bearer-authed, so the reporter is the token's user. Payload is
  // UploadThing keys + small metadata only (binaries go straight to UploadThing, never through here).
  ['POST', '/api/agent/bugs', async ({ db, res, body, auth }) => {
    const bug = createBug(db, {
      reporterId: auth.userId,
      pageUrl: body.pageUrl,
      title: body.title,
      description: body.description,
      severity: body.severity,
      projectId: body.projectId,
      teamId: body.teamId,
      screenshotKey: body.screenshotKey,
      domKey: body.domKey,
      networkKey: body.networkKey,
      identity: body.identity || {},
      meta: body.meta || {},
    });
    send(res, 200, { bug });
  }],
```

- [ ] **Step 6: Run the HTTP test to verify it passes**

Run: `node --test test/bugs-http.test.js`
Expected: PASS.

- [ ] **Step 7: Run the whole suite (no regressions)**

Run: `npm test`
Expected: all existing tests still pass, plus the new bug tests.

- [ ] **Step 8: Commit**

```bash
git add src/http/server.js test/bugs-http.test.js
git commit -m "feat(bugs): HTTP ingest (Bearer) + dashboard list/detail/status/comment/stats"
```

---

### Task 6: UploadThing signed-URL minting (`src/bugs/uploadthing.js`) + mint route

**Files:**
- Create: `src/bugs/uploadthing.js`
- Modify: `src/http/server.js` (import + one `AGENT_ROUTES` entry)
- Test: `test/uploadthing.test.js`
- Modify: `.env.example` (document `UPLOADTHING_TOKEN`)

**Interfaces:**
- Produces:
  - `parseUploadThingToken(raw) -> { apiKey, appId, regions }` (throws `MISSING_FIELD:UPLOADTHING_TOKEN` if absent/invalid).
  - `mintUploadUrls(files, opts?) -> { key, uploadUrl, fileUrl, name }[]` where `files` is `[{ name, size, type }]`. `opts = { token?, now?, makeKey?, expiresInMs? }` (all injectable for tests; defaults read `process.env.UPLOADTHING_TOKEN`, `Date.now()`, a `randomUUID()`-based key, 1 h).
- HTTP: `POST /api/agent/bugs/upload-urls` (Bearer) `{ files: [{name,size,type}] }` → `{ uploads: [{ key, uploadUrl, fileUrl, name }] }`.

**Note on the UploadThing v7 contract (confirm live in Step 6):** `UPLOADTHING_TOKEN` is base64-encoded JSON `{ apiKey, appId, regions }`. A presigned upload URL is built **locally** (no round-trip): `https://<region>.ingest.uploadthing.com/<fileKey>` with query params `expires`, `x-ut-identifier=<appId>`, `x-ut-file-name`, `x-ut-file-size`, `x-ut-file-type`, then a `signature=hmac-sha256=<HMAC_SHA256(fullUrl, apiKey)>` param appended. The client PUTs the file (as `FormData`) to that URL. `x-ut-slug` is omitted for server-generated/custom uploads. Files are private (no `x-ut-acl=public-read`); the dashboard signs read access in M3.

- [ ] **Step 1: Write the failing test**

Create `test/uploadthing.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseUploadThingToken, mintUploadUrls } from '../src/bugs/uploadthing.js';

const TOKEN = Buffer.from(
  JSON.stringify({ apiKey: 'sk_test_abc', appId: 'app123', regions: ['sea1'] })
).toString('base64');

test('parseUploadThingToken decodes the base64 JSON', () => {
  const t = parseUploadThingToken(TOKEN);
  assert.equal(t.apiKey, 'sk_test_abc');
  assert.equal(t.appId, 'app123');
  assert.deepEqual(t.regions, ['sea1']);
  assert.throws(() => parseUploadThingToken(''), /MISSING_FIELD:UPLOADTHING_TOKEN/);
});

test('mintUploadUrls builds a signed ingest URL per file', () => {
  const out = mintUploadUrls(
    [{ name: 'shot.png', size: 1234, type: 'image/png' }],
    { token: TOKEN, now: 1000, makeKey: () => 'KEY1', expiresInMs: 60000 }
  );
  assert.equal(out.length, 1);
  const u = out[0];
  assert.equal(u.key, 'KEY1');
  assert.equal(u.name, 'shot.png');
  assert.equal(u.fileUrl, 'https://app123.ufs.sh/f/KEY1');

  const url = new URL(u.uploadUrl);
  assert.equal(url.origin, 'https://sea1.ingest.uploadthing.com');
  assert.equal(url.pathname, '/KEY1');
  assert.equal(url.searchParams.get('x-ut-identifier'), 'app123');
  assert.equal(url.searchParams.get('x-ut-file-name'), 'shot.png');
  assert.equal(url.searchParams.get('x-ut-file-size'), '1234');
  assert.equal(url.searchParams.get('expires'), String(1000 + 60000));

  // Signature is HMAC-SHA256 of the URL *without* the signature param, keyed by apiKey.
  const sig = url.searchParams.get('signature');
  url.searchParams.delete('signature');
  const expected = 'hmac-sha256=' + createHmac('sha256', 'sk_test_abc').update(url.toString()).digest('hex');
  assert.equal(sig, expected);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/uploadthing.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the signer**

Create `src/bugs/uploadthing.js`:

```js
// ABOUTME: UploadThing v7 signer — builds presigned ingest URLs locally from UPLOADTHING_TOKEN using only
// ABOUTME: node:crypto (no SDK). The extension PUTs bytes straight to UploadThing; be10x only stores keys.
import { randomUUID, createHmac } from 'node:crypto';

export function parseUploadThingToken(raw = process.env.UPLOADTHING_TOKEN) {
  if (!raw) throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  }
  if (!parsed || !parsed.apiKey || !parsed.appId) throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  return { apiKey: parsed.apiKey, appId: parsed.appId, regions: parsed.regions || ['sea1'] };
}

function signedUrl({ region, key, apiKey, params }) {
  const url = new URL(`https://${region}.ingest.uploadthing.com/${key}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const signature = 'hmac-sha256=' + createHmac('sha256', apiKey).update(url.toString()).digest('hex');
  url.searchParams.set('signature', signature);
  return url.toString();
}

export function mintUploadUrls(files, opts = {}) {
  const { apiKey, appId, regions } = parseUploadThingToken(opts.token);
  const region = regions[0] || 'sea1';
  const now = opts.now ?? Date.now();
  const makeKey = opts.makeKey ?? (() => randomUUID().replace(/-/g, ''));
  const expiresInMs = opts.expiresInMs ?? 60 * 60 * 1000;
  return (files || []).map((f) => {
    const key = makeKey(f);
    const uploadUrl = signedUrl({
      region,
      key,
      apiKey,
      params: {
        expires: now + expiresInMs,
        'x-ut-identifier': appId,
        'x-ut-file-name': f.name,
        'x-ut-file-size': f.size,
        'x-ut-file-type': f.type || 'application/octet-stream',
      },
    });
    return { key, uploadUrl, fileUrl: `https://${appId}.ufs.sh/f/${key}`, name: f.name };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/uploadthing.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the mint route + import**

In `src/http/server.js`, add the import beside the bugs import from Task 5:

```js
import { mintUploadUrls } from '../bugs/uploadthing.js';
```

Add into `AGENT_ROUTES` (right after the `/api/agent/bugs` ingest route):

```js
  // The extension asks for signed URLs, then PUTs each artifact directly to UploadThing.
  ['POST', '/api/agent/bugs/upload-urls', async ({ res, body }) => {
    const files = Array.isArray(body.files) ? body.files : [];
    send(res, 200, { uploads: mintUploadUrls(files) });
  }],
```

- [ ] **Step 6: Document the env var + confirm the live contract**

Add to `.env.example`:

```
# UploadThing v7 app token (base64 { apiKey, appId, regions }) — QA bug-capture artifact storage.
UPLOADTHING_TOKEN=
```

Then confirm the signing contract against a real bucket (this is the one external unknown):

```bash
# With a real token exported, mint a URL and PUT a tiny file. Adjust the signer only if UploadThing rejects it.
UPLOADTHING_TOKEN=<real> node -e "import('./src/bugs/uploadthing.js').then(async m => {
  const [u] = m.mintUploadUrls([{ name: 'ping.txt', size: 4, type: 'text/plain' }]);
  const fd = new FormData();
  fd.append('file', new Blob(['ping'], { type: 'text/plain' }), 'ping.txt');
  const r = await fetch(u.uploadUrl, { method: 'PUT', body: fd });
  console.log('status', r.status, 'key', u.key, 'fileUrl', u.fileUrl);
})"
```

Expected: HTTP 2xx and the file readable at its `fileUrl`. If UploadThing returns a signature/format error, adjust `signedUrl()` (param names / which URL string is signed) per the current UploadThing "Uploading Files → generating presigned URLs" docs, and re-run — the unit test pins whatever shape we settle on.

- [ ] **Step 7: Commit**

```bash
git add src/bugs/uploadthing.js test/uploadthing.test.js src/http/server.js .env.example
git commit -m "feat(bugs): UploadThing signed upload-URL minting + route"
```

---

## Manual verification (end of M1)

With the server running (`node bin/be10x.js serve`) and a signed-in account:

1. Mint a personal token in the dashboard (or `be10x token`).
2. `curl` the full loop:
   ```bash
   TOKEN=gfa_...   # your token
   BASE=http://localhost:4600
   # a) signed upload URLs
   curl -s -X POST $BASE/api/agent/bugs/upload-urls -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"files":[{"name":"shot.png","size":10,"type":"image/png"}]}'
   # b) file a bug (keys would come from the PUT responses)
   curl -s -X POST $BASE/api/agent/bugs -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"pageUrl":"https://x/y","title":"Test bug","severity":"high","screenshotKey":"k1"}'
   ```
3. In a browser signed into the board, `GET /api/bugs` and `GET /api/bugs/<id>` return the bug + events; `POST /api/bugs/<id>/status {"status":"resolved"}` closes it; `GET /api/bugs/stats` reflects it.
4. Confirm the UploadThing round-trip from Task 6, Step 6.

This M1 module is complete and independently useful: the extension (M2) has a real ingest + storage API to target, and the dashboard (M3) has real data to render.

---

## Self-review

- **Spec coverage:** §5 (UploadThing, no SDK) → Task 6. §6 (bugs + bug_events tables) → Task 1. §9 server routes (ingest, upload-urls, list, detail, status, comment, stats) → Tasks 5–6. §12 (real in-memory DB tests, live UploadThing check) → every task's tests + Task 6 Step 6. Deferred to later milestones (extension, dashboard, profile) — out of M1 scope by design.
- **Placeholder scan:** none — every step has real code and exact commands. The only live-confirm is Task 6 Step 6 (external UploadThing contract), which ships concrete code plus a runnable verification, not a TODO.
- **Type consistency:** `createBug`/`getBug`(as `getBugById`)/`listBugs`/`updateBugStatus`/`addBugComment`/`listBugEvents`/`bugStatsForUser`/`mintUploadUrls`/`parseUploadThingToken` are named identically across their defining task, the routes that call them, and the tests. `bug` and event shapes match between module and HTTP assertions.
