import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildBillingWorld, type BillingWorld } from './support/billing-people.js';
import { createHarness } from './support/subscriptions.js';

// Scope redesign-igual, subtask W5-S1 (decision 2026-11-11, item 3): "Ver faturas" lists the charges of the agency. They are already readable
// under RLS by whoever holds `assinatura.gerenciar` (policy and columns of 20261029000100), so nothing new was made for it: this file holds the
// query the API runs, as `ageniza_app`, and attacks it with everybody who must read nothing of another agency's billing.
const h = createHarness('subscription-invoices');
const owner = () => h.owner();

// The state of an invoice as the screen shows it. A charge that was never paid and whose time ran out is expired even while its row still says
// `pending` (the confirmation refuses it: `expires_at <= now()`), and the ones a newer request replaced say `expired`. Nothing records a
// declined attempt, so there is no state for it here.
const INVOICES_SQL = `
  select charge.id,
         coalesce(charge.confirmed_at, charge.created_at) as occurred_at,
         charge.kind,
         plan.name as plan_name,
         charge.extra_clients,
         charge.extra_storage_gib,
         charge.amount_cents,
         case
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
  id: string;
  occurred_at: Date;
  kind: string;
  plan_name: string;
  extra_clients: number;
  extra_storage_gib: number;
  amount_cents: number;
  state: string;
  total_items: string;
}

const invoices = (user: string | undefined, agencyId: string, limit = 20, offset = 0): Promise<InvoiceRow[]> => {
  const work = async (transaction: Knex.Transaction) => (await transaction.raw<{ rows: InvoiceRow[] }>(INVOICES_SQL, [agencyId, limit, offset])).rows;
  return user === undefined ? h.asNobody(work) : h.asUser(user, work);
};

interface SeedCharge {
  readonly agencyId: string;
  readonly requestedBy: string;
  readonly kind: 'subscribe' | 'upgrade' | 'renewal';
  readonly status: 'pending' | 'confirmed' | 'expired';
  readonly plan?: string;
  readonly extraClients?: number;
  readonly extraGib?: number;
  readonly amountCents?: number;
  readonly createdAt: Date;
  readonly confirmedAt?: Date;
  readonly expiresAt?: Date;
}

const seed = async (input: SeedCharge): Promise<string> => {
  const confirmed = input.status === 'confirmed';
  const [row] = await owner()('subscription_charges').insert({
    agency_id: input.agencyId, kind: input.kind, status: input.status, plan_key: input.plan ?? 'essencial', extra_clients: input.extraClients ?? 0,
    extra_storage_gib: input.extraGib ?? 0, amount_cents: input.amountCents ?? 9700, requested_by_user_id: input.requestedBy,
    provider: confirmed ? 'simulado' : null, provider_ref: confirmed ? `ref-${randomUUID()}` : null,
    expires_at: input.expiresAt ?? new Date(input.createdAt.getTime() + 1_800_000),
    period_start: confirmed ? input.createdAt : null, period_end: confirmed ? new Date(input.createdAt.getTime() + 30 * 86_400_000) : null,
    created_at: input.createdAt, confirmed_at: confirmed ? (input.confirmedAt ?? input.createdAt) : null
  }).returning('id');
  return row.id as string;
};

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

const worlds: BillingWorld[] = [];
const world = async (): Promise<BillingWorld> => {
  const built = await buildBillingWorld(h);
  worlds.push(built);
  return built;
};

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  try {
    for (const built of worlds) await built.cleanUp();
  } finally {
    await h.teardown();
  }
});

describe('the invoices of the agency (acceptance f)', () => {
  it('lists the charges of the Owner\'s agency, the newest first, with the day, the plan, the extras, the value and the state', async () => {
    const { agencyId, ownerId } = await world();
    const firstDay = daysAgo(70);
    const paidSubscription = await seed({ agencyId, requestedBy: ownerId, kind: 'subscribe', status: 'confirmed', plan: 'essencial', amountCents: 9700, createdAt: firstDay, confirmedAt: firstDay });
    const paidRenewal = await seed({ agencyId, requestedBy: ownerId, kind: 'renewal', status: 'confirmed', plan: 'profissional', extraClients: 5, amountCents: 22700, createdAt: daysAgo(40) });
    const replaced = await seed({ agencyId, requestedBy: ownerId, kind: 'upgrade', status: 'expired', plan: 'agencia', amountCents: 5000, createdAt: daysAgo(20) });
    const open = await seed({ agencyId, requestedBy: ownerId, kind: 'upgrade', status: 'pending', plan: 'agencia', extraGib: 30, amountCents: 8000, createdAt: new Date(), expiresAt: new Date(Date.now() + 1_800_000) });

    const rows = await invoices(ownerId, agencyId);
    expect(rows.map((row) => ({ id: row.id, kind: row.kind, plan: row.plan_name, clients: row.extra_clients, gib: row.extra_storage_gib, cents: row.amount_cents, state: row.state, total: row.total_items }))).toEqual([
      { id: open, kind: 'upgrade', plan: 'Agência', clients: 0, gib: 30, cents: 8000, state: 'open', total: '4' },
      { id: replaced, kind: 'upgrade', plan: 'Agência', clients: 0, gib: 0, cents: 5000, state: 'expired', total: '4' },
      { id: paidRenewal, kind: 'renewal', plan: 'Profissional', clients: 5, gib: 0, cents: 22700, state: 'paid', total: '4' },
      { id: paidSubscription, kind: 'subscribe', plan: 'Essencial', clients: 0, gib: 0, cents: 9700, state: 'paid', total: '4' }
    ]);
    expect(rows[3]!.occurred_at.getTime()).toBe(firstDay.getTime());
  });

  it('tells a pending charge whose time ran out from an open one, and dates a paid charge by its confirmation', async () => {
    const { agencyId, ownerId } = await world();
    const lapsed = await seed({ agencyId, requestedBy: ownerId, kind: 'subscribe', status: 'pending', createdAt: daysAgo(1), expiresAt: new Date(Date.now() - 1_000) });
    const confirmedOn = daysAgo(4);
    const confirmedLater = await seed({ agencyId, requestedBy: ownerId, kind: 'upgrade', status: 'confirmed', createdAt: daysAgo(5), confirmedAt: confirmedOn });
    const rows = await invoices(ownerId, agencyId);
    expect(rows.map((row) => [row.id, row.state])).toEqual([[lapsed, 'expired'], [confirmedLater, 'paid']]);
    expect(rows[1]!.occurred_at.getTime()).toBe(confirmedOn.getTime());
  });

  it('counts and pages in one statement, and breaks a tie of the day by the id', async () => {
    const { agencyId, ownerId } = await world();
    const sameInstant = daysAgo(3);
    const ids = [
      await seed({ agencyId, requestedBy: ownerId, kind: 'subscribe', status: 'confirmed', createdAt: sameInstant }),
      await seed({ agencyId, requestedBy: ownerId, kind: 'renewal', status: 'confirmed', createdAt: sameInstant }),
      await seed({ agencyId, requestedBy: ownerId, kind: 'renewal', status: 'confirmed', createdAt: daysAgo(1) })
    ];
    const second = await invoices(ownerId, agencyId, 1, 1);
    expect(second).toHaveLength(1);
    expect(second[0]!.total_items).toBe('3');
    const all = await invoices(ownerId, agencyId);
    expect(all.map((row) => row.id)).toEqual([ids[2], ...[ids[0]!, ids[1]!].sort().reverse()]);
    expect(await invoices(ownerId, agencyId, 20, 40)).toEqual([]);
  });

  it('shows nothing of another agency\'s charges, to its Owner and to everybody who has some other claim on the agency', async () => {
    const mine = await world();
    const theirs = await world();
    const mineId = await seed({ agencyId: mine.agencyId, requestedBy: mine.ownerId, kind: 'subscribe', status: 'confirmed', createdAt: daysAgo(2) });
    const theirsId = await seed({ agencyId: theirs.agencyId, requestedBy: theirs.ownerId, kind: 'subscribe', status: 'confirmed', createdAt: daysAgo(2) });

    expect((await invoices(mine.ownerId, mine.agencyId)).map((row) => row.id)).toEqual([mineId]);
    expect((await invoices(theirs.ownerId, theirs.agencyId)).map((row) => row.id)).toEqual([theirsId]);
    expect(await invoices(mine.ownerId, theirs.agencyId)).toEqual([]);
    expect(await invoices(theirs.ownerId, mine.agencyId)).toEqual([]);
    expect(await h.asUser(mine.ownerId, (t) => t('subscription_charges').where({ id: theirsId }).select('id'))).toEqual([]);

    for (const { who, user } of mine.denied) {
      expect(await invoices(user, mine.agencyId), `${who} reads the invoices of the agency`).toEqual([]);
      if (user !== undefined) {
        expect(await h.asUser(user, (t) => t('subscription_charges').select('id')).then((rows) => rows.filter((row: { id: string }) => row.id === mineId)), `${who} reads the charge`).toEqual([]);
      }
    }
    // The Owner of the other agency who is a person of this agency's client reads their own agency's invoices and not this one's.
    expect((await invoices(mine.other.ownerId, mine.other.agencyId)).map((row) => row.id)).toEqual([]);
    const otherId = await seed({ agencyId: mine.other.agencyId, requestedBy: mine.other.ownerId, kind: 'subscribe', status: 'confirmed', createdAt: daysAgo(1) });
    expect((await invoices(mine.other.ownerId, mine.other.agencyId)).map((row) => row.id)).toEqual([otherId]);
    expect(await invoices(mine.other.ownerId, mine.agencyId)).toEqual([]);
  });

  it('keeps what the provider answered and who asked out of the reach of the screen\'s role', async () => {
    const { agencyId, ownerId } = await world();
    await seed({ agencyId, requestedBy: ownerId, kind: 'subscribe', status: 'confirmed', createdAt: daysAgo(1) });
    for (const column of ['provider', 'provider_ref', 'requested_by_user_id']) {
      await expect(h.asUser(ownerId, (t) => t('subscription_charges').select(column)), column).rejects.toMatchObject({ code: '42501' });
    }
  });
});
