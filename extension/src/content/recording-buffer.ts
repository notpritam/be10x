// ABOUTME: Pure recording state — full-snapshot segments (rolling-trimmed or explicit), markers, visits.
// ABOUTME: rrweb- and DOM-free so the trim / collect / ordering logic is unit-testable in plain node.
import type { Marker, Visit } from './protocol';

export type Timed = { timestamp: number };
export type Mode = 'rolling' | 'explicit';

export type Collected<E extends Timed> = {
  events: E[];
  startedAt: number;
  endedAt: number;
  markers: Marker[];
  visits: Visit[];
  mode: Mode;
};

const DEFAULT_WINDOW_MS = 120_000; // keep ~2 minutes of lead-up in rolling mode
const DEFAULT_MAX_EVENTS = 60_000; // hard memory guard for either mode
const MAX_TIMELINE = 500; // cap markers/visits so a long-lived tab can't grow them without limit

// Keeps rrweb events grouped into segments (each begins with a full-snapshot checkout, so any retained
// suffix still replays), plus the markers and visits placed during the recording.
export class RecordingBuffer<E extends Timed> {
  private segments: E[][] = [];
  private markers: Marker[] = [];
  private visits: Visit[] = [];
  private explicit = false;
  private explicitStartAt = 0;
  private stored: { events: E[]; startedAt: number; endedAt: number } | null = null; // last stopped explicit take
  private readonly windowMs: number;
  private readonly maxEvents: number;

  constructor(opts: { windowMs?: number; maxEvents?: number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  // rrweb passes isCheckout=true on the first event of each new full-snapshot segment.
  add(event: E, isCheckout: boolean, now = event.timestamp): void {
    if (isCheckout || this.segments.length === 0) this.segments.push([]);
    this.segments[this.segments.length - 1].push(event);
    if (!this.explicit) this.trimRolling(now);
    this.enforceMaxEvents();
  }

  // Begin a deliberate recording: stop rolling-trimming and anchor the start just before the caller
  // forces a full snapshot, so the collected take begins with a clean checkout.
  beginExplicit(startAt: number): void {
    this.explicit = true;
    this.explicitStartAt = startAt;
    this.stored = null; // a fresh take supersedes any previous stopped take
  }

  // End the deliberate recording: freeze a copy for reporting, then resume rolling.
  endExplicit(endAt: number): void {
    if (!this.explicit) return;
    this.stored = { events: this.eventsFrom(this.explicitStartAt), startedAt: this.explicitStartAt, endedAt: endAt };
    this.explicit = false;
  }

  get explicitActive(): boolean {
    return this.explicit;
  }
  hasStoredExplicit(): boolean {
    return this.stored !== null;
  }

  mark(t: number, label: string): void {
    this.markers.push({ t, label });
    if (this.markers.length > MAX_TIMELINE) this.markers.splice(0, this.markers.length - MAX_TIMELINE);
  }
  visit(t: number, url: string, title: string): void {
    this.visits.push({ t, url, title });
    if (this.visits.length > MAX_TIMELINE) this.visits.splice(0, this.visits.length - MAX_TIMELINE);
  }

  // Clear per-report state after a successful report so the next bug starts clean (buffer keeps rolling).
  reset(): void {
    this.markers = [];
    this.visits = [];
    this.stored = null;
  }

  // Package the current recording. `now` is the report/stop time (epoch ms).
  collect(now: number): Collected<E> {
    let events: E[];
    let startedAt: number;
    let endedAt = now;
    let mode: Mode;
    if (this.explicit) {
      events = this.eventsFrom(this.explicitStartAt);
      startedAt = this.explicitStartAt;
      mode = 'explicit';
    } else if (this.stored) {
      events = this.stored.events;
      startedAt = this.stored.startedAt;
      endedAt = this.stored.endedAt; // report the stopped take's own end, not "right now"
      mode = 'explicit';
    } else {
      events = this.flatten();
      startedAt = events.length ? events[0].timestamp : now - this.windowMs;
      mode = 'rolling';
    }
    return {
      events,
      startedAt,
      endedAt,
      markers: clampSort(this.markers, startedAt, endedAt),
      visits: clampSort(this.visits, startedAt, endedAt),
      mode,
    };
  }

  private flatten(): E[] {
    const out: E[] = [];
    for (const seg of this.segments) for (const e of seg) out.push(e);
    return out;
  }

  private eventsFrom(t: number): E[] {
    return this.flatten().filter((e) => e.timestamp >= t);
  }

  // Rolling: drop whole leading segments while the SECOND segment already begins at/before the window
  // boundary — the first retained segment's full snapshot then still covers the entire window.
  private trimRolling(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.segments.length >= 2 && this.segments[1][0] && this.segments[1][0].timestamp <= cutoff) {
      this.segments.shift();
    }
  }

  // Hard memory guard (both modes): drop oldest segments (always keep >=1) until under the event cap.
  private enforceMaxEvents(): void {
    let total = 0;
    for (const seg of this.segments) total += seg.length;
    while (total > this.maxEvents && this.segments.length > 1) {
      const dropped = this.segments.shift();
      total -= dropped ? dropped.length : 0;
      // Preserve the "explicit take starts at a full snapshot" invariant if we dropped its opening segment.
      const firstTs = this.segments[0]?.[0]?.timestamp ?? this.explicitStartAt;
      if (this.explicit && this.explicitStartAt < firstTs) this.explicitStartAt = firstTs;
    }
  }
}

// Keep only items on the recording clock, in chronological order.
function clampSort<T extends { t: number }>(items: T[], startedAt: number, endedAt: number): T[] {
  return items.filter((i) => i.t >= startedAt && i.t <= endedAt).sort((a, b) => a.t - b.t);
}
