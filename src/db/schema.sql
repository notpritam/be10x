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
  agent_json    TEXT,
  artifacts_json TEXT,
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

CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  verdict     TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS input_requests (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  choices_json TEXT,
  allow_custom INTEGER NOT NULL DEFAULT 1,
  answer       TEXT,
  answered_by  TEXT REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled')),
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER
);

-- A registered repository. Tasks carry a project_id (see tasks.project_id); this table gives that id a
-- stable identity: `key` is derived from the git remote (or a local: slug) so the same repo maps to the
-- same project across machines. owner_id/team_id scope who can see and claim it — the SAME repo key
-- linked by two different accounts (or two different teams) is two separate rows, never one shared
-- identity, so unrelated accounts can never collide onto (or leak through) the same project. A row with
-- both NULL is pre-migration legacy data (see db.js migrateProjectsTable) and stays visible to everyone,
-- exactly as it always was — only new registrations are scoped.
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_branch TEXT,
  root_path      TEXT,
  owner_id       TEXT REFERENCES users(id),
  team_id        TEXT REFERENCES teams(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL
);
-- Partial unique indexes (not a table constraint) because identity is scoped: one row per (key, team)
-- for team projects, one row per (key, owner) for personal ones — a bare UNIQUE(key) would let two
-- different owners/teams collide onto one row again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_team_key ON projects (key, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_key ON projects (key, owner_id) WHERE team_id IS NULL AND owner_id IS NOT NULL;

-- One execution of an ephemeral Claude agent session against a task, in that task's git worktree.
-- session_id is Claude Code's own session id, scraped from stream-json and persisted so a later run can
-- --resume it; it stays null until the first stream event carrying it arrives. FK to tasks only
-- (project_id is a loose string mirroring tasks.project_id). This is the durable half of the "sessions
-- disposable, state durable" model: lose the process, resume from the saved session_id + worktree.
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id    TEXT,
  session_id    TEXT,
  executor      TEXT NOT NULL DEFAULT 'claude',
  model         TEXT,
  worktree_path TEXT,
  branch        TEXT,
  base_ref      TEXT,
  status        TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','done','failed')),
  pid           INTEGER,
  result_json   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);

-- The step-by-step execution trace of a run — the "what happened, in depth" record for debugging: the
-- exact prompt/context handed to the agent (kind='prompt'), each tool the agent invoked with its input
-- (kind='tool', e.g. a Bash command or an Edit) and the tool's result (kind='tool_result'), plus the
-- terminal outcome (kind='result'). Append-only, ordered by seq within a run. Deliberately verbose (not
-- truncated like board progress notes) so a human can reconstruct exactly what the agent ran and saw.
CREATE TABLE IF NOT EXISTS run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  tool        TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_steps_task ON run_steps (task_id, created_at);

-- Human context delivered to the agent: a comment on the plan (or the diagram, or general). anchor lets
-- the board pin a thread to a plan line / diagram node. seen_at is stamped once the agent has folded the
-- comment into a wake prompt, so follow-up wakes stay delta-only (unseen comments only).
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  anchor     TEXT NOT NULL DEFAULT 'general',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER
);

-- The wake queue: the event→run bridge. A board event (hand-off, comment, input answer, approval,
-- pick-up-now) enqueues a row; the scheduler claims the oldest pending one (claimed_at IS NULL) with an
-- optimistic UPDATE and drives the agent. reason picks the executor mode; context_json is the delta that
-- triggered the wake. This is what makes "staying on a task" a re-wake from durable state, not a live process.
CREATE TABLE IF NOT EXISTS wake_queue (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  context_json TEXT,
  enqueued_at  INTEGER NOT NULL,
  claimed_at   INTEGER,
  claimed_by   TEXT
);

-- A shareable, permissioned link to a task's plan + discussion. The owner mints one; anyone holding the
-- token is the credential (unguessable random hex), so the link itself grants access — no session needed.
-- permission gates what the bearer can do: comment/review only, or also run the agent. revoked_at (once
-- stamped) makes the token read as gone, so a leaked-then-revoked link stops working. created_by is the
-- minting user (nullable, standalone — the reviewer they hand it to may be anonymous).
CREATE TABLE IF NOT EXISTS share_links (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL DEFAULT 'comment_only' CHECK (permission IN ('comment_only','run_agent')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Plan history: every time a task's plan is set (setPlan) an immutable snapshot lands here, so the board
-- can show previous-vs-new plans and restore an earlier one. plan_json is the whole plan at that moment;
-- created_by is the actor who set it (loose string, may be an agent id — no FK). Newest-first by created_at.
CREATE TABLE IF NOT EXISTS plan_versions (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_json  TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- Browser device-authorization for `be10x login`: the CLI inserts a row (public, no auth) and polls with the
-- unguessable device_code; the user, logged into the board, approves the short user_code shown in both the
-- terminal and the browser. On approval we mint a personal token and stash it here so the polling CLI can
-- collect it EXACTLY ONCE (then it's nulled). Rows expire (expires_at) so an abandoned request can't be
-- approved later. label is the requesting machine's hostname, shown on the approve screen.
CREATE TABLE IF NOT EXISTS device_codes (
  id          TEXT PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  user_code   TEXT NOT NULL UNIQUE,
  label       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  approved_at INTEGER
);
