import {
  MAX_SUBSCRIPTION_EXTRA,
  type SubscriptionChangeRequest,
  type SubscriptionChargeResponse,
  type SubscriptionOverviewResponse,
  type SubscriptionPlansResponse,
  type SubscriptionQuoteResponse
} from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

export type SubscriptionTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** One call of the database per transaction: the callers never join two of these in one (see README). */

export const loadPlans = async (transaction: SubscriptionTransaction): Promise<SubscriptionPlansResponse> => {
  const plans = await raw<RawRows<{ key: string; name: string; client_limit: number; storage_bytes: string; monthly_price_cents: number }>>(
    transaction, 'select key, name, client_limit, storage_bytes::text as storage_bytes, monthly_price_cents from public.subscription_plans order by position', []
  );
  const prices = await raw<RawRows<{ kind: 'client' | 'storage_gib'; unit_price_cents: number }>>(
    transaction, 'select kind, unit_price_cents from public.subscription_extra_prices', []
  );
  const priceOf = (kind: 'client' | 'storage_gib'): number => {
    const price = prices.rows.find((row) => row.kind === kind)?.unit_price_cents;
    if (price === undefined) throw new Error(`The price of the extra ${kind} is missing.`);
    return price;
  };
  return {
    plans: plans.rows.map((row) => ({
      key: row.key, name: row.name, clientLimit: row.client_limit, storageBytes: Number(row.storage_bytes), monthlyCents: row.monthly_price_cents
    })),
    extraClientCents: priceOf('client'),
    extraStorageGibCents: priceOf('storage_gib'),
    maxExtra: MAX_SUBSCRIPTION_EXTRA
  };
};

interface OverviewRow {
  readonly plan_key: string;
  readonly extra_clients: number;
  readonly extra_storage_gib: number;
  readonly provider: 'simulado' | 'asaas' | 'cortesia';
  readonly current_period_end: Date | null;
  readonly cancel_at_period_end: boolean;
  readonly pending_plan_key: string | null;
  readonly pending_extra_clients: number | null;
  readonly pending_extra_storage_gib: number | null;
  readonly monthly_cents: number;
  readonly next_monthly_cents: number | null;
  readonly client_limit: number;
  readonly storage_bytes: string;
  readonly used_clients: string;
  readonly used_bytes: string;
  readonly grace_ends_on: string | null;
}

export const loadSubscription = async (transaction: SubscriptionTransaction, agencyId: string): Promise<SubscriptionOverviewResponse['subscription']> => {
  const result = await raw<RawRows<OverviewRow>>(transaction, `
    select subscription.plan_key, subscription.extra_clients, subscription.extra_storage_gib, subscription.provider,
           subscription.current_period_end, subscription.cancel_at_period_end, subscription.pending_plan_key,
           subscription.pending_extra_clients, subscription.pending_extra_storage_gib,
           overview.monthly_cents, overview.next_monthly_cents, overview.client_limit, overview.storage_bytes::text as storage_bytes,
           overview.used_clients::text as used_clients, overview.used_bytes::text as used_bytes,
           to_char(overview.grace_ends_on, 'YYYY-MM-DD') as grace_ends_on
    from public.agency_subscriptions as subscription
    cross join lateral app_private.subscription_overview(subscription.agency_id) as overview
    where subscription.agency_id = ?::uuid
  `, [agencyId]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    planKey: row.plan_key,
    extraClients: row.extra_clients,
    extraStorageGib: row.extra_storage_gib,
    provider: row.provider,
    currentPeriodEnd: row.current_period_end === null ? null : new Date(row.current_period_end).toISOString(),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    pending: row.pending_plan_key === null
      ? null
      : { planKey: row.pending_plan_key, extraClients: row.pending_extra_clients ?? 0, extraStorageGib: row.pending_extra_storage_gib ?? 0 },
    monthlyCents: row.monthly_cents,
    nextMonthlyCents: row.next_monthly_cents,
    clientLimit: row.client_limit,
    storageBytes: Number(row.storage_bytes),
    usedClients: Number(row.used_clients),
    usedBytes: Number(row.used_bytes),
    graceEndsOn: row.grace_ends_on
  };
};

interface QuoteRow {
  readonly effect: SubscriptionQuoteResponse['effect'];
  readonly monthly_cents: number;
  readonly amount_cents: number;
  readonly effective_at: Date;
}

export const quoteChange = async (transaction: SubscriptionTransaction, agencyId: string, change: SubscriptionChangeRequest): Promise<SubscriptionQuoteResponse> => {
  const result = await raw<RawRows<QuoteRow>>(
    transaction,
    'select effect, monthly_cents, amount_cents, effective_at from app_private.quote_subscription_change(?::uuid, ?, ?::integer, ?::integer)',
    [agencyId, change.planKey, change.extraClients, change.extraStorageGib]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The quote returned no row.');
  return { effect: row.effect, monthlyCents: row.monthly_cents, amountCents: row.amount_cents, effectiveAt: new Date(row.effective_at).toISOString() };
};

interface ChargeRow extends QuoteRow {
  readonly charge_id: string | null;
}

export const requestChange = async (transaction: SubscriptionTransaction, agencyId: string, change: SubscriptionChangeRequest): Promise<SubscriptionChargeResponse> => {
  const result = await raw<RawRows<ChargeRow>>(
    transaction,
    'select charge_id, effect, monthly_cents, amount_cents, effective_at from app_private.request_subscription_change(?::uuid, ?, ?::integer, ?::integer)',
    [agencyId, change.planKey, change.extraClients, change.extraStorageGib]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The request returned no row.');
  return {
    chargeId: row.charge_id,
    effect: row.effect,
    monthlyCents: row.monthly_cents,
    amountCents: row.amount_cents,
    effectiveAt: new Date(row.effective_at).toISOString()
  };
};

export type LifecycleOperation = 'cancel_subscription' | 'reactivate_subscription' | 'advance_simulated_period';

/** The three operations that take only the lock of the agency; each runs alone in its transaction. */
export const runLifecycleOperation = async (transaction: SubscriptionTransaction, agencyId: string, operation: LifecycleOperation): Promise<void> => {
  await raw(transaction, `select app_private.${operation}(?::uuid)`, [agencyId]);
};

export interface OwnCharge {
  readonly id: string;
  readonly amountCents: number;
  readonly status: 'pending' | 'confirmed' | 'expired';
}

/**
 * The charge, if it is one of this agency and the person bound to the transaction is its Owner: the policy of the table lets
 * only the Owner of the charge's agency read it, so another agency's charge answers nothing.
 */
export const loadOwnCharge = async (transaction: SubscriptionTransaction, agencyId: string, chargeId: string): Promise<OwnCharge | undefined> => {
  const result = await raw<RawRows<{ id: string; amount_cents: number; status: OwnCharge['status'] }>>(
    transaction, 'select id, amount_cents, status from public.subscription_charges where id = ?::uuid and agency_id = ?::uuid', [chargeId, agencyId]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : { id: row.id, amountCents: row.amount_cents, status: row.status };
};

/** Runs with no person bound: the database refuses a confirmation that comes with one. */
export const confirmCharge = async (
  transaction: SubscriptionTransaction,
  confirmation: { readonly chargeId: string; readonly provider: string; readonly providerRef: string; readonly paidCents: number }
): Promise<boolean> => {
  const result = await raw<RawRows<{ confirmed: boolean }>>(
    transaction,
    'select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer) as confirmed',
    [confirmation.chargeId, confirmation.provider, confirmation.providerRef, confirmation.paidCents]
  );
  return result.rows[0]?.confirmed === true;
};
