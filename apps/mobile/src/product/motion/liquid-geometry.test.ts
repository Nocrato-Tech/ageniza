import { describe, expect, it } from 'vitest';
import { liquidRect, usableRect } from './liquid-geometry';

describe('liquid selection geometry', () => {
  it('settles exactly on a measured cell without rounding its position or size', () => {
    const target = { x: 34.25, y: 60, width: 48.75, height: 56 };
    const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    expect(liquidRect(center, center, target)).toEqual(target);
  });

  it('stretches between its leading and trailing points symmetrically when direction reverses', () => {
    const lead = { x: 100, y: 70 };
    const trail = { x: 80, y: 60 };
    const size = { width: 50, height: 56 };
    const forward = liquidRect(lead, trail, size);
    expect(forward).toEqual({ x: 55, y: 32, width: 70, height: 66 });
    expect(liquidRect(trail, lead, size)).toEqual(forward);
  });

  it('bounds deformation during a jump across calendar rows', () => {
    const result = liquidRect({ x: 300, y: 300 }, { x: 25, y: 28 }, { width: 50, height: 56 });
    expect(result.width).toBe(82.5);
    expect(result.height).toBeCloseTo(75.6);
    expect(result.x + result.width / 2).toBe(162.5);
    expect(result.y + result.height / 2).toBe(164);
  });

  it('rejects hidden and invalid layout measurements', () => {
    expect(usableRect(null)).toBe(false);
    expect(usableRect({ x: 0, y: 0, width: 0, height: 56 })).toBe(false);
    expect(usableRect({ x: NaN, y: 0, width: 50, height: 56 })).toBe(false);
    expect(usableRect({ x: 0, y: 0, width: 50, height: 56 })).toBe(true);
  });
});
