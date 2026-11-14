import { describe, expect, it } from 'vitest';

import { addDays, dayOfMonthLabel, daysBetween, daysOf, fullDayLabel, monthPeriod, parseAnchor, periodOf, periodTitle, saoPauloClock, shiftAnchor, shortDayLabel, startOfWeek, todayInSaoPaulo, WEEKDAY_HEADERS, weekdayShortLabel } from './content-dates.js';
import { deadlineAlert, DISPLAY_LABELS, displayState, subtaskPercent } from './content-labels.js';

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

  it('starts the week on Sunday: a Sunday opens its own week and a Saturday closes the one before the next Sunday', () => {
    expect(startOfWeek('2026-10-11')).toBe('2026-10-11'); // a Sunday
    expect(startOfWeek('2026-10-17')).toBe('2026-10-11'); // the Saturday of that week
    expect(startOfWeek('2026-10-18')).toBe('2026-10-18'); // the next Sunday
    expect(startOfWeek('2026-10-14')).toBe('2026-10-11');
  });
});

describe('periodOf', () => {
  it('draws whole weeks around a month', () => {
    // October 2026 starts on a Thursday and ends on a Saturday: its last row ends on the 31st, with no row to spare.
    expect(periodOf('month', '2026-10-11')).toEqual({ from: '2026-09-27', to: '2026-10-31' });
    // February 2026 starts on a Sunday and ends on a Saturday: exactly four rows.
    expect(periodOf('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    // February 2028 has 29 days, ending on a Tuesday.
    expect(periodOf('month', '2028-02-10')).toEqual({ from: '2028-01-30', to: '2028-03-04' });
    // A month ending on a Sunday grows one row, because the week of a Sunday ends on the Saturday after it.
    expect(periodOf('month', '2026-05-10')).toEqual({ from: '2026-04-26', to: '2026-06-06' });
  });

  it('draws the week of the anchor, Sunday to Saturday, for an anchor on a Sunday and on a Saturday alike', () => {
    expect(periodOf('week', '2026-10-14')).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(periodOf('week', '2026-10-11')).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(periodOf('week', '2026-10-17')).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(daysOf(periodOf('month', '2026-10-11'))[0]).toBe('2026-09-27');
  });

  it('never asks for more days than the API allows (93)', () => {
    for (let month = 1; month <= 12; month += 1) {
      const anchor = `2026-${String(month).padStart(2, '0')}-15`;
      expect(daysOf(periodOf('month', anchor)).length).toBeLessThanOrEqual(42);
    }
    expect(daysOf(periodOf('week', '2026-10-14'))).toHaveLength(7);
  });
});

describe('monthPeriod', () => {
  it('is exactly the days of the month, with no neighbours', () => {
    expect(monthPeriod('2026-10-11')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthPeriod('2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthPeriod('2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthPeriod('2026-11-30')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthPeriod('2026-12-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthPeriod('2027-02-10')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(monthPeriod('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('weekdayShortLabel', () => {
  it('spells the weekday as the grid header does, from Sunday', () => {
    expect(WEEKDAY_HEADERS).toEqual(['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
    expect(weekdayShortLabel('2026-10-12')).toBe('seg');
    expect(weekdayShortLabel('2026-10-13')).toBe('ter');
    expect(weekdayShortLabel('2026-10-14')).toBe('qua');
    expect(weekdayShortLabel('2026-10-15')).toBe('qui');
    expect(weekdayShortLabel('2026-10-16')).toBe('sex');
    expect(weekdayShortLabel('2026-10-17')).toBe('sáb');
    expect(weekdayShortLabel('2026-10-18')).toBe('dom');
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
    expect(periodTitle('week', '2026-10-14')).toBe('11 a 17 de outubro de 2026');
    expect(periodTitle('week', '2026-09-30')).toBe('27 de setembro a 3 de outubro de 2026');
    expect(periodTitle('week', '2026-12-31')).toBe('27 de dezembro de 2026 a 2 de janeiro de 2027');
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

describe('saoPauloClock', () => {
  it('reads the day and the time of São Paulo, at midnight too', () => {
    expect(saoPauloClock(new Date('2026-10-12T01:30:00Z'))).toEqual({ day: '2026-10-11', time: '22:30:00' });
    expect(saoPauloClock(new Date('2026-10-12T03:00:00Z'))).toEqual({ day: '2026-10-12', time: '00:00:00' });
  });
});

describe('the words of a day', () => {
  it('says the day and month in full, and the short date of a tile of the feed', () => {
    expect(dayOfMonthLabel('2026-11-11')).toBe('11 de novembro');
    expect(shortDayLabel('2026-11-27')).toBe('27 nov');
    expect(shortDayLabel('2026-03-04')).toBe('4 mar');
  });
});

describe('displayState', () => {
  // 01:30Z of the 12th is 22:30 of the 11th in São Paulo.
  const now = saoPauloClock(new Date('2026-10-12T01:30:00Z'));

  it('is "agendado" for an approved content with an hour that has not come, on the São Paulo day', () => {
    expect(displayState({ status: 'approved', publishOn: '2026-10-11', publishAtTime: '23:00' }, now)).toBe('scheduled');
    expect(displayState({ status: 'approved', publishOn: '2026-10-12', publishAtTime: '08:00' }, now)).toBe('scheduled');
    expect(DISPLAY_LABELS.scheduled).toBe('Agendado');
  });

  it('is "aprovado" again once the hour passed, and without an hour', () => {
    expect(displayState({ status: 'approved', publishOn: '2026-10-11', publishAtTime: '22:00' }, now)).toBe('approved');
    expect(displayState({ status: 'approved', publishOn: '2026-10-12', publishAtTime: null }, now)).toBe('approved');
    expect(DISPLAY_LABELS.approved).toBe('Aprovado');
  });

  it('is "atrasado" by the publication day, and only for what is still open', () => {
    expect(displayState({ status: 'in_production', publishOn: '2026-10-10', publishAtTime: null }, now)).toBe('late');
    expect(displayState({ status: 'approved', publishOn: '2026-10-10', publishAtTime: '09:00' }, now)).toBe('late');
    expect(displayState({ status: 'in_production', publishOn: '2026-10-11', publishAtTime: null }, now)).toBe('in_production');
    expect(displayState({ status: 'published', publishOn: '2026-10-10', publishAtTime: null }, now)).toBe('published');
    expect(DISPLAY_LABELS.late).toBe('Atrasado');
  });
});
