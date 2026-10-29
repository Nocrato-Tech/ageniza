import { z } from 'zod';

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

export const SubscriptionQuoteResponseSchema = z.object({
  effect: SubscriptionEffectSchema,
  monthlyCents: z.number().int().nonnegative(),
  /** What is charged now. Zero for a downgrade. */
  amountCents: z.number().int().nonnegative(),
  effectiveAt: z.string().datetime()
}).strict();

export const SubscriptionChargeResponseSchema = SubscriptionQuoteResponseSchema.extend({
  /** The charge the provider has to confirm; null for a downgrade, which charges nothing. */
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
export type SubscriptionQuoteResponse = z.infer<typeof SubscriptionQuoteResponseSchema>;
export type SubscriptionChargeResponse = z.infer<typeof SubscriptionChargeResponseSchema>;
export type SubscriptionOverviewResponse = z.infer<typeof SubscriptionOverviewResponseSchema>;
export type SimulatedPaymentRequest = z.infer<typeof SimulatedPaymentRequestSchema>;
export type SimulatedPaymentResponse = z.infer<typeof SimulatedPaymentResponseSchema>;
