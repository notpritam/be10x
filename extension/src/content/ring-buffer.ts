// ABOUTME: Bounded ring buffer — keeps only the most recent `cap` items, dropping the oldest on overflow.
// ABOUTME: Pure and dependency-free; backs the net-hook's capped in-page request log. Unit-tested.
export type RingBuffer<T> = {
  push(item: T): void;
  toArray(): T[];
};

export function createRingBuffer<T>(cap: number): RingBuffer<T> {
  const max = Math.max(0, Math.floor(cap));
  const items: T[] = [];
  return {
    push(item: T) {
      items.push(item);
      if (items.length > max) items.splice(0, items.length - max); // drop oldest to stay within cap
    },
    toArray() {
      return items.slice(); // copy — callers must not see (or mutate) the live backing array
    },
  };
}
