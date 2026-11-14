import type { SubscriptionChangeRequest, SubscriptionPlansResponse, SubscriptionQuoteLine, SubscriptionQuoteResponse } from '@ageniza/contracts';

/** What `app_private.quote_subscription_change` answers. The days are the database's and exist only for a raise. */
export interface QuoteRow {
  readonly effect: SubscriptionQuoteResponse['effect'];
  readonly monthly_cents: number;
  readonly amount_cents: number;
  readonly effective_at: Date;
  readonly days_left: number | null;
  readonly period_days: number | null;
}

/** The plan once, then each extra that was bought, priced from the tables the plans route reads. */
export const quoteLines = (change: SubscriptionChangeRequest, catalog: SubscriptionPlansResponse): SubscriptionQuoteLine[] => {
  const plan = catalog.plans.find((candidate) => candidate.key === change.planKey);
  if (plan === undefined) throw new Error(`The plan ${change.planKey} is missing from the catalog.`);
  const lines: SubscriptionQuoteLine[] = [{ kind: 'plan', quantity: 1, unitCents: plan.monthlyCents, totalCents: plan.monthlyCents }];
  if (change.extraClients > 0) {
    lines.push({ kind: 'extra_clients', quantity: change.extraClients, unitCents: catalog.extraClientCents, totalCents: change.extraClients * catalog.extraClientCents });
  }
  if (change.extraStorageGib > 0) {
    lines.push({ kind: 'extra_storage_gib', quantity: change.extraStorageGib, unitCents: catalog.extraStorageGibCents, totalCents: change.extraStorageGib * catalog.extraStorageGibCents });
  }
  return lines;
};

/** The contract does not tie the days to the effect, so this does: only a raise shows them, and always both. */
export const quoteFromRow = (row: QuoteRow, change: SubscriptionChangeRequest, catalog: SubscriptionPlansResponse): SubscriptionQuoteResponse => {
  const prorated = row.effect === 'upgrade' && row.days_left !== null && row.period_days !== null;
  return {
    effect: row.effect,
    monthlyCents: row.monthly_cents,
    amountCents: row.amount_cents,
    effectiveAt: new Date(row.effective_at).toISOString(),
    daysLeft: prorated ? row.days_left : null,
    periodDays: prorated ? row.period_days : null,
    lines: quoteLines(change, catalog)
  };
};
