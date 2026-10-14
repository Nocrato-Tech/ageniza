import { describe, expect, it } from 'vitest';

import { rovingTarget } from './roving.js';

const all = [true, true, true, true];
const gap = [true, false, true, true];

describe('rovingTarget', () => {
  it.each([
    ['ArrowRight', 0, all, 1],
    ['ArrowRight', 3, all, 0],
    ['ArrowLeft', 1, all, 0],
    ['ArrowLeft', 0, all, 3],
    ['ArrowRight', 0, gap, 2],
    ['ArrowLeft', 2, gap, 0],
    ['Home', 3, gap, 0],
    ['End', 0, gap, 3],
    ['Home', 2, [false, false, true, true], 2],
    ['End', 0, [true, true, false, false], 1]
  ] as const)('%s from %i over %j goes to %i', (key, current, enabled, expected) => {
    expect(rovingTarget(key, current, enabled, false)).toBe(expected);
  });

  it('moves on the vertical arrows only when the group allows it', () => {
    expect(rovingTarget('ArrowDown', 0, all, false)).toBeNull();
    expect(rovingTarget('ArrowUp', 1, all, false)).toBeNull();
    expect(rovingTarget('ArrowDown', 0, all, true)).toBe(1);
    expect(rovingTarget('ArrowUp', 0, all, true)).toBe(3);
  });

  it('ignores any other key', () => {
    expect(rovingTarget('Enter', 0, all, true)).toBeNull();
    expect(rovingTarget(' ', 0, all, true)).toBeNull();
    expect(rovingTarget('a', 0, all, true)).toBeNull();
  });

  it('stays put when nothing else can take focus', () => {
    expect(rovingTarget('ArrowRight', 0, [true, false, false], false)).toBeNull();
    expect(rovingTarget('ArrowRight', 0, [true], false)).toBeNull();
    expect(rovingTarget('Home', 0, [false, false], false)).toBeNull();
    expect(rovingTarget('End', 0, [false, false], false)).toBeNull();
  });
});
