import { describe, expect, it } from 'vitest';

import { QUIET_SECONDS, secondsUntilClockIsQuiet } from './quiet-clock.js';

describe('the quiet clock', () => {
  it('lets a run start in the middle of the day and waits out the minute on each side of São Paulo midnight', () => {
    expect(secondsUntilClockIsQuiet(12 * 3600, 12 * 3600)).toBe(0);
    expect(secondsUntilClockIsQuiet(QUIET_SECONDS, 86_400 - QUIET_SECONDS)).toBe(0);
    expect(secondsUntilClockIsQuiet(10, 86_390)).toBe(QUIET_SECONDS - 10);
    expect(secondsUntilClockIsQuiet(QUIET_SECONDS - 1, 86_000)).toBe(1);
    expect(secondsUntilClockIsQuiet(86_370, 30)).toBe(30 + QUIET_SECONDS);
    expect(secondsUntilClockIsQuiet(86_000, QUIET_SECONDS - 1)).toBe(QUIET_SECONDS - 1 + QUIET_SECONDS);
  });

  it('takes a wider window for a suite that ages events across the midnight', () => {
    const window = { afterMidnightSeconds: 100, beforeMidnightSeconds: 90 };

    expect(secondsUntilClockIsQuiet(12 * 3600, 12 * 3600, window)).toBe(0);
    expect(secondsUntilClockIsQuiet(100, 86_300, window)).toBe(0);
    expect(secondsUntilClockIsQuiet(10, 86_390, window)).toBe(90);
    expect(secondsUntilClockIsQuiet(86_370, 30, window)).toBe(130);
    expect(secondsUntilClockIsQuiet(86_310, 90, window)).toBe(0);
    expect(secondsUntilClockIsQuiet(86_325, 75, window)).toBe(175);
    expect(secondsUntilClockIsQuiet(80, 86_320, window)).toBe(20);
  });
});
