// ABOUTME: The connector — the local runner loop a MEMBER runs (`be10x connect`) to link their machine to a
// ABOUTME: HOSTED board. Claims wakes for the repos they serve over HTTP, runs claude locally, reports back.
//
// Pure of process/CLI concerns: the board is an injected HTTP client and the executor is injected, so the
// whole claim→run→report loop is unit-testable without a real board, network, or CLI. bin/be10x.js wires
// the real board client + makeRemoteExecutor.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

// A thin client over the board's token-authed runner API (/api/agent/*). `fetchImpl` injected for tests.
export function makeBoardClient({ board, token, fetchImpl = fetch }) {
  const base = String(board || '').replace(/\/+$/, '');
  const post = async (path, body) => {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
    return json;
  };
  return {
    base,
    registerProject: (key, name) => post('/api/agent/projects', { key, name }),
    claim: (projectKeys, workerId) => post('/api/agent/claim', { projectKeys, workerId }),
    report: (payload) => post('/api/agent/report', payload),
    // Soft-archive a task on the hosted board (accepts a uuid or GFA-123). Returns { task, worktrees }.
    archive: (taskId) => post('/api/agent/tasks/' + encodeURIComponent(taskId) + '/archive', {}),
  };
}

// Drive the browser device-authorization login (`be10x login`) against a hosted board: mint a code, hand the
// user the approve URL (opened in their browser), then poll until the board mints and returns a token. Pure
// of process concerns — `open` (browser), `sleep` (backoff), `fetchImpl`, and `now` are injected so
// bin/be10x.js wires the real ones and tests drive it deterministically. Resolves { board, token, user }.
export async function runDeviceLogin({
  board,
  label = null,
  fetchImpl = fetch,
  open = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  now = () => Date.now(),
  maxMs = 10 * 60 * 1000,
} = {}) {
  const base = String(board || '').replace(/\/+$/, '');
  if (!base) throw new Error('a board URL is required (be10x login <board-url>)');
  const post = async (path, body) => {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
    return json;
  };

  const start = await post('/api/device/code', { label });
  const approveUrl = start.verificationUriComplete || start.verificationUri;
  log({ event: 'code', userCode: start.userCode, verificationUri: approveUrl });
  open(approveUrl);

  const intervalMs = Math.max(1, Number(start.interval) || 3) * 1000;
  const deadline = now() + Math.min(maxMs, start.expiresIn ? start.expiresIn * 1000 : maxMs);
  while (now() < deadline) {
    await sleep(intervalMs);
    let poll;
    try {
      poll = await post('/api/device/token', { deviceCode: start.deviceCode });
    } catch (e) {
      // A transient network blip shouldn't abort the login — keep polling until the deadline.
      log({ event: 'poll_error', error: e?.message ?? String(e) });
      continue;
    }
    if (poll.status === 'approved') return { board: base, token: poll.token, user: poll.user || null };
    if (poll.status === 'denied') throw new Error('the request was denied on the board');
    if (poll.status === 'expired' || poll.status === 'consumed' || poll.status === 'not_found') {
      throw new Error('the login code expired — run `be10x login` again');
    }
    // 'pending' → keep waiting
  }
  throw new Error('timed out waiting for approval — run `be10x login` again');
}

// One claim→run→report cycle. Claims the next wake for the repos this connector serves; if one comes back,
// maps it to the matching local checkout (by project key), runs the injected executor there, and reports the
// summary so the board applies durability. Returns { claim, summary } (or null when nothing is ready). A
// claimed wake for a repo we somehow don't have is reported as a crash so the board never wedges on it.
export async function runConnectOnce({ board, repos, makeExecutor, workerId = 'connect' }) {
  const projectKeys = repos.map((r) => r.key);
  if (!projectKeys.length) return null;
  const claim = await board.claim(projectKeys, workerId);
  if (!claim || !claim.wake) return null;

  const repo = repos.find((r) => r.key === claim.projectKey);
  const reportBase = { wakeId: claim.wake.id, runId: claim.runId, taskId: claim.task.id, commentIds: claim.commentIds || [], workerId };

  if (!repo) {
    await board.report({
      ...reportBase,
      summary: { ok: false, failureKind: 'crash', mode: claim.mode, error: 'connector has no local checkout for ' + claim.projectKey },
    });
    return { claim, skipped: 'no-repo' };
  }

  const execute = makeExecutor(repo);
  const summary = await execute(claim.task, {
    mode: claim.mode,
    comments: claim.comments || [],
    wakeContext: claim.wake.context ?? null,
    resume: claim.resume,
    resumeSessionId: claim.resumeSessionId,
  });
  await board.report({ ...reportBase, summary });
  return { claim, summary };
}

// Poll runConnectOnce on an interval. `once` runs a single pass then resolves. A failing cycle (a network
// blip claiming/reporting, an executor throw) never kills the loop — it's caught and surfaced via onError.
// Returns a stoppable handle { stop(), stopped, done } like the in-process runner's wakeLoop.
export function connectLoop({ board, repos, makeExecutor, workerId = 'connect', intervalMs = 3000, once = false, onError } = {}) {
  let stopped = false;
  let timer = null;
  let lastResult = null;

  async function loop() {
    do {
      if (stopped) break;
      try {
        lastResult = await runConnectOnce({ board, repos, makeExecutor, workerId });
      } catch (e) {
        lastResult = { error: e };
        if (onError) onError(e);
      }
      if (once || stopped) break;
      await new Promise((res) => {
        timer = setTimeout(res, intervalMs);
      });
    } while (!stopped);
    return lastResult;
  }

  const done = loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}

// --- local config -------------------------------------------------------------
// A member's connector remembers its board + token + served repos in ~/.be10x/connect.json, so a bare
// `be10x connect` next time just works.

export function connectConfigPath() {
  return join(homedir(), '.be10x', 'connect.json');
}

export function loadConnectConfig(path = connectConfigPath()) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConnectConfig(cfg, path = connectConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return path;
}

// Merge a repo into a saved repos list, de-duplicating by key (the newest path wins). Pure helper shared by
// `be10x link`, so re-linking a moved repo updates its path in place instead of adding a duplicate row.
export function upsertRepo(repos, repo) {
  const rest = (Array.isArray(repos) ? repos : []).filter((r) => r.key !== repo.key);
  return [...rest, { key: repo.key, path: repo.path }];
}

// Write a repo's .be10x/mcp.json pointing the agent's gfa_* tools at the HOSTED board over HTTP (the
// http-server.js transport), instead of the local-db stdio server `be10x link` writes. Returns the path.
export function writeMcpConfig(repoPath, { board, token, httpMcpServerPath }) {
  const dir = join(repoPath, '.be10x');
  mkdirSync(dir, { recursive: true });
  const cfg = {
    mcpServers: {
      be10x: { command: 'node', args: [httpMcpServerPath], env: { GFA_BOARD_URL: board, GFA_TOKEN: token } },
    },
  };
  const out = join(dir, 'mcp.json');
  writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
  return out;
}
