// ABOUTME: Unit tests for the pure recording buffer — rolling trim keeps the window + a full snapshot,
// ABOUTME: explicit take ranges, memory guard, and marker/visit ordering + clamping. No rrweb, no DOM.
import { describe, it, expect } from 'vitest';
import { RecordingBuffer } from './recording-buffer';

type E = { timestamp: number };
const ev = (timestamp: number): E => ({ timestamp });

// Feed one full-snapshot segment (first event isCheckout) followed by incremental events.
function addSegment(buf: RecordingBuffer<E>, times: number[]): void {
  times.forEach((t, i) => buf.add(ev(t), i === 0));
}

describe('rolling buffer trim', () => {
  it('keeps only the segments needed to cover the window, starting at a full snapshot', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 100 });
    addSegment(buf, [0, 10]); // segment A (checkout @0)
    addSegment(buf, [50, 60]); // segment B (checkout @50)
    addSegment(buf, [100, 110]); // segment C (checkout @100)
    addSegment(buf, [200, 210]); // segment D (checkout @200), now=210

    const { events, startedAt, mode } = buf.collect(210);
    // A(@0) and B(@50) are entirely before the window and redundant once C(@100) covers it.
    expect(events.map((e) => e.timestamp)).toEqual([100, 110, 200, 210]);
    expect(startedAt).toBe(100); // retained buffer begins at a checkout/full-snapshot
    expect(mode).toBe('rolling');
  });

  it('never trims below a single full-snapshot segment', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 100 });
    addSegment(buf, [0, 10, 20]); // one segment, well older than the window at collect time
    const { events, startedAt } = buf.collect(10_000);
    expect(events.map((e) => e.timestamp)).toEqual([0, 10, 20]);
    expect(startedAt).toBe(0);
  });
});

describe('explicit take', () => {
  it('captures from the forced snapshot to now, excluding earlier rolling events', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 100_000 });
    addSegment(buf, [0, 10]); // pre-existing rolling history
    buf.beginExplicit(2000);
    // recorder forces a full snapshot at start:
    buf.add(ev(2000), true);
    buf.add(ev(2010), false);
    buf.add(ev(2020), false);

    const r = buf.collect(2030);
    expect(r.mode).toBe('explicit');
    expect(r.startedAt).toBe(2000);
    expect(r.endedAt).toBe(2030);
    expect(r.events.map((e) => e.timestamp)).toEqual([2000, 2010, 2020]);
  });

  it('freezes a stopped take and reports its own end, then resets back to rolling', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 100_000 });
    buf.beginExplicit(2000);
    buf.add(ev(2000), true);
    buf.add(ev(2010), false);
    buf.endExplicit(2015);
    // more rolling activity afterwards
    buf.add(ev(9000), true);
    buf.add(ev(9010), false);

    const stopped = buf.collect(9999);
    expect(stopped.mode).toBe('explicit');
    expect(stopped.startedAt).toBe(2000);
    expect(stopped.endedAt).toBe(2015); // the take's own end, not "now"
    expect(stopped.events.map((e) => e.timestamp)).toEqual([2000, 2010]);

    buf.reset();
    const rolling = buf.collect(9999);
    expect(rolling.mode).toBe('rolling');
    expect(rolling.events.map((e) => e.timestamp)).toEqual([2000, 2010, 9000, 9010]);
  });
});

describe('memory guard', () => {
  it('drops oldest segments past the event cap (keeping at least one)', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 10_000_000, maxEvents: 3 });
    for (let t = 0; t < 5; t++) buf.add(ev(t), true); // 5 single-event checkout segments
    const { events } = buf.collect(100);
    expect(events.map((e) => e.timestamp)).toEqual([2, 3, 4]);
  });
});

describe('markers and visits', () => {
  it('are returned in chronological order and clamped to the recording window', () => {
    const buf = new RecordingBuffer<E>({ windowMs: 100_000 });
    buf.beginExplicit(2000);
    buf.add(ev(2000), true);
    buf.mark(2025, 'later');
    buf.mark(2005, 'earlier');
    buf.mark(1000, 'before-start'); // outside the window → clamped out
    buf.visit(2001, 'https://a/x', 'X');
    buf.visit(2050, 'https://a/y', 'Y');
    buf.visit(3000, 'https://a/z', 'Z'); // after endedAt → clamped out

    const r = buf.collect(2100);
    expect(r.markers).toEqual([
      { t: 2005, label: 'earlier' },
      { t: 2025, label: 'later' },
    ]);
    expect(r.visits.map((v) => v.url)).toEqual(['https://a/x', 'https://a/y']);
  });
});
