import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, daysOf, fullDayLabel, parseAnchor, periodOf, periodTitle, shiftAnchor, startOfWeek, todayInSaoPaulo } from './content-dates.js';
import { deadlineAlert, subtaskPercent } from './content-labels.js';

describe('todayInSaoPaulo', () => {
  it('is the day of São Paulo, not of UTC, around midnight', () => {
    // 03:00Z is midnight in São Paulo (UTC-3): one minute before is still the day before.
    expect(todayInSaoPaulo(new Date('2026-10-12T02:59:00Z'))).toBe('2026-10-11');
    expect(todayInSaoPaulo(new Date('2026-10-12T03:00:00Z'))).toBe('2026-10-12');
    expect(todayInSaoPaulo(new Date('2026-10-12T01:30:00Z'))).toBe('2026-10-11');
    expect(todayInSaoPaulo(new Date('2027-01-01T01:30:00Z'))).toBe('2026-12-31');
  });
});

describe('day arithmetic', () => {
  it('crosses months, years and the leap day', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(daysBetween('2026-10-11', '2026-10-13')).toBe(2);
    expect(daysBetween('2026-10-11', '2026-10-10')).toBe(-1);
  });

  it('starts the week on Monday', () => {
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // a Sunday belongs to the week that ends on it
    expect(startOfWeek('2026-10-12')).toBe('2026-10-12');
    expect(startOfWeek('2026-10-14')).toBe('2026-10-12');
  });
});

describe('periodOf', () => {
  it('draws whole weeks around a month', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    expect(periodOf('month', '2026-10-11')).toEqual({ from: '2026-09-28', to: '2026-11-01' });
    // February 2026 starts on a Sunday: its first row is the week of the 26th of January.
    expect(periodOf('month', '2026-02-10')).toEqual({ from: '2026-01-26', to: '2026-03-01' });
    // February 2028 has 29 days, ending on a Tuesday.
    expect(periodOf('month', '2028-02-10')).toEqual({ from: '2028-01-31', to: '2028-03-05' });
    // A month ending on a Sunday does not grow a row.
    expect(periodOf('month', '2026-05-10')).toEqual({ from: '2026-04-27', to: '2026-05-31' });
  });

  it('draws the week of the anchor, Monday to Sunday', () => {
    expect(periodOf('week', '2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(periodOf('week', '2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('never asks for more days than the API allows (93)', () => {
    for (let month = 1; month <= 12; month += 1) {
      const anchor = `2026-${String(month).padStart(2, '0')}-15`;
      expect(daysOf(periodOf('month', anchor)).length).toBeLessThanOrEqual(42);
    }
    expect(daysOf(periodOf('week', '2026-10-14'))).toHaveLength(7);
  });
});

describe('shiftAnchor', () => {
  it('moves a month to the first day of its neighbour, across years', () => {
    expect(shiftAnchor('month', '2026-10-11', 1)).toBe('2026-11-01');
    expect(shiftAnchor('month', '2026-10-11', -1)).toBe('2026-09-01');
    expect(shiftAnchor('month', '2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftAnchor('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(shiftAnchor('month', '2026-01-31', 1)).toBe('2026-02-01');
  });

  it('moves a week by seven days', () => {
    expect(shiftAnchor('week', '2026-10-11', 1)).toBe('2026-10-18');
    expect(shiftAnchor('week', '2026-10-11', -1)).toBe('2026-10-04');
  });
});

describe('periodTitle', () => {
  it('names the month and the week', () => {
    expect(periodTitle('month', '2026-10-11')).toBe('Outubro 2026');
    expect(periodTitle('month', '2027-03-01')).toBe('Março 2027');
    expect(periodTitle('week', '2026-10-14')).toBe('12 a 18 de outubro de 2026');
    expect(periodTitle('week', '2026-09-30')).toBe('28 de setembro a 4 de outubro de 2026');
    expect(periodTitle('week', '2026-12-31')).toBe('28 de dezembro de 2026 a 3 de janeiro de 2027');
  });

  it('spells a day in full', () => {
    expect(fullDayLabel('2026-10-12')).toBe('segunda-feira, 12 de outubro de 2026');
    expect(fullDayLabel('2026-10-11')).toBe('domingo, 11 de outubro de 2026');
  });
});

describe('parseAnchor', () => {
  it('uses the day in the URL when it is a real one, and today otherwise', () => {
    expect(parseAnchor('2026-10-14', '2026-10-11')).toBe('2026-10-14');
    expect(parseAnchor(null, '2026-10-11')).toBe('2026-10-11');
    expect(parseAnchor('2026-02-30', '2026-10-11')).toBe('2026-10-11');
    expect(parseAnchor('amanhã', '2026-10-11')).toBe('2026-10-11');
  });
});

describe('deadlineAlert', () => {
  const today = '2026-10-11';
  it('flags a past day as overdue and the next two days as near, today included', () => {
    expect(deadlineAlert({ publishOn: '2026-10-10', status: 'approved' }, today)).toBe('overdue');
    expect(deadlineAlert({ publishOn: '2026-10-11', status: 'in_production' }, today)).toBe('due-soon');
    expect(deadlineAlert({ publishOn: '2026-10-13', status: 'adjusting' }, today)).toBe('due-soon');
    expect(deadlineAlert({ publishOn: '2026-10-14', status: 'in_production' }, today)).toBeNull();
  });

  it('has no deadline once published or cancelled', () => {
    expect(deadlineAlert({ publishOn: '2026-10-01', status: 'published' }, today)).toBeNull();
    expect(deadlineAlert({ publishOn: '2026-10-01', status: 'cancelled' }, today)).toBeNull();
    expect(deadlineAlert({ publishOn: '2026-10-12', status: 'published' }, today)).toBeNull();
  });
});

describe('subtaskPercent', () => {
  it('rounds the approved share and says nothing without subtasks', () => {
    expect(subtaskPercent({ tasksApproved: 1, tasksTotal: 3 })).toBe(33);
    expect(subtaskPercent({ tasksApproved: 2, tasksTotal: 3 })).toBe(67);
    expect(subtaskPercent({ tasksApproved: 4, tasksTotal: 4 })).toBe(100);
    expect(subtaskPercent({ tasksApproved: 0, tasksTotal: 4 })).toBe(0);
    expect(subtaskPercent({ tasksApproved: 0, tasksTotal: 0 })).toBeNull();
  });
});
