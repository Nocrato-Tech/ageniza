import type { SubscriptionInvoice, SubscriptionInvoiceStatus } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { SubscriptionTransaction } from './service.js';

// A charge whose payment was declined says so first, whatever its row says; one that was never paid and whose time ran out is expired even
// while its row still says `pending`. The same statement the database suite runs as `ageniza_app` (subscription-invoices.integration.test.ts).
const INVOICES_SQL = `
  select charge.id,
         coalesce(charge.confirmed_at, charge.created_at) as occurred_at,
         charge.kind,
         plan.name as plan_name,
         charge.extra_clients,
         charge.extra_storage_gib,
         charge.amount_cents,
         case
           when charge.declined_at is not null then 'declined'
           when charge.status = 'confirmed' then 'paid'
           when charge.status = 'pending' and charge.expires_at > now() then 'open'
           else 'expired'
         end as state,
         count(*) over () as total_items
  from public.subscription_charges charge
  join public.subscription_plans plan on plan.key = charge.plan_key
  where charge.agency_id = ?::uuid
  order by charge.created_at desc, charge.id desc
  limit ? offset ?
`;

interface InvoiceRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly plan_name: string;
  readonly extra_clients: number;
  readonly extra_storage_gib: number;
  readonly amount_cents: number;
  readonly state: SubscriptionInvoiceStatus;
  readonly total_items: string;
}

export const invoiceDescription = (row: Pick<InvoiceRow, 'plan_name' | 'extra_clients' | 'extra_storage_gib'>): string => {
  const parts = [`Plano ${row.plan_name}`];
  if (row.extra_clients > 0) parts.push(`${row.extra_clients} ${row.extra_clients === 1 ? 'cliente extra' : 'clientes extras'}`);
  if (row.extra_storage_gib > 0) parts.push(`${row.extra_storage_gib} GB ${row.extra_storage_gib === 1 ? 'extra' : 'extras'}`);
  return parts.join(' + ');
};

export interface InvoicePage {
  readonly items: SubscriptionInvoice[];
  readonly totalItems: number;
}

/** Reads under the policy of the table, so only the Owner of the agency sees a row. */
export const listInvoices = async (
  transaction: SubscriptionTransaction,
  agencyId: string,
  page: { readonly pageSize: number; readonly offset: number }
): Promise<InvoicePage> => {
  const result = await raw<{ rows: readonly InvoiceRow[] }>(transaction, INVOICES_SQL, [agencyId, page.pageSize, page.offset]);
  const items = result.rows.map((row): SubscriptionInvoice => ({
    id: row.id,
    date: new Date(row.occurred_at).toISOString(),
    description: invoiceDescription(row),
    amountCents: row.amount_cents,
    status: row.state
  }));
  const first = result.rows[0];
  if (first !== undefined) return { items, totalItems: Number(first.total_items) };
  // `count(*) over ()` rides on the rows, so a page past the end has no total to read.
  if (page.offset === 0) return { items, totalItems: 0 };
  const count = await raw<{ rows: ReadonlyArray<{ total_items: string }> }>(
    transaction, 'select count(*) as total_items from public.subscription_charges where agency_id = ?::uuid', [agencyId]
  );
  return { items, totalItems: Number(count.rows[0]?.total_items ?? 0) };
};
