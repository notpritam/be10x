// ABOUTME: Self-update for the always-on connector — periodically checks the board's advertised version and,
// ABOUTME: when it differs, reinstalls be10x so a pushed release rolls out to connectors without manual steps.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { makeLogger } from './log.js';

// The board's advertised version (public, unauthed GET /api/version). Returns null on any failure — the
// caller treats "unknown" as "don't update", so a flaky board never triggers churn. Never throws.
export async function fetchBoardVersion(board, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  try {
    const res = await fetchImpl(String(board || '').replace(/\/+$/, '') + '/api/version', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res || !res.ok) return null;
    const json = await res.json().catch(() => null);
    return (json && typeof json.version === 'string' && json.version) || null;
  } catch {
    return null;
  }
}

// The board is the source of truth: update whenever it advertises a version different from the one we run.
// Mirrors the welcome banner's `latest !== version` check — matching the board is always the intent, so no
// separate downgrade guard. Missing either side ⇒ never update.
export function shouldUpdate(localVersion, boardVersion) {
  return Boolean(localVersion && boardVersion && localVersion !== boardVersion);
}

const UPDATE_STATE_PATH = () => join(homedir(), '.be10x', 'update-state.json');
function fileLoadCooldown() {
  try {
    return JSON.parse(readFileSync(UPDATE_STATE_PATH(), 'utf8'));
  } catch {
    return null;
  }
}
function fileSaveCooldown(state) {
  try {
    writeFileSync(UPDATE_STATE_PATH(), JSON.stringify(state));
  } catch {
    /* best effort — a missing cooldown only weakens loop protection, never correctness */
  }
}

// A rate-limited, loop-safe self-updater for the connector loop. `maybeUpdate()`:
//   • checks at most once per `minIntervalMs` within a process (in-memory throttle), AND
//   • persists the target it last attempted, so across service restarts it won't re-attempt the SAME target
//     version within `minIntervalMs` (prevents a reinstall/restart loop if a release never converges).
// When the board advertises a different version it logs, records the attempt, calls `runUpdate()` (which
// reinstalls and SHOULD exit the process so the service manager restarts on the new build), and reports it.
// Every dependency is injectable so the whole thing is unit-testable without network, fs, or a real npm.
export function makeAutoUpdater({
  board,
  localVersion,
  runUpdate,
  fetchImpl = fetch,
  log = makeLogger(),
  minIntervalMs = 30 * 60 * 1000,
  now = () => Date.now(),
  loadCooldown = fileLoadCooldown,
  saveCooldown = fileSaveCooldown,
} = {}) {
  let lastCheck = -Infinity;
  let inFlight = false;

  return {
    async maybeUpdate() {
      if (inFlight) return { checked: false, reason: 'in_flight' };
      const t = now();
      if (t - lastCheck < minIntervalMs) return { checked: false, reason: 'throttled' };
      lastCheck = t;
      inFlight = true;
      try {
        const boardVersion = await fetchBoardVersion(board, { fetchImpl });
        if (!shouldUpdate(localVersion, boardVersion)) return { checked: true, updated: false, boardVersion };
        // Loop guard across restarts: if we already tried THIS exact target recently, back off.
        const cd = loadCooldown();
        if (cd && cd.version === boardVersion && typeof cd.at === 'number' && t - cd.at < minIntervalMs) {
          return { checked: true, updated: false, boardVersion, reason: 'cooldown' };
        }
        saveCooldown({ version: boardVersion, at: t }); // record BEFORE updating — runUpdate may exit the process
        log.info('self_update', { from: localVersion, to: boardVersion });
        await runUpdate();
        log.info('self_update_applied', { to: boardVersion });
        return { checked: true, updated: true, boardVersion };
      } catch (e) {
        log.error('self_update_failed', { error: e?.message ?? String(e) });
        return { checked: true, updated: false, error: e?.message ?? String(e) };
      } finally {
        inFlight = false;
      }
    },
  };
}
