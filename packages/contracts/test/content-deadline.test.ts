import { describe, expect, it } from 'vitest';

import { CONTENT_DEADLINE_OPEN_STATUSES, CONTENT_DUE_SOON_DAYS, contentDeadline } from '../src/index.js';

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
