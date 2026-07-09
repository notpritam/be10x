// ABOUTME: ISOLATED-world recorder — always-on rolling rrweb buffer + explicit Start/Stop, plus the
// ABOUTME: markers/visits timeline. Every rrweb call is wrapped so it never throws into the host page.
import { record } from 'rrweb';
import type { eventWithTime } from 'rrweb';
import { RecordingBuffer, type Collected } from './recording-buffer';
import { NAV_EVENT } from './protocol';

// rrweb excludes any element carrying this class (and its subtree) from capture — the widget wears it
// so the recorder never records its own UI.
export const BLOCK_CLASS = 'be10x-capture-block';

const CHECKOUT_EVERY_MS = 30_000; // a full snapshot every ~30s so a trimmed rolling buffer still replays
const ROLLING_WINDOW_MS = 120_000; // keep ~2 minutes of lead-up

export type Recording = Collected<eventWithTime>;

export type RecorderController = {
  start(): void;
  stop(): void;
  mark(label?: string): void;
  collectRecording(): Recording;
  isRecording(): boolean; // an explicit take is in progress
  explicitStartedAt(): number | null; // for the widget's elapsed-time indicator
  reset(): void; // drop markers/visits/stored take after a successful report
  setMaskAllInputs(on: boolean): void; // wired for later; takes effect on the next (re)start
  teardown(): void;
};

let controller: RecorderController | null = null;

// One recorder per frame. Idempotent so multiple importers share the same rolling buffer.
export function getRecorder(): RecorderController {
  if (!controller) controller = createRecorder();
  return controller;
}

function createRecorder(): RecorderController {
  const buffer = new RecordingBuffer<eventWithTime>({ windowMs: ROLLING_WINDOW_MS });
  let stopFn: (() => void) | null = null;
  let maskAllInputs = false;
  let explicitStart: number | null = null;
  let lastVisitUrl = '';
  let torn = false;

  const recordVisit = (url: string, title: string) => {
    try {
      if (!url || url === lastVisitUrl) return; // de-dupe repeated same-url notifications
      lastVisitUrl = url;
      buffer.visit(Date.now(), url, title || '');
    } catch {
      /* ignore */
    }
  };

  // MAIN-world net-hook forwards pushState/replaceState/popstate here as NAV_EVENT messages.
  const onNav = (e: MessageEvent) => {
    try {
      const d = e.data as { source?: string; url?: string; title?: string } | null;
      if (!d || d.source !== NAV_EVENT || typeof d.url !== 'string') return;
      recordVisit(d.url, d.title || document.title);
    } catch {
      /* ignore */
    }
  };

  const startRrweb = () => {
    try {
      if (stopFn || torn) return;
      const stop = record({
        emit(event, isCheckout) {
          try {
            buffer.add(event as eventWithTime, !!isCheckout);
          } catch {
            /* ignore a single bad event */
          }
        },
        checkoutEveryNms: CHECKOUT_EVERY_MS,
        blockClass: BLOCK_CLASS,
        maskAllInputs, // internal-use default false (real data); flag wired for later
        recordAfter: 'DOMContentLoaded', // clean first snapshot even though we inject at document_start
        errorHandler: () => true, // swallow rrweb-internal errors — never surface to the page
      });
      stopFn = typeof stop === 'function' ? stop : null;
    } catch {
      /* recording is best-effort — the page must keep working */
    }
  };

  const forceCheckout = () => {
    try {
      record.takeFullSnapshot(true);
    } catch {
      /* ignore */
    }
  };

  // Wire the nav bridge + the initial visit, then start recording.
  try {
    window.addEventListener('message', onNav);
  } catch {
    /* ignore */
  }
  recordVisit(location.href, document.title);
  startRrweb();
  try {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => recordVisit(location.href, document.title), { once: true });
    }
  } catch {
    /* ignore */
  }

  return {
    start() {
      try {
        if (buffer.explicitActive) return;
        explicitStart = Date.now();
        buffer.beginExplicit(explicitStart);
        forceCheckout(); // open the deliberate take at a clean full snapshot
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        if (buffer.explicitActive) buffer.endExplicit(Date.now());
        explicitStart = null;
      } catch {
        /* ignore */
      }
    },
    mark(label?: string) {
      try {
        buffer.mark(Date.now(), (label && label.trim()) || 'This is the bug');
      } catch {
        /* ignore */
      }
    },
    collectRecording() {
      return buffer.collect(Date.now());
    },
    isRecording() {
      return buffer.explicitActive;
    },
    explicitStartedAt() {
      return buffer.explicitActive ? explicitStart : null;
    },
    reset() {
      try {
        buffer.reset();
      } catch {
        /* ignore */
      }
    },
    setMaskAllInputs(on: boolean) {
      maskAllInputs = on;
    },
    teardown() {
      torn = true;
      try {
        stopFn?.();
      } catch {
        /* ignore */
      }
      stopFn = null;
      try {
        window.removeEventListener('message', onNav);
      } catch {
        /* ignore */
      }
    },
  };
}
