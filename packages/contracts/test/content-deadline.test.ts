import { describe, expect, it } from 'vitest';

import { CONTENT_DEADLINE_OPEN_STATUSES, CONTENT_DUE_SOON_DAYS, contentDaysLate, contentDeadline, contentIsScheduled } from '../src/index.js';

// Issue #549: the one definition of the deadline of a content. The expected answers are written out, never computed from the
// constants the function reads, so a change to a constant or to the comparison turns a line red.
const TODAY = '2026-10-11';

describe('contentDeadline', () => {
  it.each([
    ['two days before today', '2026-10-09', 'overdue'],
    ['the day before today', '2026-10-10', 'overdue'],
    ['today', '2026-10-11', 'due-soon'],
    ['tomorrow', '2026-10-12', 'due-soon'],
    ['two days ahead, the last of the window', '2026-10-13', 'due-soon'],
    ['three days ahead', '2026-10-14', null],
    ['a month ahead', '2026-11-11', null]
  ] as const)('answers %s for every state that is still open', (_label, publishOn, expected) => {
    for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const) {
      expect(contentDeadline({ status, publishOn }, TODAY), status).toBe(expected);
    }
  });

  it.each(['published', 'cancelled'] as const)('answers nothing for a %s content, whatever the day', (status) => {
    for (const publishOn of ['2026-10-01', '2026-10-11', '2026-10-12', '2027-01-01']) {
      expect(contentDeadline({ status, publishOn }, TODAY)).toBeNull();
    }
  });

  it('crosses a month and a year by calendar days', () => {
    expect(contentDeadline({ status: 'approved', publishOn: '2026-12-31' }, '2026-12-30')).toBe('due-soon');
    expect(contentDeadline({ status: 'approved', publishOn: '2027-01-01' }, '2026-12-30')).toBe('due-soon');
    expect(contentDeadline({ status: 'approved', publishOn: '2027-01-02' }, '2026-12-30')).toBeNull();
    expect(contentDeadline({ status: 'approved', publishOn: '2026-02-28' }, '2026-03-01')).toBe('overdue');
  });

  it('is built on four open states and a window of two days', () => {
    expect([...CONTENT_DEADLINE_OPEN_STATUSES]).toEqual(['in_production', 'awaiting_approval', 'adjusting', 'approved']);
    expect(CONTENT_DUE_SOON_DAYS).toBe(2);
  });
});

// Decision 2026-11-11: "Agendado" is an approved content with a publication hour whose São Paulo instant has not passed.
describe('contentIsScheduled', () => {
  const now = { day: '2026-11-11', time: '14:30:00' };
  const approved = (publishOn: string, publishAtTime: string | null) => ({ status: 'approved' as const, publishOn, publishAtTime });

  it.each([
    ['a later day', '2026-11-12', '00:00', true],
    ['a later month', '2026-12-01', '08:00', true],
    ['today, an hour later', '2026-11-11', '15:30', true],
    ['today, a minute later', '2026-11-11', '14:31', true],
    ['today, at the very minute: 14:30:00 is not later than 14:30:00', '2026-11-11', '14:30', false],
    ['today, a minute earlier', '2026-11-11', '14:29', false],
    ['today, at midnight', '2026-11-11', '00:00', false],
    ['yesterday, even at the last minute', '2026-11-10', '23:59', false]
  ] as const)('answers %s', (_label, publishOn, time, expected) => {
    expect(contentIsScheduled(approved(publishOn, time), now)).toBe(expected);
  });

  it('answers a second past the minute as later than the minute, so the hour of the day is read with its seconds', () => {
    expect(contentIsScheduled(approved('2026-11-11', '14:30'), { day: '2026-11-11', time: '14:29:59' })).toBe(true);
    expect(contentIsScheduled(approved('2026-11-11', '14:30'), { day: '2026-11-11', time: '14:30:01' })).toBe(false);
  });

  it('stays "Aprovado" when there is no hour, whatever the day', () => {
    for (const publishOn of ['2026-11-10', '2026-11-11', '2026-11-12', '2027-01-01']) {
      expect(contentIsScheduled(approved(publishOn, null), now), publishOn).toBe(false);
    }
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'published', 'cancelled'] as const)('is never a %s content', (status) => {
    expect(contentIsScheduled({ status, publishOn: '2026-12-01', publishAtTime: '10:00' }, now)).toBe(false);
  });

  it('crosses a month and a year by the day, not by the hour', () => {
    expect(contentIsScheduled(approved('2027-01-01', '00:00'), { day: '2026-12-31', time: '23:59:59' })).toBe(true);
    expect(contentIsScheduled(approved('2026-12-31', '23:59'), { day: '2026-12-31', time: '23:59:00' })).toBe(false);
  });
});

describe('contentDaysLate', () => {
  it.each([
    ['one day before today', '2026-10-10', 1],
    ['a week before', '2026-10-04', 7],
    ['across a month', '2026-09-30', 11],
    ['across a year', '2025-10-11', 365]
  ] as const)('counts %s as %i for every state that is still open', (_label, publishOn, expected) => {
    for (const status of CONTENT_DEADLINE_OPEN_STATUSES) {
      expect(contentDaysLate({ status, publishOn }, TODAY), status).toBe(expected);
    }
  });

  it('is null from today on: today is not late', () => {
    for (const publishOn of ['2026-10-11', '2026-10-12', '2027-01-01']) {
      expect(contentDaysLate({ status: 'awaiting_approval', publishOn }, TODAY), publishOn).toBeNull();
    }
  });

  it.each(['published', 'cancelled'] as const)('is null for a %s content, whatever the day', (status) => {
    expect(contentDaysLate({ status, publishOn: '2026-01-01' }, TODAY)).toBeNull();
  });

  it('agrees with the deadline: late exactly when contentDeadline says overdue', () => {
    for (const publishOn of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) {
      expect(contentDaysLate({ status: 'adjusting', publishOn }, TODAY) !== null, publishOn).toBe(contentDeadline({ status: 'adjusting', publishOn }, TODAY) === 'overdue');
    }
  });
});
