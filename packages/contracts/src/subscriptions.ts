import { z } from 'zod';

import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * Billing of an agency (issue #772, epic #770). Only the Owner reads or changes any of this. The plan and the ceilings are
 * written by the server alone, from a confirmation of the payment provider; nothing here lets a screen write them.
 */

/** The most extra clients or extra GiB one subscription buys; the database refuses more (`subscription_*_check`). */
export const MAX_SUBSCRIPTION_EXTRA = 10_000;

/** The key of a plan, as the database spells it. The database refuses a key that is not a plan (`A0116`). */
export const SubscriptionPlanKeySchema = z.string().regex(/^[a-z]{3,20}$/);

export const SubscriptionChangeRequestSchema = z.object({
  planKey: SubscriptionPlanKeySchema,
  extraClients: z.number().int().min(0).max(MAX_SUBSCRIPTION_EXTRA),
  extraStorageGib: z.number().int().min(0).max(MAX_SUBSCRIPTION_EXTRA)
}).strict();

export const SubscriptionChargePathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  chargeId: z.string().uuid()
}).strict();

export const SubscriptionPlanSchema = z.object({
  key: SubscriptionPlanKeySchema,
  name: z.string().min(1).max(64),
  clientLimit: z.number().int().positive(),
  storageBytes: z.number().int().positive(),
  monthlyCents: z.number().int().positive()
}).strict();

export const SubscriptionPlansResponseSchema = z.object({
  plans: z.array(SubscriptionPlanSchema),
  extraClientCents: z.number().int().positive(),
  extraStorageGibCents: z.number().int().positive(),
  maxExtra: z.literal(MAX_SUBSCRIPTION_EXTRA)
}).strict();

/**
 * What a change does: `subscribe` starts a subscription, `upgrade` raises a limit now and charges the rest of the period,
 * `downgrade` waits for the next period and charges nothing.
 */
export const SubscriptionEffectSchema = z.enum(['subscribe', 'upgrade', 'downgrade']);

const SubscriptionQuoteFieldsSchema = z.object({
  effect: SubscriptionEffectSchema,
  monthlyCents: z.number().int().nonnegative(),
  /** What is charged now. Zero for a downgrade. */
  amountCents: z.number().int().nonnegative(),
  effectiveAt: z.string().datetime()
}).strict();

/** One line of the sum of a monthly price: the plan (quantity 1) or an extra bought (quantity of units at the unit price). */
export const SubscriptionQuoteLineSchema = z.object({
  kind: z.enum(['plan', 'extra_clients', 'extra_storage_gib']),
  quantity: z.number().int().positive(),
  unitCents: z.number().int().positive(),
  totalCents: z.number().int().positive()
}).strict().refine((line) => line.quantity * line.unitCents === line.totalCents, 'totalCents must be quantity times unitCents');

/**
 * The quote tells what the sum of the monthly price is made of and, for a raise, which share of the period it charges now: `daysLeft`
 * of `periodDays` (the day that has begun counts). Both are null when nothing is prorated: a first subscription charges the whole
 * month and a decrease charges nothing.
 */
export const SubscriptionQuoteResponseSchema = SubscriptionQuoteFieldsSchema.extend({
  daysLeft: z.number().int().nonnegative().nullable(),
  periodDays: z.number().int().positive().nullable(),
  /** The plan first, then the extras bought; they add up to `monthlyCents`. */
  lines: z.array(SubscriptionQuoteLineSchema).min(1).max(3)
}).strict().superRefine((quote, context) => {
  const kinds = quote.lines.map((line) => line.kind);
  if (kinds[0] !== 'plan' || quote.lines[0]?.quantity !== 1 || new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'The lines are the plan, once, and then each extra at most once.' });
  }
  if (quote.lines.reduce((sum, line) => sum + line.totalCents, 0) !== quote.monthlyCents) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'The lines must add up to monthlyCents.' });
  }
  if ((quote.daysLeft === null) !== (quote.periodDays === null) || (quote.daysLeft !== null && quote.periodDays !== null && quote.daysLeft > quote.periodDays)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['daysLeft'], message: 'daysLeft and periodDays come together, and the days left are not more than the period.' });
  }
});

export const SubscriptionChargeResponseSchema = SubscriptionQuoteFieldsSchema.extend({
  /** The charge the provider has to confirm; null for a downgrade, which charges nothing, and for a raise that costs nothing, which is applied at once. */
  chargeId: z.string().uuid().nullable()
}).strict();

export const SubscriptionTermsSchema = z.object({
  planKey: SubscriptionPlanKeySchema,
  extraClients: z.number().int().nonnegative(),
  extraStorageGib: z.number().int().nonnegative()
}).strict();

export const SubscriptionSchema = z.object({
  planKey: SubscriptionPlanKeySchema,
  extraClients: z.number().int().nonnegative(),
  extraStorageGib: z.number().int().nonnegative(),
  provider: z.enum(['simulado', 'asaas', 'cortesia']),
  /** The end of the paid period; null for a courtesy plan, which has none. */
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** A decrease that waits for the next period. */
  pending: SubscriptionTermsSchema.nullable(),
  monthlyCents: z.number().int().nonnegative(),
  /** What the next period costs; null for a canceled or courtesy subscription. */
  nextMonthlyCents: z.number().int().nonnegative().nullable(),
  clientLimit: z.number().int().positive(),
  storageBytes: z.number().int().positive(),
  usedClients: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  /** The last day to pay (`YYYY-MM-DD`, day of São Paulo) while the period ended and the agency still writes. */
  graceEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
}).strict();

export const SubscriptionOverviewResponseSchema = z.object({
  /** Null while the agency has no subscription (a trial, for instance). */
  subscription: SubscriptionSchema.nullable(),
  /** The provider this environment pays with: `simulado` (never in production), `asaas` once it exists; null when nobody can pay. */
  paymentProvider: z.enum(['simulado', 'asaas']).nullable()
}).strict();

/** The only brand the simulated provider takes; a real network's card does not exist here. */
export const TEST_CARD_BRAND = 'test';

/** The four values of a test card the agency keeps (decision 2026-11-11). The years are the ones the database accepts (`agency_test_cards_exp_year_check`). */
export const TEST_CARD_FIRST_YEAR = 2000;
export const TEST_CARD_LAST_YEAR = 2099;

const testCardFields = {
  last4: z.string().regex(/^[0-9]{4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(TEST_CARD_FIRST_YEAR).max(TEST_CARD_LAST_YEAR),
  brand: z.literal(TEST_CARD_BRAND)
};

/**
 * The card the agency saved. It is the last four digits, the expiry and the brand `test`: the number, the security code and the name
 * never leave the browser, and there is nowhere to put them.
 */
export const SubscriptionTestCardSchema = z.object(testCardFields).strict();

/** Saving, or replacing ("Trocar"), the card. Exactly the four values: any other field, a number, a code or a name, is refused. */
export const SaveSubscriptionTestCardRequestSchema = z.object(testCardFields).strict();

/** `card` is null while the agency has not saved one. */
export const SubscriptionTestCardResponseSchema = z.object({
  card: SubscriptionTestCardSchema.nullable()
}).strict();

/**
 * How a charge shows in the list of invoices. `declined` is a payment the provider refused; nothing records that for a charge yet, so
 * the server does not produce it today.
 */
export const SUBSCRIPTION_INVOICE_STATUSES = ['paid', 'declined', 'open', 'expired'] as const;

export const SubscriptionInvoiceStatusSchema = z.enum(SUBSCRIPTION_INVOICE_STATUSES);

export const SubscriptionInvoiceSchema = z.object({
  id: z.string().uuid(),
  /** The day of the payment for a paid charge, the day it was asked for otherwise. */
  date: z.string().datetime(),
  /** What the charge was for, written by the server (the plan and the extras). */
  description: z.string().min(1).max(200),
  amountCents: z.number().int().nonnegative(),
  status: SubscriptionInvoiceStatusSchema
}).strict();

export const SUBSCRIPTION_INVOICES_PAGE_SIZE = 20;

export const SubscriptionInvoiceListQuerySchema = PaginationInputSchema;

export const SubscriptionInvoiceListResponseSchema = createPaginatedResponseSchema(SubscriptionInvoiceSchema);

/**
 * The outcome the screen asks the simulated provider for. The card never travels: the screen turns the fixed test number into
 * `declined` on its own and sends nothing else about the card.
 */
export const SimulatedPaymentRequestSchema = z.object({
  outcome: z.enum(['approved', 'declined'])
}).strict();

export const SimulatedPaymentResponseSchema = z.object({
  status: z.enum(['confirmed', 'declined'])
}).strict();

export type SubscriptionChangeRequest = z.infer<typeof SubscriptionChangeRequestSchema>;
export type SubscriptionPlansResponse = z.infer<typeof SubscriptionPlansResponseSchema>;
export type SubscriptionQuoteLine = z.infer<typeof SubscriptionQuoteLineSchema>;
export type SubscriptionQuoteResponse = z.infer<typeof SubscriptionQuoteResponseSchema>;
export type SubscriptionTestCard = z.infer<typeof SubscriptionTestCardSchema>;
export type SaveSubscriptionTestCardRequest = z.infer<typeof SaveSubscriptionTestCardRequestSchema>;
export type SubscriptionTestCardResponse = z.infer<typeof SubscriptionTestCardResponseSchema>;
export type SubscriptionInvoiceStatus = z.infer<typeof SubscriptionInvoiceStatusSchema>;
export type SubscriptionInvoice = z.infer<typeof SubscriptionInvoiceSchema>;
export type SubscriptionInvoiceListQuery = z.infer<typeof SubscriptionInvoiceListQuerySchema>;
export type SubscriptionInvoiceListResponse = z.infer<typeof SubscriptionInvoiceListResponseSchema>;
export type SubscriptionChargeResponse = z.infer<typeof SubscriptionChargeResponseSchema>;
export type SubscriptionOverviewResponse = z.infer<typeof SubscriptionOverviewResponseSchema>;
export type SimulatedPaymentRequest = z.infer<typeof SimulatedPaymentRequestSchema>;
export type SimulatedPaymentResponse = z.infer<typeof SimulatedPaymentResponseSchema>;
