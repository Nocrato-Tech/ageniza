import { SubscriptionQuoteResponseSchema, type SubscriptionPlansResponse } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { quoteFromRow, quoteLines, type QuoteRow } from './quote.js';

const catalog: SubscriptionPlansResponse = {
  plans: [
    { key: 'essencial', name: 'Essencial', clientLimit: 10, storageBytes: 21_474_836_480, monthlyCents: 9700 },
    { key: 'profissional', name: 'Profissional', clientLimit: 30, storageBytes: 107_374_182_400, monthlyCents: 19_700 }
  ],
  extraClientCents: 600,
  extraStorageGibCents: 40,
  maxExtra: 10_000
};

const none = { extraClients: 0, extraStorageGib: 0 };
const row = (overrides: Partial<QuoteRow>): QuoteRow => ({
  effect: 'upgrade', monthly_cents: 19_700, amount_cents: 6800, effective_at: new Date('2026-11-15T12:00:00.000Z'), days_left: 15, period_days: 30, ...overrides
});

describe('the days of a quote', () => {
  it('shows both for a raise', () => {
    expect(quoteFromRow(row({}), { planKey: 'profissional', ...none }, catalog)).toMatchObject({ effect: 'upgrade', daysLeft: 15, periodDays: 30 });
  });

  // The contract lets the days sit on any effect, so the mapping is what keeps them off a first subscription and a decrease.
  it.each(['subscribe', 'downgrade'] as const)('shows none for a %s, whatever the database row carries', (effect) => {
    const quote = quoteFromRow(row({ effect, days_left: 15, period_days: 30 }), { planKey: 'profissional', ...none }, catalog);
    expect(quote).toMatchObject({ effect, daysLeft: null, periodDays: null });
  });

  it.each([
    ['no days left', { days_left: null, period_days: 30 }],
    ['no period', { days_left: 15, period_days: null }]
  ] as const)('shows none for a raise with %s, never one without the other', (_label, days) => {
    expect(quoteFromRow(row(days), { planKey: 'profissional', ...none }, catalog)).toMatchObject({ daysLeft: null, periodDays: null });
  });

  it('keeps the edge of a raise with nothing left of the period', () => {
    expect(quoteFromRow(row({ days_left: 0 }), { planKey: 'profissional', ...none }, catalog)).toMatchObject({ daysLeft: 0, periodDays: 30 });
  });
});

describe('the lines of a quote', () => {
  it('is the plan alone when no extra is bought, and each extra at its unit price when it is', () => {
    expect(quoteLines({ planKey: 'essencial', ...none }, catalog)).toEqual([{ kind: 'plan', quantity: 1, unitCents: 9700, totalCents: 9700 }]);
    expect(quoteLines({ planKey: 'profissional', extraClients: 3, extraStorageGib: 10 }, catalog)).toEqual([
      { kind: 'plan', quantity: 1, unitCents: 19_700, totalCents: 19_700 },
      { kind: 'extra_clients', quantity: 3, unitCents: 600, totalCents: 1800 },
      { kind: 'extra_storage_gib', quantity: 10, unitCents: 40, totalCents: 400 }
    ]);
    expect(quoteLines({ planKey: 'essencial', extraClients: 0, extraStorageGib: 2 }, catalog).map((line) => line.kind)).toEqual(['plan', 'extra_storage_gib']);
    expect(quoteLines({ planKey: 'essencial', extraClients: 1, extraStorageGib: 0 }, catalog).map((line) => line.kind)).toEqual(['plan', 'extra_clients']);
  });

  it('adds up to the monthly price the database computed, and the whole quote is a valid response', () => {
    const change = { planKey: 'profissional', extraClients: 3, extraStorageGib: 10 };
    const quote = quoteFromRow(row({ monthly_cents: 19_700 + 1800 + 400 }), change, catalog);
    expect(quote.lines.reduce((sum, line) => sum + line.totalCents, 0)).toBe(quote.monthlyCents);
    expect(SubscriptionQuoteResponseSchema.safeParse(quote).success).toBe(true);
  });

  it('refuses a plan the catalog does not have instead of guessing a price', () => {
    expect(() => quoteLines({ planKey: 'ghost', ...none }, catalog)).toThrow(/ghost/);
  });
});
