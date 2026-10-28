import { describe, expect, it } from 'vitest';

import { addDays, addMonths, fromTyped, fullDay, isCalendarDay, maskTyped, monthGrid, monthTitle, toTyped, weekdayIndex } from './calendar-days.js';

describe('calendar days', () => {
  it('tells a real day from one that only has the shape', () => {
    expect(isCalendarDay('2026-10-12')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-04-31')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('')).toBe(false);
    expect(isCalendarDay('12/10/2026')).toBe(false);
  });

  it('counts days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-12', -7)).toBe('2026-10-05');
  });

  it('moves by months and pulls the day back into a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-10-12', 12)).toBe('2027-10-12');
    expect(addMonths('2026-10-12', -12)).toBe('2025-10-12');
  });

  it('starts the week on Monday', () => {
    expect(weekdayIndex('2026-10-12')).toBe(0);
    expect(weekdayIndex('2026-10-18')).toBe(6);
    expect(weekdayIndex('2026-10-16')).toBe(4);
  });

  it('lays six whole weeks that hold the month, Monday first', () => {
    const grid = monthGrid('2026-10-16');

    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-09-28');
    expect(grid[41]).toBe('2026-11-08');
    expect(grid.filter((day) => day.startsWith('2026-10'))).toHaveLength(31);
    expect(monthGrid('2026-06-01')[0]).toBe('2026-06-01');
  });

  it('names the month and the day in full', () => {
    expect(monthTitle('2026-03-05')).toBe('março de 2026');
    expect(fullDay('2026-10-12')).toBe('segunda-feira, 12 de outubro de 2026');
    expect(fullDay('2026-10-18')).toBe('domingo, 18 de outubro de 2026');
  });

  it('writes a day as a person types it and reads it back', () => {
    expect(toTyped('2026-10-05')).toBe('05/10/2026');
    expect(toTyped('')).toBe('');
    expect(fromTyped('05/10/2026')).toBe('2026-10-05');
    expect(fromTyped(' 05/10/2026 ')).toBe('2026-10-05');
    expect(fromTyped('2026-10-05')).toBe('2026-10-05');
  });

  it.each(['', '5/10/2026', '05/10/26', '31/02/2026', '00/10/2026', '05/13/2026', '2026-02-30', 'abc'])('reads %j as no day', (text) => {
    expect(fromTyped(text)).toBe('');
  });

  it('masks what is typed, one slash at a time, digits only', () => {
    expect(maskTyped('1')).toBe('1');
    expect(maskTyped('12')).toBe('12');
    expect(maskTyped('121')).toBe('12/1');
    expect(maskTyped('1210')).toBe('12/10');
    expect(maskTyped('12102')).toBe('12/10/2');
    expect(maskTyped('12102026')).toBe('12/10/2026');
    expect(maskTyped('12/10/2026')).toBe('12/10/2026');
    expect(maskTyped('12a10b2026c99')).toBe('12/10/2026');
    expect(maskTyped('2026-10-12')).toBe('2026-10-12');
  });
});
