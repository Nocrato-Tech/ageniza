import { describe, expect, it } from 'vitest';
import { displayDay, monthPeriod } from './period';

describe('editorial month', () => {
  it('uses the day in São Paulo, including the UTC month boundary', () => {
    expect(monthPeriod(0, new Date('2026-11-01T01:30:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31', label: 'outubro de 2026' });
  });
  it('moves across years and leap February without UTC day drift', () => {
    expect(monthPeriod(1, new Date('2027-12-15T12:00:00Z')).from).toBe('2028-01-01');
    expect(monthPeriod(2, new Date('2027-12-15T12:00:00Z')).to).toBe('2028-02-29');
    expect(displayDay('2026-10-31')).toBe('31/10');
  });
});
