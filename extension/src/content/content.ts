// ABOUTME: ISOLATED-world entry — starts the rolling recorder, mounts the widget, keeps the popup's
// ABOUTME: point-in-time `collect` responder, and packages the widget's session report for the SW.
import { getRecorder } from './recorder';
import { mountWidget, type ReportForm } from './widget';
import { installCollectHandler, collectNetwork, captureDom, extractIdentity } from './collector';
import { pruneByAge } from './net-entry';
import type { BugEnvironment } from './protocol';
import type { Team, Project } from '../lib/board';

// The reporter's device/browser/page-load environment — read from the ISOLATED world at report time. Every
// probe is wrapped so a missing/blocked API never breaks the report; unknown fields are simply omitted.
function collectEnvironment(): BugEnvironment {
  const env: BugEnvironment = {};
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string; version: string }[] };
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  };
  const set = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* best-effort probe */
    }
  };
  set(() => (env.userAgent = navigator.userAgent));
  set(() => (env.platform = nav.userAgentData?.platform || navigator.platform || undefined));
  set(() => {
    const b = nav.userAgentData?.brands;
    if (Array.isArray(b)) env.brands = b.map((x) => `${x.brand} ${x.version}`).filter(Boolean).slice(0, 6);
    if (typeof nav.userAgentData?.mobile === 'boolean') env.mobile = nav.userAgentData.mobile;
  });
  set(() => (env.language = navigator.language));
  set(() => (env.languages = Array.isArray(navigator.languages) ? navigator.languages.slice(0, 6) : undefined));
  set(() => (env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone));
  set(() => (env.online = navigator.onLine));
  set(() => (env.cores = navigator.hardwareConcurrency));
  set(() => (env.memoryGb = nav.deviceMemory));
  set(() => (env.screen = { w: screen.width, h: screen.height, dpr: window.devicePixelRatio, colorDepth: screen.colorDepth }));
  set(() => {
    const c = nav.connection;
    if (c) env.connection = { effectiveType: c.effectiveType, downlinkMbps: c.downlink, rttMs: c.rtt, saveData: c.saveData };
  });
  set(() => {
    const navE = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const perf: NonNullable<BugEnvironment['performance']> = {};
    if (navE) {
      if (navE.responseStart > 0) perf.ttfbMs = Math.round(navE.responseStart);
      if (navE.domInteractive > 0) perf.domInteractiveMs = Math.round(navE.domInteractive);
      if (navE.domContentLoadedEventEnd > 0) perf.domContentLoadedMs = Math.round(navE.domContentLoadedEventEnd);
      if (navE.loadEventEnd > 0) perf.loadMs = Math.round(navE.loadEventEnd);
    }
    const fcp = performance.getEntriesByName?.('first-contentful-paint')?.[0];
    if (fcp) perf.fcpMs = Math.round(fcp.startTime);
    if (Object.keys(perf).length > 0) env.performance = perf;
  });
  env.capturedAt = Date.now();
  return env;
}

// Ask the SW (which holds the board token) for the reporter's teams + projects for the widget's pickers.
// Degrades to empty on any failure so the widget never blocks on it.
function loadTaxonomy(): Promise<{ teams: Team[]; projects: Project[] }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'taxonomy' }, (reply: { teams?: unknown; projects?: unknown } | undefined) => {
        if (chrome.runtime.lastError) return resolve({ teams: [], projects: [] });
        resolve({
          teams: Array.isArray(reply?.teams) ? (reply.teams as Team[]) : [],
          projects: Array.isArray(reply?.projects) ? (reply.projects as Project[]) : [],
        });
      });
    } catch {
      resolve({ teams: [], projects: [] });
    }
  });
}

type ReportResult = { ok: boolean; message: string };
type SwReply = { ok?: boolean; error?: string; warning?: string; bug?: { humanId?: string } } | undefined;

const NET_WINDOW_SLACK_MS = 2000; // include requests started just before the recording window opened
const CONSOLE_LOOKBACK_MS = 120000; // console reaches back ~2 min so page-load/setup logs aren't dropped

function sendToSw(payload: Record<string, unknown>): Promise<SwReply> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (reply: SwReply) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(reply);
      });
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message || e) });
    }
  });
}

// Gather everything the ISOLATED world can see, hand it to the SW (which owns screenshot + egress).
async function report(form: ReportForm): Promise<ReportResult> {
  const recorder = getRecorder();
  let payload: Record<string, unknown>;
  try {
    const recording = recorder.collectRecording();
    const windowMs = recording.endedAt - recording.startedAt + NET_WINDOW_SLACK_MS;
    const hook = await collectNetwork();
    const network = pruneByAge(hook.network, recording.endedAt, windowMs);
    // Console gets a MORE generous window than network: a short explicit take would otherwise drop the
    // page-load + setup logs that explain the bug. Keep everything from at least the 2-min rolling window
    // (or the whole take if it ran longer) — the buffer is already count-capped, so this stays bounded.
    const consoleWindowMs = Math.max(windowMs, CONSOLE_LOOKBACK_MS);
    const consoleEntries = hook.console.filter((c) => c.ts >= recording.endedAt - consoleWindowMs);
    // Auto-markers: pin captured error moments on the replay clock so a reviewer jumps straight to the
    // failure. Only errors inside the recording window map onto the timeline; dedupe near-duplicates
    // (same message within a 2s bucket) and cap so a noisy page can't flood the scrubber.
    const errorEntries = consoleEntries.filter((c) => c.level === 'error');
    const autoMarkers: { t: number; label: string; kind: 'error' }[] = [];
    const seenErr = new Set<string>();
    for (const e of errorEntries) {
      if (e.ts < recording.startedAt || e.ts > recording.endedAt) continue;
      const firstLine = e.text.split('\n')[0].trim();
      const key = firstLine.slice(0, 60) + '|' + Math.round(e.ts / 2000);
      if (seenErr.has(key)) continue;
      seenErr.add(key);
      autoMarkers.push({ t: e.ts, label: firstLine.slice(0, 90) || 'Error', kind: 'error' });
      if (autoMarkers.length >= 5) break;
    }
    const userMarkers = recording.markers.map((m) => ({ ...m, kind: 'user' as const }));
    const markers = [...userMarkers, ...autoMarkers].sort((a, b) => a.t - b.t);
    const dom = captureDom();
    const identity = extractIdentity(network);
    const notes = form.notes ?? '';
    // The QA's investigation notes seed the bug description when they didn't fill the description field.
    const seededForm = { title: form.title, severity: form.severity, description: form.description || notes };
    payload = {
      type: 'report-session',
      pageUrl: location.href,
      form: seededForm,
      session: { events: recording.events, startedAt: recording.startedAt, endedAt: recording.endedAt },
      network,
      dom,
      identity,
      teamId: form.teamId ?? null,
      projectId: form.projectId ?? null,
      tags: form.tags ?? [],
      meta: {
        notes,
        pickedElements: form.pickedElements ?? [],
        drawings: form.drawings ?? [],
        // Only carried when the reporter filled at least one field — keeps the key off blank reports.
        ...(form.credentials ? { credentials: form.credentials } : {}),
        console: consoleEntries,
        errorCount: errorEntries.length,
        markers,
        visits: recording.visits,
        recording: {
          startedAt: recording.startedAt,
          endedAt: recording.endedAt,
          durationMs: recording.endedAt - recording.startedAt,
          mode: recording.mode,
        },
        pageTitle: document.title,
        userAgent: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        environment: collectEnvironment(),
      },
    };
  } catch (e) {
    return { ok: false, message: 'Could not package the recording: ' + String((e as Error)?.message || e) };
  }

  const reply = await sendToSw(payload);
  if (reply?.ok) {
    recorder.reset(); // fresh slate for the next bug; the rolling buffer keeps running
    const id = reply.bug?.humanId ?? 'bug';
    return { ok: true, message: `Filed ${id}${reply.warning ? ' · ' + reply.warning : ''}` };
  }
  if (reply?.error === 'not_connected') {
    return { ok: false, message: 'Not connected — open the be10x popup to connect a board first.' };
  }
  return { ok: false, message: 'Report failed: ' + (reply?.error || 'unknown') };
}

function boot(): void {
  const recorder = getRecorder(); // idempotent — returns the buffer armed at document_start
  const widget = mountWidget({
    isRecording: () => recorder.isRecording(),
    explicitStartedAt: () => recorder.explicitStartedAt(),
    onStart: () => recorder.start(),
    onStop: () => recorder.stop(),
    onMark: (label) => recorder.mark(label),
    onReport: report,
    loadTaxonomy,
  });

  // Clean teardown on navigation away — stops rrweb observers and removes the widget.
  const teardown = () => {
    try {
      widget.destroy();
    } catch {
      /* ignore */
    }
    try {
      recorder.teardown();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('pagehide', teardown, { once: true });
}

// Popup fallback stays available regardless of widget mount timing.
installCollectHandler();

// Arm the always-on rolling buffer as early as possible (rrweb itself waits for DOMContentLoaded for a
// clean first snapshot). The manifest injects this only in the top frame (all_frames: false).
getRecorder();

// Mount the widget once the DOM is ready.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
