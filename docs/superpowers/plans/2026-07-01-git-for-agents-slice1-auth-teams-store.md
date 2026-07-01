# Git for Agents — Slice 1: Auth + Teams + Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tested core data + identity layer for Git for Agents — accounts, sessions, personal-access tokens, teams, memberships/roles, and an authorization module — as pure Node modules over SQLite, with no HTTP (that arrives in Slice 4).

**Architecture:** A single SQLite database (via `better-sqlite3`, synchronous) opened by one `db` module that applies `schema.sql`. Each domain concern is a small, focused ES module exporting pure functions that take the `db` handle as their first argument. Authorization is a separate module that reads memberships and enforces a role hierarchy. Everything is unit-tested with Node's built-in test runner against an in-memory database.

**Tech Stack:** Node ≥ 18 (ESM), `better-sqlite3` (SQLite), `node:crypto` (scrypt password hashing, random tokens, SHA-256), `node:test` + `node:assert/strict` (tests). No web framework, no build step.

## Global Constraints

- **ESM only:** `package.json` has `"type": "module"`; all files use `import`/`export`, `.js` extension.
- **Node ≥ 18**, `better-sqlite3` `^11.8.0` (synchronous API: `db.prepare(sql).run/get/all`, `db.exec`, `db.pragma`).
- **Tests:** `node:test` + `node:assert/strict`; run with `node --test <file>`. Tests use an in-memory DB (`openDb(':memory:')`) — never touch disk.
- **IDs:** `crypto.randomUUID()`. **Timestamps:** `Date.now()` (integer ms).
- **Passwords:** scrypt via `node:crypto`, format `scrypt$<saltHex>$<hashHex>`. **Tokens:** random secret prefixed `gfa_`, stored as SHA-256 hash, plaintext returned once.
- **Every function takes `db` as its first parameter** (dependency-injected; no global singleton) so tests stay isolated.
- **Commits:** Conventional Commits (`feat:`/`test:`/`chore:`). **NO AI attribution** — no `Co-Authored-By`, no "Generated with", no `Claude-Session` trailer. One commit per task.
- **Errors:** throw `Error` with a stable UPPER_SNAKE code as the message (e.g. `throw new Error('EMAIL_TAKEN')`) so callers can branch on `err.message`.

## Parallelization Map (for worktree fan-out)

Tasks are dependency-ordered. Independent tasks in the same wave can be built **concurrently in isolated git worktrees** (each touches only its own `src/` + `test/` files; no shared-file conflicts), then merged.

- **Wave A (foundation, solo):** Task 1.
- **Wave B (parallel — depend only on Task 1):** Task 2 (passwords), Task 4 (sessions), Task 5 (tokens), Task 6 (teams).
- **Wave C (parallel):** Task 3 (users — needs Task 2), Task 7 (memberships — needs Task 6).
- **Wave D (solo):** Task 8 (authz — needs Task 7).

Merge order within a wave is irrelevant (disjoint files). Re-run `node --test` after each merge.

## File Structure

```
git-for-agents/
  package.json                 # ESM, better-sqlite3 dep, "test": "node --test"
  src/
    db/
      db.js                    # openDb(path) → applies schema, returns handle   [Task 1]
      schema.sql               # DDL: users, sessions, tokens, teams, memberships [Task 1]
    auth/
      passwords.js             # hashPassword / verifyPassword                    [Task 2]
      users.js                 # createUser / getUserByEmail / getUserById        [Task 3]
      sessions.js              # createSession / getSession / deleteSession       [Task 4]
      tokens.js                # createToken / verifyToken / revokeToken          [Task 5]
    teams/
      teams.js                 # slugify / createTeam / getTeam / getTeamBySlug   [Task 6]
      memberships.js           # addMember / getMembership / listMembers / setRole / removeMember [Task 7]
    authz/
      authz.js                 # can / assertCan / ACTIONS                        [Task 8]
  test/
    db.test.js  passwords.test.js  users.test.js  sessions.test.js
    tokens.test.js  teams.test.js  memberships.test.js  authz.test.js
```

---

### Task 1: Project scaffold + database module

**Depends on:** none · **Wave:** A

**Files:**
- Create: `package.json`
- Create: `src/db/schema.sql`
- Create: `src/db/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `openDb(path = ':memory:') → Database` — a `better-sqlite3` handle with `foreign_keys` ON and `schema.sql` applied. Every later task imports this.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "git-for-agents",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "engines": { "node": ">=18" },
  "dependencies": { "better-sqlite3": "^11.8.0" },
  "scripts": { "test": "node --test" }
}
```

- [ ] **Step 2: Install the dependency**

Run: `npm install`
Expected: `better-sqlite3` compiles and `node_modules/` appears; exit 0.

- [ ] **Step 3: Create `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  bias_md    TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, user_id)
);
```

- [ ] **Step 4: Write the failing test `test/db.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';

test('openDb applies the schema and enforces foreign keys', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['memberships', 'sessions', 'teams', 'tokens', 'users']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `Cannot find module '.../src/db/db.js'`.

- [ ] **Step 6: Implement `src/db/db.js`**

```js
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (`# pass 1`).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/db/schema.sql src/db/db.js test/db.test.js
git commit -m "feat: add SQLite store with schema for users, sessions, tokens, teams, memberships"
```

---

### Task 2: Password hashing

**Depends on:** Task 1 (none at runtime) · **Wave:** B

**Files:**
- Create: `src/auth/passwords.js`
- Test: `test/passwords.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `hashPassword(password: string) → string` (format `scrypt$salt$hash`); `verifyPassword(password: string, stored: string) → boolean`.

- [ ] **Step 1: Write the failing test `test/passwords.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

test('hashPassword output verifies against the original password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('verifyPassword rejects a wrong password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('Tr0ub4dour', stored), false);
});

test('same password hashes differently each time (random salt)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('verifyPassword returns false on malformed stored value', () => {
  assert.equal(verifyPassword('x', 'not-a-real-hash'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/passwords.test.js`
Expected: FAIL — `Cannot find module '.../src/auth/passwords.js'`.

- [ ] **Step 3: Implement `src/auth/passwords.js`**

```js
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/passwords.test.js`
Expected: PASS (`# pass 4`).

- [ ] **Step 5: Commit**

```bash
git add src/auth/passwords.js test/passwords.test.js
git commit -m "feat: add scrypt password hashing and verification"
```

---

### Task 3: Users

**Depends on:** Task 1, Task 2 · **Wave:** C

**Files:**
- Create: `src/auth/users.js`
- Test: `test/users.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); `hashPassword` (Task 2).
- Produces:
  - `createUser(db, { email, displayName, password }) → { id, email, displayName }` — normalizes email (trim+lowercase); throws `EMAIL_TAKEN` on duplicate.
  - `getUserByEmail(db, email) → { id, email, displayName, passwordHash, createdAt } | null`.
  - `getUserById(db, id) → { id, email, displayName, createdAt } | null`.

- [ ] **Step 1: Write the failing test `test/users.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser, getUserByEmail, getUserById } from '../src/auth/users.js';
import { verifyPassword } from '../src/auth/passwords.js';

test('createUser stores a normalized email and a verifiable password', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { email: '  Ada@Example.COM ', displayName: 'Ada', password: 'pw12345' });
  assert.equal(u.email, 'ada@example.com');
  const row = getUserByEmail(db, 'ada@example.com');
  assert.equal(row.id, u.id);
  assert.equal(verifyPassword('pw12345', row.passwordHash), true);
});

test('getUserById omits the password hash', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { email: 'a@b.co', displayName: 'A', password: 'pw12345' });
  const got = getUserById(db, u.id);
  assert.equal(got.email, 'a@b.co');
  assert.equal('passwordHash' in got, false);
});

test('createUser rejects a duplicate email', () => {
  const db = openDb(':memory:');
  createUser(db, { email: 'dup@b.co', displayName: 'A', password: 'pw12345' });
  assert.throws(() => createUser(db, { email: 'DUP@b.co', displayName: 'B', password: 'pw12345' }), /EMAIL_TAKEN/);
});

test('getUserByEmail returns null when absent', () => {
  const db = openDb(':memory:');
  assert.equal(getUserByEmail(db, 'nobody@b.co'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/users.test.js`
Expected: FAIL — `Cannot find module '.../src/auth/users.js'`.

- [ ] **Step 3: Implement `src/auth/users.js`**

```js
import { randomUUID } from 'node:crypto';
import { hashPassword } from './passwords.js';

const norm = (email) => String(email).trim().toLowerCase();

export function createUser(db, { email, displayName, password }) {
  const e = norm(email);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(e)) {
    throw new Error('EMAIL_TAKEN');
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, e, displayName, hashPassword(password), Date.now());
  return { id, email: e, displayName };
}

export function getUserByEmail(db, email) {
  return (
    db
      .prepare(
        'SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE email = ?'
      )
      .get(norm(email)) ?? null
  );
}

export function getUserById(db, id) {
  return (
    db
      .prepare('SELECT id, email, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?')
      .get(id) ?? null
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/users.test.js`
Expected: PASS (`# pass 4`).

- [ ] **Step 5: Commit**

```bash
git add src/auth/users.js test/users.test.js
git commit -m "feat: add user creation and lookup with email normalization"
```

---

### Task 4: Sessions

**Depends on:** Task 1 (needs a user row for FK in tests) · **Wave:** B

**Files:**
- Create: `src/auth/sessions.js`
- Test: `test/sessions.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); `createUser` (Task 3) in tests only.
- Produces:
  - `createSession(db, userId, ttlMs = 1209600000) → { id, userId, expiresAt }` (default TTL 14 days).
  - `getSession(db, id) → { id, userId, expiresAt } | null` — returns null (and deletes) if expired.
  - `deleteSession(db, id) → void`.

- [ ] **Step 1: Write the failing test `test/sessions.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createSession, getSession, deleteSession } from '../src/auth/sessions.js';

function seedUser(db) {
  return createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
}

test('createSession then getSession returns the live session', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid);
  const got = getSession(db, s.id);
  assert.equal(got.userId, uid);
  assert.equal(got.id, s.id);
});

test('an expired session is not returned and is purged', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid, -1000); // already expired
  assert.equal(getSession(db, s.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('deleteSession removes it', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const s = createSession(db, uid);
  deleteSession(db, s.id);
  assert.equal(getSession(db, s.id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `Cannot find module '.../src/auth/sessions.js'`.

- [ ] **Step 3: Implement `src/auth/sessions.js`**

```js
import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function createSession(db, userId, ttlMs = DEFAULT_TTL_MS) {
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    expiresAt,
    now
  );
  return { id, userId, expiresAt };
}

export function getSession(db, id) {
  const row = db
    .prepare('SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE id = ?')
    .get(id);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    deleteSession(db, id);
    return null;
  }
  return row;
}

export function deleteSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sessions.test.js`
Expected: PASS (`# pass 3`).

- [ ] **Step 5: Commit**

```bash
git add src/auth/sessions.js test/sessions.test.js
git commit -m "feat: add cookie-session create/get/delete with expiry"
```

---

### Task 5: Personal access tokens

**Depends on:** Task 1 (needs a user row for FK in tests) · **Wave:** B

**Files:**
- Create: `src/auth/tokens.js`
- Test: `test/tokens.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); `createUser` (Task 3) in tests only.
- Produces:
  - `createToken(db, userId, name) → { id, name, token }` — `token` is the plaintext secret, returned **once**; only its SHA-256 hash is stored.
  - `verifyToken(db, secret) → { userId, tokenId } | null` — updates `last_used_at` on success.
  - `revokeToken(db, id) → void`.

- [ ] **Step 1: Write the failing test `test/tokens.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createToken, verifyToken, revokeToken } from '../src/auth/tokens.js';

function seedUser(db) {
  return createUser(db, { email: 'u@b.co', displayName: 'U', password: 'pw12345' }).id;
}

test('createToken returns a plaintext secret that verifies to its user', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  assert.match(t.token, /^gfa_[0-9a-f]{48}$/);
  const v = verifyToken(db, t.token);
  assert.equal(v.userId, uid);
  assert.equal(v.tokenId, t.id);
});

test('the plaintext secret is not stored in the database', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  const stored = db.prepare('SELECT token_hash FROM tokens WHERE id = ?').get(t.id).token_hash;
  assert.notEqual(stored, t.token);
});

test('verifyToken returns null for an unknown secret', () => {
  const db = openDb(':memory:');
  assert.equal(verifyToken(db, 'gfa_deadbeef'), null);
});

test('a revoked token no longer verifies', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createToken(db, uid, 'laptop');
  revokeToken(db, t.id);
  assert.equal(verifyToken(db, t.token), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tokens.test.js`
Expected: FAIL — `Cannot find module '.../src/auth/tokens.js'`.

- [ ] **Step 3: Implement `src/auth/tokens.js`**

```js
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createToken(db, userId, name) {
  const id = randomUUID();
  const token = 'gfa_' + randomBytes(24).toString('hex'); // 48 hex chars
  db.prepare('INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    sha256(token),
    Date.now()
  );
  return { id, name, token };
}

export function verifyToken(db, secret) {
  const row = db.prepare('SELECT id, user_id AS userId FROM tokens WHERE token_hash = ?').get(sha256(secret));
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { userId: row.userId, tokenId: row.id };
}

export function revokeToken(db, id) {
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tokens.test.js`
Expected: PASS (`# pass 4`).

- [ ] **Step 5: Commit**

```bash
git add src/auth/tokens.js test/tokens.test.js
git commit -m "feat: add personal access tokens (hashed at rest, plaintext shown once)"
```

---

### Task 6: Teams

**Depends on:** Task 1, Task 3 (creator must be a real user for FK) · **Wave:** B

**Files:**
- Create: `src/teams/teams.js`
- Test: `test/teams.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); `createUser` (Task 3) in tests.
- Produces:
  - `slugify(name) → string` (lowercase, non-alphanumerics → single `-`, trimmed).
  - `createTeam(db, { name, createdBy, biasMd = '' }) → { id, name, slug, biasMd, createdBy }` — inserts the team **and** an `owner` membership row for `createdBy`; throws `INVALID_NAME` (empty slug) or `SLUG_TAKEN`.
  - `getTeam(db, id) → { id, name, slug, biasMd, createdBy, createdAt } | null`.
  - `getTeamBySlug(db, slug) → same shape | null`.

- [ ] **Step 1: Write the failing test `test/teams.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { slugify, createTeam, getTeam, getTeamBySlug } from '../src/teams/teams.js';

function seedUser(db) {
  return createUser(db, { email: 'o@b.co', displayName: 'Owner', password: 'pw12345' }).id;
}

test('slugify normalizes a name', () => {
  assert.equal(slugify('  My Cool Team!! '), 'my-cool-team');
});

test('createTeam makes the creator an owner', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  const t = createTeam(db, { name: 'Platform', createdBy: uid });
  assert.equal(t.slug, 'platform');
  assert.equal(getTeamBySlug(db, 'platform').id, t.id);
  const m = db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(t.id, uid);
  assert.equal(m.role, 'owner');
});

test('createTeam rejects a duplicate slug', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  createTeam(db, { name: 'Platform', createdBy: uid });
  assert.throws(() => createTeam(db, { name: 'platform', createdBy: uid }), /SLUG_TAKEN/);
});

test('createTeam rejects a name with no usable slug', () => {
  const db = openDb(':memory:');
  const uid = seedUser(db);
  assert.throws(() => createTeam(db, { name: '!!!', createdBy: uid }), /INVALID_NAME/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/teams.test.js`
Expected: FAIL — `Cannot find module '.../src/teams/teams.js'`.

- [ ] **Step 3: Implement `src/teams/teams.js`**

```js
import { randomUUID } from 'node:crypto';

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const TEAM_COLS = 'id, name, slug, bias_md AS biasMd, created_by AS createdBy, created_at AS createdAt';

export function createTeam(db, { name, createdBy, biasMd = '' }) {
  const slug = slugify(name);
  if (!slug) throw new Error('INVALID_NAME');
  if (db.prepare('SELECT id FROM teams WHERE slug = ?').get(slug)) throw new Error('SLUG_TAKEN');
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO teams (id, name, slug, bias_md, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    slug,
    biasMd,
    createdBy,
    now
  );
  db.prepare('INSERT INTO memberships (id, team_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    id,
    createdBy,
    'owner',
    now
  );
  return { id, name, slug, biasMd, createdBy };
}

export function getTeam(db, id) {
  return db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE id = ?`).get(id) ?? null;
}

export function getTeamBySlug(db, slug) {
  return db.prepare(`SELECT ${TEAM_COLS} FROM teams WHERE slug = ?`).get(slug) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/teams.test.js`
Expected: PASS (`# pass 4`).

- [ ] **Step 5: Commit**

```bash
git add src/teams/teams.js test/teams.test.js
git commit -m "feat: add teams with slug and automatic owner membership"
```

---

### Task 7: Memberships + roles

**Depends on:** Task 1, Task 3, Task 6 · **Wave:** C

**Files:**
- Create: `src/teams/memberships.js`
- Test: `test/memberships.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); `createUser` (Task 3); `createTeam` (Task 6) in tests.
- Produces:
  - `ROLES = ['owner','admin','member','viewer']`.
  - `addMember(db, { teamId, userId, role = 'member' }) → { id, teamId, userId, role }` — throws `INVALID_ROLE` or `ALREADY_MEMBER`.
  - `getMembership(db, teamId, userId) → { id, teamId, userId, role } | null`.
  - `listMembers(db, teamId) → Array<{ userId, role }>` (ordered by `created_at`).
  - `setRole(db, teamId, userId, role) → void` — throws `INVALID_ROLE` or `NOT_A_MEMBER`.
  - `removeMember(db, teamId, userId) → void`.

- [ ] **Step 1: Write the failing test `test/memberships.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember, getMembership, listMembers, setRole, removeMember } from '../src/teams/memberships.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const bob = createUser(db, { email: 'bob@b.co', displayName: 'Bob', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Platform', createdBy: owner }).id;
  return { owner, bob, team };
}

test('addMember adds a member and getMembership reads it back', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob, role: 'member' });
  assert.equal(getMembership(db, team, bob).role, 'member');
});

test('listMembers includes the owner plus added members', () => {
  const db = openDb(':memory:');
  const { owner, bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  const roles = Object.fromEntries(listMembers(db, team).map((m) => [m.userId, m.role]));
  assert.equal(roles[owner], 'owner');
  assert.equal(roles[bob], 'member');
});

test('addMember rejects a duplicate and an invalid role', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  assert.throws(() => addMember(db, { teamId: team, userId: bob }), /ALREADY_MEMBER/);
  assert.throws(() => addMember(db, { teamId: team, userId: bob, role: 'boss' }), /INVALID_ROLE/);
});

test('setRole changes a role; removeMember deletes the membership', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  addMember(db, { teamId: team, userId: bob });
  setRole(db, team, bob, 'admin');
  assert.equal(getMembership(db, team, bob).role, 'admin');
  removeMember(db, team, bob);
  assert.equal(getMembership(db, team, bob), null);
});

test('setRole on a non-member throws', () => {
  const db = openDb(':memory:');
  const { bob, team } = seed(db);
  assert.throws(() => setRole(db, team, bob, 'admin'), /NOT_A_MEMBER/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/memberships.test.js`
Expected: FAIL — `Cannot find module '.../src/teams/memberships.js'`.

- [ ] **Step 3: Implement `src/teams/memberships.js`**

```js
import { randomUUID } from 'node:crypto';

export const ROLES = ['owner', 'admin', 'member', 'viewer'];

export function addMember(db, { teamId, userId, role = 'member' }) {
  if (!ROLES.includes(role)) throw new Error('INVALID_ROLE');
  if (db.prepare('SELECT id FROM memberships WHERE team_id = ? AND user_id = ?').get(teamId, userId)) {
    throw new Error('ALREADY_MEMBER');
  }
  const id = randomUUID();
  db.prepare('INSERT INTO memberships (id, team_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    teamId,
    userId,
    role,
    Date.now()
  );
  return { id, teamId, userId, role };
}

export function getMembership(db, teamId, userId) {
  return (
    db
      .prepare('SELECT id, team_id AS teamId, user_id AS userId, role FROM memberships WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId) ?? null
  );
}

export function listMembers(db, teamId) {
  return db
    .prepare('SELECT user_id AS userId, role FROM memberships WHERE team_id = ? ORDER BY created_at')
    .all(teamId);
}

export function setRole(db, teamId, userId, role) {
  if (!ROLES.includes(role)) throw new Error('INVALID_ROLE');
  const res = db.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?').run(role, teamId, userId);
  if (res.changes === 0) throw new Error('NOT_A_MEMBER');
}

export function removeMember(db, teamId, userId) {
  db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?').run(teamId, userId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/memberships.test.js`
Expected: PASS (`# pass 5`).

- [ ] **Step 5: Commit**

```bash
git add src/teams/memberships.js test/memberships.test.js
git commit -m "feat: add team memberships with roles (add/list/setRole/remove)"
```

---

### Task 8: Authorization

**Depends on:** Task 1, Task 3, Task 6, Task 7 · **Wave:** D

**Files:**
- Create: `src/authz/authz.js`
- Test: `test/authz.test.js`

**Interfaces:**
- Consumes: `getMembership` (Task 7).
- Produces:
  - `ACTIONS` — object of the recognized action strings.
  - `can(db, userId, action, { teamId }) → boolean` — true iff the user's team role rank ≥ the action's required rank. Non-members and unknown actions → false.
  - `assertCan(db, userId, action, ctx) → void` — throws `FORBIDDEN` when `can` is false.

Role ranks: `viewer=0 < member=1 < admin=2 < owner=3`. Required minimums: `team.read`/`task.read` → viewer; `task.create`/`task.update` → member; `members.manage` → admin; `team.delete` → owner.

- [ ] **Step 1: Write the failing test `test/authz.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { addMember } from '../src/teams/memberships.js';
import { can, assertCan } from '../src/authz/authz.js';

function seed(db) {
  const owner = createUser(db, { email: 'o@b.co', displayName: 'O', password: 'pw12345' }).id;
  const viewer = createUser(db, { email: 'v@b.co', displayName: 'V', password: 'pw12345' }).id;
  const outsider = createUser(db, { email: 'x@b.co', displayName: 'X', password: 'pw12345' }).id;
  const team = createTeam(db, { name: 'Platform', createdBy: owner }).id;
  addMember(db, { teamId: team, userId: viewer, role: 'viewer' });
  return { owner, viewer, outsider, team };
}

test('owner can manage members and delete the team', () => {
  const db = openDb(':memory:');
  const { owner, team } = seed(db);
  assert.equal(can(db, owner, 'members.manage', { teamId: team }), true);
  assert.equal(can(db, owner, 'team.delete', { teamId: team }), true);
});

test('viewer can read but not create tasks or manage members', () => {
  const db = openDb(':memory:');
  const { viewer, team } = seed(db);
  assert.equal(can(db, viewer, 'task.read', { teamId: team }), true);
  assert.equal(can(db, viewer, 'task.create', { teamId: team }), false);
  assert.equal(can(db, viewer, 'members.manage', { teamId: team }), false);
});

test('a non-member is denied everything (cross-team isolation)', () => {
  const db = openDb(':memory:');
  const { outsider, team } = seed(db);
  assert.equal(can(db, outsider, 'task.read', { teamId: team }), false);
});

test('unknown action is denied and assertCan throws FORBIDDEN', () => {
  const db = openDb(':memory:');
  const { owner, viewer, team } = seed(db);
  assert.equal(can(db, owner, 'nonsense.action', { teamId: team }), false);
  assert.throws(() => assertCan(db, viewer, 'task.create', { teamId: team }), /FORBIDDEN/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/authz.test.js`
Expected: FAIL — `Cannot find module '.../src/authz/authz.js'`.

- [ ] **Step 3: Implement `src/authz/authz.js`**

```js
import { getMembership } from '../teams/memberships.js';

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const ACTIONS = {
  TEAM_READ: 'team.read',
  TEAM_DELETE: 'team.delete',
  TASK_READ: 'task.read',
  TASK_CREATE: 'task.create',
  TASK_UPDATE: 'task.update',
  MEMBERS_MANAGE: 'members.manage',
};

const REQUIRED = {
  'team.read': 'viewer',
  'task.read': 'viewer',
  'task.create': 'member',
  'task.update': 'member',
  'members.manage': 'admin',
  'team.delete': 'owner',
};

export function can(db, userId, action, { teamId } = {}) {
  const need = REQUIRED[action];
  if (need === undefined || !teamId) return false;
  const m = getMembership(db, teamId, userId);
  if (!m) return false;
  return RANK[m.role] >= RANK[need];
}

export function assertCan(db, userId, action, ctx) {
  if (!can(db, userId, action, ctx)) throw new Error('FORBIDDEN');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/authz.test.js`
Expected: PASS (`# pass 4`).

- [ ] **Step 5: Commit**

```bash
git add src/authz/authz.js test/authz.test.js
git commit -m "feat: add role-based authorization over team memberships"
```

---

## Final verification (after all tasks / all worktrees merged)

- [ ] Run the whole suite: `node --test`
- Expected: all files pass — `# pass 29`, `# fail 0`.
- [ ] Confirm no stray files staged; the tree is all committed: `git status` → clean.

## Slice 1 Definition of Done

Sign up (`createUser`), log in (`getUserByEmail` + `verifyPassword` + `createSession`), issue an agent token (`createToken`/`verifyToken`), create/join a team with roles (`createTeam`/`addMember`/`setRole`), and enforce access (`can`/`assertCan`) — all covered by passing tests over an in-memory SQLite database. HTTP endpoints and the MCP adapter are intentionally **out of scope** (Slice 4); these modules are the tested core they will call.
