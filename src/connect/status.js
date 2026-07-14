// ABOUTME: The pure assembler behind `be10x status` — folds four injected probes (saved config, live board
// ABOUTME: connectivity, the running background service, and the tail of the structured log) into one snapshot.
//
// Every side-effecting input is injected so this stays trivially unit-testable without a board, launchctl, or a
// real log file. bin/be10x.js builds the real deps (a fetch probe, a launchctl/systemctl reader, a log tailer)
// and pretty-prints the returned shape.

// assembleStatus({ config, probe, service, tailEvents }) → {
//   signedIn, board, service: { running, pid }, connectivity: { ok, projectCount?, error? }, lastEvents: [...]
// }. Skips the network probe entirely when there's no token (nothing to authenticate with).
export async function assembleStatus({ config, probe, service, tailEvents } = {}) {
  const cfg = config || {};
  const signedIn = !!cfg.token;
  const board = cfg.board || null;

  const svc = (service ? await service() : null) || {};
  const serviceStatus = { running: !!svc.running, pid: svc.pid ?? null };

  let connectivity;
  if (!signedIn) {
    connectivity = { ok: false, error: 'not signed in' };
  } else if (probe) {
    connectivity = (await probe()) || { ok: false, error: 'no response' };
  } else {
    connectivity = { ok: false, error: 'no probe' };
  }

  const lastEvents = (tailEvents ? await tailEvents() : []) || [];

  return { signedIn, board, service: serviceStatus, connectivity, lastEvents };
}

// Pull the most recent task id out of a list of structured log lines (oldest→newest) for the CLI's
// "last task GFA-x" line. Matches the `task=<id>` field the connect logger emits on claimed/reported/run_failed.
export function pickLastTask(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = /(?:^|\s)task=("?)([^\s"]+)\1/.exec(String(events[i]));
    if (m) return m[2];
  }
  return null;
}
