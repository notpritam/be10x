// ABOUTME: Unit tests for the bounded ring buffer — order under cap, oldest-dropped over cap, copy semantics.
// ABOUTME: Pure vitest; no browser, DOM, or Chrome APIs.
import { describe, it, expect } from 'vitest';
import { createRingBuffer } from './ring-buffer';

describe('createRingBuffer', () => {
  it('keeps insertion order while under capacity', () => {
    const b = createRingBuffer<number>(3);
    b.push(1);
    b.push(2);
    expect(b.toArray()).toEqual([1, 2]);
  });

  it('drops the oldest items once over capacity', () => {
    const b = createRingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) b.push(n);
    expect(b.toArray()).toEqual([3, 4, 5]);
  });

  it('toArray returns a copy, not the live backing array', () => {
    const b = createRingBuffer<number>(3);
    b.push(1);
    const snapshot = b.toArray();
    snapshot.push(999);
    expect(b.toArray()).toEqual([1]);
  });
});
