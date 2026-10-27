import { describe, expect, it } from 'vitest';

import { createWindowCounter } from './rate-limit.js';

const WINDOW = { max: 3, windowMs: 60_000 };

describe('the counter of the limits of the approval link (issue #712)', () => {
  it('lets max pass in a window and limits the next one, counting the ones that were refused', () => {
    const counter = createWindowCounter(() => 0);
    expect([1, 2, 3, 4, 5].map(() => counter.hit('k', WINDOW).limited)).toEqual([false, false, false, true, true]);
  });

  it('keeps a bucket per key', () => {
    const counter = createWindowCounter(() => 0);
    for (let hit = 0; hit < 4; hit += 1) counter.hit('a', WINDOW);
    expect(counter.hit('a', WINDOW).limited).toBe(true);
    expect(counter.hit('b', WINDOW).limited).toBe(false);
  });

  it('opens a new window when the old one ends, and says how long is left in seconds, at least one', () => {
    let now = 0;
    const counter = createWindowCounter(() => now);
    for (let hit = 0; hit < 3; hit += 1) counter.hit('k', WINDOW);
    now = 59_001;
    expect(counter.hit('k', WINDOW)).toEqual({ limited: true, retryAfterSeconds: 1 });
    now = 10_000;
    expect(counter.hit('k', WINDOW)).toEqual({ limited: true, retryAfterSeconds: 50 });
    now = 60_000;
    expect(counter.hit('k', WINDOW)).toEqual({ limited: false, retryAfterSeconds: 60 });
    expect(counter.hit('k', WINDOW).limited).toBe(false);
    expect(counter.hit('k', WINDOW).limited).toBe(false);
    expect(counter.hit('k', WINDOW).limited).toBe(true);
  });

  it('keeps a live bucket when it sweeps the ones whose window ended', () => {
    let now = 0;
    const counter = createWindowCounter(() => now);
    for (let key = 0; key < 10_000; key += 1) counter.hit(`old-${key}`, WINDOW);
    counter.hit('live', { max: 1, windowMs: 1_000_000 });
    now = 61_000;
    counter.hit('trigger', WINDOW);
    expect(counter.hit('live', { max: 1, windowMs: 1_000_000 }).limited).toBe(true);
    expect(counter.hit('old-0', WINDOW).limited).toBe(false);
  });
});
