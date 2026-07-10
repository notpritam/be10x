// ABOUTME: ISOLATED-world entry — starts the rolling recorder, mounts the widget, keeps the popup's
// ABOUTME: point-in-time `collect` responder, and packages the widget's session report for the SW.
import { getRecorder } from './recorder';
import { mountWidget, type ReportForm } from './widget';
import { installCollectHandler, collectNetwork, captureDom, extractIdentity } from './collector';
import { pruneByAge } from './net-entry';

type ReportResult = { ok: boolean; message: string };
type SwReply = { ok?: boolean; error?: string; warning?: string; bug?: { humanId?: string } } | undefined;

const NET_WINDOW_SLACK_MS = 2000; // include requests started just before the recording window opened

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
    // Align console to the same recording window as network so the activity rail matches the replay clock.
    const consoleEntries = hook.console.filter((c) => c.ts >= recording.endedAt - windowMs);
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
      meta: {
        notes,
        pickedElements: form.pickedElements ?? [],
        console: consoleEntries,
        markers: recording.markers,
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
