import { describe, expect, it } from 'vitest';

import { SetClientClosingRequestSchema } from '../src/index.js';

describe('SetClientClosingRequestSchema (issue #131)', () => {
  it.each(['2026-10-07', '2024-02-29', '2026-12-31', '0001-01-01', '9999-12-31'])('accepts the real day %s', (closingDate) => {
    expect(SetClientClosingRequestSchema.parse({ closingDate })).toEqual({ closingDate });
  });

  it.each([
    '2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32',
    '0000-01-01', '2026-1-7', '26-10-07', '2026/10/07', '07/10/2026', '2026-10-07T00:00:00Z', ' 2026-10-07',
    '2026-10-07 ', '2026-10-07\n', '２０２６-10-07', '', 'hoje'
  ])('refuses %j, which is not a day written as YYYY-MM-DD', (closingDate) => {
    expect(SetClientClosingRequestSchema.safeParse({ closingDate }).success).toBe(false);
  });

  it('refuses a body without the date, with another type, or with a field of its own', () => {
    for (const body of [{}, { closingDate: null }, { closingDate: 20261007 }, { closingDate: ['2026-10-07'] }, { closingDate: '2026-10-07', status: 'archived' }, { closingDate: '2026-10-07', archivedAt: '2026-10-07T00:00:00Z' }]) {
      expect(SetClientClosingRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
