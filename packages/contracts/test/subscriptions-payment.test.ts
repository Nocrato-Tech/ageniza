import { describe, expect, it } from 'vitest';

import {
  SUBSCRIPTION_INVOICES_PAGE_SIZE,
  SUBSCRIPTION_INVOICE_STATUSES,
  SaveSubscriptionTestCardRequestSchema,
  SubscriptionChargeResponseSchema,
  SubscriptionInvoiceListQuerySchema,
  SubscriptionInvoiceListResponseSchema,
  SubscriptionInvoiceSchema,
  SubscriptionQuoteLineSchema,
  SubscriptionQuoteResponseSchema,
  SubscriptionTestCardResponseSchema,
  SubscriptionTestCardSchema,
  TEST_CARD_BRAND
} from '../src/index.js';

// Scope redesign-igual, subtask W5-S1 (decision 2026-11-11): the test card the agency keeps, the invoices and the quote with its days and its lines.
const card = { last4: '4242', expMonth: 8, expYear: 2028, brand: 'test' };
const id = '11111111-1111-4111-8111-111111111111';
const without = (value: Record<string, unknown>, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

describe('the test card', () => {
  it('is the last four digits, the expiry and the brand test, and nothing else', () => {
    expect(SubscriptionTestCardSchema.parse(card)).toEqual(card);
    expect(SaveSubscriptionTestCardRequestSchema.parse(card)).toEqual(card);
    expect(SubscriptionTestCardResponseSchema.parse({ card })).toEqual({ card });
    expect(SubscriptionTestCardResponseSchema.parse({ card: null })).toEqual({ card: null });
    expect(TEST_CARD_BRAND).toBe('test');
  });

  it.each(['number', 'cardNumber', 'pan', 'cvc', 'cvv', 'securityCode', 'name', 'holder', 'holderName', 'expiry', 'zip', 'last4Extra', 'id', 'agencyId'])(
    'refuses the field %s in the body that saves it, with a plausible value and with a full number',
    (field) => {
      for (const value of ['4111111111111111', '123', 'Fulana de Tal', 4111111111111111, true, null, {}]) {
        expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, [field]: value }).success, `${field} = ${JSON.stringify(value)}`).toBe(false);
      }
    }
  );

  it('does not take a full number in the place of the last four digits either', () => {
    for (const last4 of ['4111111111111111', '41111', '411', '', 4242, null, undefined, '4 242', '４２４２', '٤٢٤٢', '4242\n', ' 424', '42a2', '0x42']) {
      expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, last4 }).success, JSON.stringify(last4)).toBe(false);
    }
    for (const last4 of ['0000', '9999', '4242', '0001']) {
      expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, last4 }).success, last4).toBe(true);
    }
  });

  it('keeps the months from 1 to 12 and the years from 2000 to 2099, both ends in and the neighbors out', () => {
    for (const expMonth of [1, 12]) expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, expMonth }).success, String(expMonth)).toBe(true);
    for (const expMonth of [0, 13, -1, 1.5, '8', null, undefined, Number.NaN]) {
      expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, expMonth }).success, String(expMonth)).toBe(false);
    }
    for (const expYear of [2000, 2099]) expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, expYear }).success, String(expYear)).toBe(true);
    for (const expYear of [1999, 2100, 28, 202_800, 2028.5, '2028', null, undefined]) {
      expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, expYear }).success, String(expYear)).toBe(false);
    }
  });

  it('is only the test brand', () => {
    for (const brand of ['visa', 'mastercard', 'Test', 'TEST', 'test ', '', null, undefined, 1]) {
      expect(SaveSubscriptionTestCardRequestSchema.safeParse({ ...card, brand }).success, String(brand)).toBe(false);
      expect(SubscriptionTestCardSchema.safeParse({ ...card, brand }).success, String(brand)).toBe(false);
    }
  });

  it('is complete: each of the four values is required', () => {
    for (const field of Object.keys(card)) {
      const rest = without(card, field);
      expect(SaveSubscriptionTestCardRequestSchema.safeParse(rest).success, field).toBe(false);
      expect(SubscriptionTestCardSchema.safeParse(rest).success, field).toBe(false);
    }
    expect(SaveSubscriptionTestCardRequestSchema.safeParse({}).success).toBe(false);
    expect(SubscriptionTestCardResponseSchema.safeParse({}).success).toBe(false);
  });

  it('is never answered with more than the four values', () => {
    expect(SubscriptionTestCardResponseSchema.safeParse({ card: { ...card, number: '4111111111111111' } }).success).toBe(false);
    expect(SubscriptionTestCardResponseSchema.safeParse({ card, savedBy: id }).success).toBe(false);
  });
});

describe('the invoices', () => {
  const invoice = { id, date: '2026-11-12T15:30:00.000Z', description: 'Plano Profissional', amountCents: 19700, status: 'paid' };

  it('are a day, a description, a value in cents and one of the four states of the owner\'s decision', () => {
    expect([...SUBSCRIPTION_INVOICE_STATUSES]).toEqual(['paid', 'declined', 'open', 'expired']);
    for (const status of SUBSCRIPTION_INVOICE_STATUSES) expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, status }).success, status).toBe(true);
    for (const status of ['pending', 'confirmed', 'Paid', '', null, undefined]) {
      expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, status }).success, String(status)).toBe(false);
    }
    expect(SubscriptionInvoiceSchema.parse(invoice)).toEqual(invoice);
  });

  it('refuse a value that is not whole cents, a negative one, a day that is not an instant and an empty description', () => {
    for (const amountCents of [-1, 197.5, '19700', null]) expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, amountCents }).success, String(amountCents)).toBe(false);
    expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, amountCents: 0 }).success).toBe(true);
    for (const date of ['ontem', '2026-11-12', 0, null]) expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, date }).success, String(date)).toBe(false);
    for (const description of ['', 'x'.repeat(201), null]) expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, description }).success, String(description).slice(0, 10)).toBe(false);
    expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, description: 'x'.repeat(200) }).success).toBe(true);
    expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, id: 'nope' }).success).toBe(false);
  });

  it('carry nothing of the provider or of who asked', () => {
    for (const field of ['provider', 'providerRef', 'requestedBy', 'agencyId', 'planKey']) {
      expect(SubscriptionInvoiceSchema.safeParse({ ...invoice, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('come in the paginated envelope of every listing, 20 a page', () => {
    expect(SUBSCRIPTION_INVOICES_PAGE_SIZE).toBe(20);
    const page = { data: [invoice], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } };
    expect(SubscriptionInvoiceListResponseSchema.parse(page)).toEqual(page);
    expect(SubscriptionInvoiceListResponseSchema.safeParse({ ...page, data: [{ ...invoice, status: 'x' }] }).success).toBe(false);
    expect(SubscriptionInvoiceListQuerySchema.parse({ page: '2', pageSize: '10' })).toEqual({ page: 2, pageSize: 10 });
    expect(SubscriptionInvoiceListQuerySchema.safeParse({ agencyId: id }).success).toBe(false);
    expect(SubscriptionInvoiceListQuerySchema.safeParse({ page: '1e20' }).success).toBe(false);
  });
});

describe('the quote', () => {
  const plan = { kind: 'plan', quantity: 1, unitCents: 19700, totalCents: 19700 };
  const clients = { kind: 'extra_clients', quantity: 5, unitCents: 600, totalCents: 3000 };
  const storage = { kind: 'extra_storage_gib', quantity: 30, unitCents: 40, totalCents: 1200 };
  const quote = {
    effect: 'upgrade', monthlyCents: 23900, amountCents: 6667, effectiveAt: '2026-11-12T15:30:00.000Z', daysLeft: 20, periodDays: 30, lines: [plan, clients, storage]
  };
  const refused = (change: Record<string, unknown>) => SubscriptionQuoteResponseSchema.safeParse({ ...quote, ...change }).success;

  it('tells the days left and the days of the period, and the lines of the sum', () => {
    expect(SubscriptionQuoteResponseSchema.parse(quote)).toEqual(quote);
    expect(SubscriptionQuoteResponseSchema.parse({ ...quote, effect: 'subscribe', daysLeft: null, periodDays: null, monthlyCents: 19700, amountCents: 19700, lines: [plan] }))
      .toMatchObject({ daysLeft: null, periodDays: null, lines: [plan] });
  });

  it('refuses a quote without the days or the lines, and the old shape', () => {
    for (const body of [
      without(quote, 'daysLeft'), without(quote, 'periodDays'), without(quote, 'lines'),
      { effect: 'upgrade', monthlyCents: 19700, amountCents: 6667, effectiveAt: quote.effectiveAt }
    ]) {
      expect(SubscriptionQuoteResponseSchema.safeParse(body).success).toBe(false);
    }
  });

  it('refuses lines that do not add up to the monthly price, by a cent either way', () => {
    expect(refused({ monthlyCents: 23901 })).toBe(false);
    expect(refused({ monthlyCents: 23899 })).toBe(false);
    expect(refused({ lines: [plan, clients] })).toBe(false);
    expect(refused({ lines: [plan, { ...clients, totalCents: 3001, unitCents: 600 }, storage] })).toBe(false);
  });

  it('refuses a line whose total is not the quantity times the unit price', () => {
    expect(SubscriptionQuoteLineSchema.safeParse(clients).success).toBe(true);
    for (const change of [{ totalCents: 2999 }, { totalCents: 3001 }, { quantity: 4 }, { unitCents: 601 }]) {
      expect(SubscriptionQuoteLineSchema.safeParse({ ...clients, ...change }).success, JSON.stringify(change)).toBe(false);
    }
    for (const change of [{ quantity: 0 }, { quantity: 1.5 }, { unitCents: 0 }, { totalCents: 0 }, { kind: 'discount' }, { name: 'Clientes' }]) {
      expect(SubscriptionQuoteLineSchema.safeParse({ ...clients, ...change }).success, JSON.stringify(change)).toBe(false);
    }
  });

  it('starts with the plan, once, and takes each extra at most once', () => {
    expect(refused({ lines: [clients, plan, storage] })).toBe(false);
    // An extra of one unit in front of the plan has the quantity the plan has, so only the kind can tell it is not the plan.
    expect(refused({ lines: [{ kind: 'extra_clients', quantity: 1, unitCents: 600, totalCents: 600 }, plan], monthlyCents: 19700 + 600 })).toBe(false);
    expect(refused({ lines: [plan, { kind: 'extra_clients', quantity: 1, unitCents: 600, totalCents: 600 }], monthlyCents: 19700 + 600 })).toBe(true);
    expect(refused({ lines: [plan, clients, clients], monthlyCents: 19700 + 6000 })).toBe(false);
    expect(refused({ lines: [{ ...plan, quantity: 2, totalCents: 39400 }], monthlyCents: 39400 })).toBe(false);
    expect(refused({ lines: [], monthlyCents: 0 })).toBe(false);
    expect(refused({ lines: [plan, clients, storage, plan], monthlyCents: 23900 + 19700 })).toBe(false);
    expect(refused({ lines: [plan], monthlyCents: 19700 })).toBe(true);
  });

  it('keeps the days together and within the period, both ends in', () => {
    expect(refused({ daysLeft: null })).toBe(false);
    expect(refused({ periodDays: null })).toBe(false);
    expect(refused({ daysLeft: null, periodDays: null })).toBe(true);
    expect(refused({ daysLeft: 30, periodDays: 30 })).toBe(true);
    expect(refused({ daysLeft: 31, periodDays: 30 })).toBe(false);
    expect(refused({ daysLeft: 0, periodDays: 30 })).toBe(true);
    expect(refused({ daysLeft: -1 })).toBe(false);
    expect(refused({ daysLeft: 1.5 })).toBe(false);
    expect(refused({ periodDays: 0, daysLeft: 0 })).toBe(false);
  });

  it('refuses a field it does not know', () => {
    expect(refused({ card: '4111' })).toBe(false);
  });

  it('leaves the answer to a request for a charge as it was: no days, no lines', () => {
    const charge = { effect: 'upgrade', monthlyCents: 23900, amountCents: 6667, effectiveAt: quote.effectiveAt, chargeId: id };
    expect(SubscriptionChargeResponseSchema.parse(charge)).toEqual(charge);
    expect(SubscriptionChargeResponseSchema.parse({ ...charge, chargeId: null }).chargeId).toBeNull();
    expect(SubscriptionChargeResponseSchema.safeParse({ ...charge, daysLeft: 20 }).success).toBe(false);
    expect(SubscriptionChargeResponseSchema.safeParse({ effect: 'upgrade', monthlyCents: 1, amountCents: 1, effectiveAt: quote.effectiveAt }).success).toBe(false);
  });
});
