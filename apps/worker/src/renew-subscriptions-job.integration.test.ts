import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { createPaymentProvider, type ChargeRequest, type ChargeResult, type PaymentProvider, type RefundRequest, type RefundResult } from '@ageniza/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renewSubscriptionsJob } from './renew-subscriptions-job.js';

// Issue #772, against the migrated local database and as the application role, the one the worker uses in production: the job asks
// the real functions who is due, what it costs and whether the confirmation is taken. The provider is the real simulated one,
// recorded, and with a hook that runs while the card is being charged, which is where the world changes under the job.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const GIB = 1_073_741_824;
const DAY_SECONDS = 86_400;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const agencies: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};
const knex = () => getOwner().knex;

interface Seed {
  readonly plan?: 'essencial' | 'profissional' | 'agencia';
  readonly extraClients?: number;
  readonly extraGib?: number;
  /** Seconds from now to the end of the period; negative when the period ended. A day or less is due. */
  readonly endsInSeconds?: number;
  readonly provider?: 'simulado' | 'asaas';
  readonly pending?: { readonly plan: string; readonly extraClients?: number; readonly extraGib?: number };
  readonly canceled?: boolean;
}

const seedAgency = async (seed: Seed = {}): Promise<string> => {
  const { plan = 'essencial', extraClients = 0, extraGib = 0, endsInSeconds = 12 * 3600, provider = 'simulado' } = seed;
  const id = randomUUID();
  agencies.push(id);
  await knex().transaction(async (transaction) => {
    await transaction('agencies').insert({ id, name: `Renewal Agency ${id}`, owner_user_id: null });
    await transaction.raw(
      `insert into public.agency_subscriptions (agency_id, plan_key, extra_clients, extra_storage_gib, provider, current_period_start, current_period_end,
         cancel_at_period_end, pending_plan_key, pending_extra_clients, pending_extra_storage_gib)
       values (?, ?, ?::integer, ?::integer, ?, now() + make_interval(secs => ?::int) - interval '1 month', now() + make_interval(secs => ?::int),
         ?, ?, ?::integer, ?::integer)`,
      [id, plan, extraClients, extraGib, provider, endsInSeconds, endsInSeconds, seed.canceled ?? false,
        seed.pending?.plan ?? null, seed.pending === undefined ? null : seed.pending.extraClients ?? 0, seed.pending === undefined ? null : seed.pending.extraGib ?? 0]
    );
    await transaction.raw('select app_private.apply_subscription_terms(?::uuid, ?, ?::integer, ?::integer)', [id, plan, extraClients, extraGib]);
  });
  return id;
};

const addClients = async (agencyId: string, count: number): Promise<void> => {
  await knex()('clients').insert(Array.from({ length: count }, () => ({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` })));
};

const refundsOf = async (agencyId: string) =>
  (await knex()('subscription_renewal_refunds').where({ agency_id: agencyId }).orderBy('created_at')) as Array<Record<string, unknown>>;
/** What the Owner's reactivation leaves in the subscription: the cancellation is gone, the period is the same. */
const reactivate = async (agencyId: string): Promise<void> => {
  await knex().raw('update public.agency_subscriptions set cancel_at_period_end = false where agency_id = ?', [agencyId]);
};
const subscriptionOf = async (agencyId: string) =>
  (await knex()('agency_subscriptions').where({ agency_id: agencyId }).first()) as Record<string, unknown>;
const chargesOf = async (agencyId: string) =>
  (await knex()('subscription_charges').where({ agency_id: agencyId }).orderBy('created_at')) as Array<Record<string, unknown>>;
const quotaOf = async (agencyId: string): Promise<string> => (await knex()('agency_storage_quotas').where({ agency_id: agencyId }).first('quota_bytes')).quota_bytes as string;
const auditOf = async (agencyId: string): Promise<string[]> =>
  (await knex().raw<{ rows: Array<{ action: string }> }>("select action from audit.events where agency_id = ? and action like 'subscription.%' order by occurred_at, id", [agencyId])).rows.map((row) => row.action);
const acceptsWrites = async (agencyId: string): Promise<boolean> =>
  (await knex().raw<{ rows: Array<{ accepts: boolean }> }>('select app_private.agency_accepts_writes(?::uuid) as accepts', [agencyId])).rows[0]!.accepts;
const isListed = async (agencyId: string): Promise<boolean> =>
  (await knex().raw<{ rows: Array<{ id: string }> }>('select app_private.agencies_due_for_renewal(500) as id')).rows.some((row) => row.id === agencyId);
const monthsBetween = async (start: Date, end: Date): Promise<boolean> =>
  (await knex().raw<{ rows: Array<{ ok: boolean }> }>("select (?::timestamptz + interval '1 month') = ?::timestamptz as ok", [start, end])).rows[0]!.ok;

interface Recording {
  readonly charges: ChargeRequest[];
  readonly refunds: RefundRequest[];
  readonly calls: string[];
}

/** The real simulated provider, recorded, with a hook that runs while the card is being charged. */
const recordedProvider = async (hook?: (request: ChargeRequest, index: number) => Promise<void>): Promise<{ provider: PaymentProvider; recording: Recording }> => {
  const inner = await createPaymentProvider({ production: false, provider: 'simulado' });
  if (inner === undefined) throw new Error('expected the simulated provider');
  const recording: Recording = { charges: [], refunds: [], calls: [] };
  return {
    recording,
    provider: {
      name: inner.name,
      async charge(request: ChargeRequest): Promise<ChargeResult> {
        recording.charges.push(request);
        recording.calls.push(`charge:${request.amountCents}`);
        const result = await inner.charge(request);
        await hook?.(request, recording.charges.length - 1);
        return result;
      },
      async refund(request: RefundRequest): Promise<RefundResult> {
        recording.refunds.push(request);
        recording.calls.push(`refund:${request.amountCents}`);
        return inner.refund(request);
      }
    }
  };
};

const captureLogs = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    records: (): Array<Record<string, unknown>> => output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  };
};

type Captured = ReturnType<typeof captureLogs>;

const runJob = async (provider: PaymentProvider, captured: Captured, simulatedOutcome?: 'approved' | 'declined'): Promise<void> => {
  const definition = renewSubscriptionsJob({ database: getApplication(), provider, ...(simulatedOutcome === undefined ? {} : { simulatedOutcome }) });
  await definition.handler({ id: 'job-1', name: definition.name, payload: {}, attempt: 1 }, { logger: captured.logger, signal: new AbortController().signal });
};

const mine = (recording: Recording, agencyId: string): ChargeRequest[] => recording.charges.filter((request) => request.idempotencyKey.startsWith(`renewal:${agencyId}:`));

beforeAll(async () => {
  assertLocalDatabaseUrl(applicationUrl);
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  try {
    if (agencies.length > 0) {
      await owner?.knex('clients').whereIn('agency_id', agencies).delete();
      await owner?.knex('subscription_renewal_refunds').whereIn('agency_id', agencies).delete();
      await owner?.knex('subscription_charges').whereIn('agency_id', agencies).delete();
      await owner?.knex('agency_subscriptions').whereIn('agency_id', agencies).delete();
      await owner?.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
      await owner?.knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [agencies]);
      await owner?.knex('agencies').whereIn('id', agencies).delete();
    }
  } finally {
    await application?.close();
    await owner?.close();
  }
});

describe('subscriptions.renew-due against the database', { timeout: 60_000 }, () => {
  it('charges what the database prices, renews from the end of the old period, and charges nothing the second time', async () => {
    const agencyId = await seedAgency({ plan: 'essencial', extraClients: 2, extraGib: 3 });
    const before = await subscriptionOf(agencyId);
    const { provider, recording } = await recordedProvider();

    await runJob(provider, captureLogs());

    // 97,00 of the plan, 2 extra clients at 6,00 and 3 extra GiB at 0,40, in cents.
    const expectedCents = 9_700 + 2 * 600 + 3 * 40;
    expect(mine(recording, agencyId)).toHaveLength(1);
    expect(mine(recording, agencyId)[0]).toMatchObject({ amountCents: expectedCents });
    const charges = await chargesOf(agencyId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kind: 'renewal', status: 'confirmed', amount_cents: expectedCents, provider: 'simulado', provider_ref: `sim:${mine(recording, agencyId)[0]!.idempotencyKey}` });
    const after = await subscriptionOf(agencyId);
    expect((after.current_period_start as Date).getTime()).toBe((before.current_period_end as Date).getTime());
    expect(await monthsBetween(after.current_period_start as Date, after.current_period_end as Date)).toBe(true);
    expect(await auditOf(agencyId)).toEqual(['subscription.renewed']);
    expect(await quotaOf(agencyId)).toBe(String(23 * GIB));

    await runJob(provider, captureLogs());
    expect(mine(recording, agencyId)).toHaveLength(1);
    expect(await chargesOf(agencyId)).toHaveLength(1);
  });

  it('leaves alone a subscription that ends in more than a day, a courtesy, a canceled one and one of another provider', async () => {
    const early = await seedAgency({ endsInSeconds: 3 * DAY_SECONDS });
    const canceled = await seedAgency({ canceled: true });
    const otherProvider = await seedAgency({ provider: 'asaas' });
    const courtesy = await seedAgency();
    await knex().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [courtesy]);
    const periodsBefore = new Map<string, unknown>();
    for (const agencyId of [early, canceled, otherProvider]) periodsBefore.set(agencyId, (await subscriptionOf(agencyId)).current_period_end);
    const { provider, recording } = await recordedProvider();
    const captured = captureLogs();

    await runJob(provider, captured);

    for (const agencyId of [early, canceled, otherProvider, courtesy]) {
      expect(mine(recording, agencyId), agencyId).toEqual([]);
      expect(await chargesOf(agencyId), agencyId).toEqual([]);
    }
    for (const [agencyId, periodEnd] of periodsBefore) expect((await subscriptionOf(agencyId)).current_period_end, agencyId).toEqual(periodEnd);
    expect(await auditOf(canceled)).toEqual([]);
  });

  it('keeps charging a declined card until the grace ends, records nothing for it, and lets the agency become read-only after the three days', async () => {
    const agencyId = await seedAgency({ endsInSeconds: -DAY_SECONDS });
    const before = await subscriptionOf(agencyId);
    const { provider, recording } = await recordedProvider();
    const captured = captureLogs();

    await runJob(provider, captured, 'declined');
    await runJob(provider, captured, 'declined');

    expect(mine(recording, agencyId)).toHaveLength(2);
    expect(mine(recording, agencyId).every((request) => request.testOutcome === 'declined')).toBe(true);
    expect(recording.refunds).toEqual([]);
    expect(await chargesOf(agencyId)).toEqual([]);
    expect((await subscriptionOf(agencyId)).current_period_end).toEqual(before.current_period_end);
    expect(await acceptsWrites(agencyId)).toBe(true);
    expect(await isListed(agencyId)).toBe(true);
    expect(captured.records().filter((record) => record.agencyId === agencyId && record.reason === 'card_declined')).toHaveLength(2);

    await knex().raw("update public.agency_subscriptions set current_period_end = now() - interval '3 days 1 hour', current_period_start = now() - interval '3 days 1 hour' - interval '1 month' where agency_id = ?", [agencyId]);
    expect(await acceptsWrites(agencyId)).toBe(false);
    expect(await isListed(agencyId)).toBe(false);
    await runJob(provider, captured, 'declined');
    expect(mine(recording, agencyId)).toHaveLength(2);
  });

  it('renews a payment that comes inside the grace from where the old period ended, and the agency writes again', async () => {
    const agencyId = await seedAgency({ endsInSeconds: -2 * DAY_SECONDS });
    const before = await subscriptionOf(agencyId);
    const { provider } = await recordedProvider();

    await runJob(provider, captureLogs());

    const after = await subscriptionOf(agencyId);
    expect((after.current_period_start as Date).getTime()).toBe((before.current_period_end as Date).getTime());
    expect((after.current_period_end as Date).getTime()).toBeGreaterThan(Date.now());
    expect(await acceptsWrites(agencyId)).toBe(true);
  });

  it('applies the scheduled decrease at the renewal, charges the lower amount and moves the quota down', async () => {
    const agencyId = await seedAgency({ plan: 'profissional', pending: { plan: 'essencial' } });
    const { provider, recording } = await recordedProvider();

    await runJob(provider, captureLogs());

    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([9_700]);
    expect(await subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', pending_plan_key: null });
    expect(await quotaOf(agencyId)).toBe(String(20 * GIB));
    expect(await auditOf(agencyId)).toEqual(['subscription.downgrade_applied']);
  });

  it('keeps the current plan and charges for it when the usage outgrew the scheduled decrease', async () => {
    const agencyId = await seedAgency({ plan: 'profissional', pending: { plan: 'essencial' } });
    await addClients(agencyId, 12);
    const { provider, recording } = await recordedProvider();

    await runJob(provider, captureLogs());

    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([19_700]);
    expect(await subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
    expect(await quotaOf(agencyId)).toBe(String(100 * GIB));
    expect(await auditOf(agencyId)).toEqual(['subscription.downgrade_skipped']);
  });

  it('refunds the charge and charges the new amount when the usage grew between the quote and the confirmation (A0114), renewing once', async () => {
    const agencyId = await seedAgency({ plan: 'profissional', pending: { plan: 'essencial' } });
    // While the first card is being charged at the lower price, the agency grows past the plan it was leaving.
    const { provider, recording } = await recordedProvider(async (request, index) => {
      if (index === 0 && request.idempotencyKey.startsWith(`renewal:${agencyId}:`)) await addClients(agencyId, 12);
    });
    const captured = captureLogs();

    await runJob(provider, captured);

    expect(recording.calls.filter((call) => mine(recording, agencyId).some((request) => call === `charge:${request.amountCents}`) || call.startsWith('refund:'))).toEqual(['charge:9700', 'refund:9700', 'charge:19700']);
    const [first, second] = mine(recording, agencyId);
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
    expect(recording.refunds).toEqual([{ idempotencyKey: `refund:${first!.idempotencyKey}`, providerRef: `sim:${first!.idempotencyKey}`, amountCents: 9_700 }]);
    const charges = await chargesOf(agencyId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kind: 'renewal', status: 'confirmed', amount_cents: 19_700, provider_ref: `sim:${second!.idempotencyKey}` });
    expect(await subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
    expect(await quotaOf(agencyId)).toBe(String(100 * GIB));
    expect(await auditOf(agencyId)).toEqual(['subscription.downgrade_skipped']);
    expect(captured.records()).toContainEqual(expect.objectContaining({ agencyId, msg: 'The renewal charge was refunded: the database did not take it as a renewal' }));
  });

  it('refunds the charge and renews nothing when the subscription was canceled while the card was charged (A0115)', async () => {
    const agencyId = await seedAgency();
    const { provider, recording } = await recordedProvider(async (request) => {
      if (request.idempotencyKey.startsWith(`renewal:${agencyId}:`)) {
        await knex().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
      }
    });

    await runJob(provider, captureLogs());

    expect(mine(recording, agencyId)).toHaveLength(1);
    expect(recording.refunds).toEqual([{ idempotencyKey: `refund:${mine(recording, agencyId)[0]!.idempotencyKey}`, providerRef: `sim:${mine(recording, agencyId)[0]!.idempotencyKey}`, amountCents: 9_700 }]);
    expect(await chargesOf(agencyId)).toEqual([]);
    expect(await auditOf(agencyId)).toEqual([]);
    await runJob(provider, captureLogs());
    expect(mine(recording, agencyId)).toHaveLength(1);
  });

  it('refunds the charge when the Owner changed the plan while the card was charged, and the next quote is what the new plan costs', async () => {
    const agencyId = await seedAgency({ plan: 'essencial' });
    const { provider, recording } = await recordedProvider(async (request, index) => {
      if (index === 0 && request.idempotencyKey.startsWith(`renewal:${agencyId}:`)) {
        await knex().raw("update public.agency_subscriptions set plan_key = 'agencia' where agency_id = ?", [agencyId]);
        await knex().raw("select app_private.apply_subscription_terms(?::uuid, 'agencia', 0, 0)", [agencyId]);
      }
    });

    await runJob(provider, captureLogs());

    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([9_700, 39_700]);
    expect(recording.refunds.map((request) => request.amountCents)).toEqual([9_700]);
    expect((await chargesOf(agencyId)).map((charge) => charge.amount_cents)).toEqual([39_700]);
  });

  it('charges the same period once when two workers run at the same time: one renews, the other finds it renewed, and nobody is refunded', async () => {
    const agencyId = await seedAgency();
    const { provider: inner, recording } = await recordedProvider();
    // Both runs have quoted the same period before either confirms: the charge of this agency waits for the other run's.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothCharged = new Promise<void>((resolve) => { release = resolve; });
    const provider: PaymentProvider = {
      name: inner.name,
      async charge(request) {
        const result = await inner.charge(request);
        if (request.idempotencyKey.startsWith(`renewal:${agencyId}:`)) {
          arrived += 1;
          if (arrived === 2) release();
          await bothCharged;
        }
        return result;
      },
      refund: (request) => inner.refund(request)
    };
    const first = captureLogs();
    const second = captureLogs();

    await Promise.all([runJob(provider, first), runJob(provider, second)]);

    expect(mine(recording, agencyId)).toHaveLength(2);
    expect(mine(recording, agencyId)[0]!.idempotencyKey).toBe(mine(recording, agencyId)[1]!.idempotencyKey);
    expect(recording.refunds).toEqual([]);
    expect(await chargesOf(agencyId)).toHaveLength(1);
    expect(await auditOf(agencyId)).toEqual(['subscription.renewed']);
    const summaries = [first, second].map((captured) => captured.records().find((record) => record.msg === 'Renewed the subscriptions that are due')!);
    expect(summaries.reduce((sum, record) => sum + (record.renewed as number), 0)).toBe(1);
    expect(summaries.reduce((sum, record) => sum + (record.already_renewed as number), 0)).toBe(1);
  });

  it('renews the other agencies when the provider fails for one, and fails the run so the queue retries it', async () => {
    const failing = await seedAgency();
    const healthy = await seedAgency({ plan: 'profissional' });
    const { provider: inner, recording } = await recordedProvider();
    const provider: PaymentProvider = {
      name: inner.name,
      charge: (request) => {
        if (request.idempotencyKey.startsWith(`renewal:${failing}:`)) throw new Error('socket hang up');
        return inner.charge(request);
      },
      refund: (request) => inner.refund(request)
    };

    await expect(runJob(provider, captureLogs())).rejects.toThrow(/The renewal of \d+ agencies failed\./);

    expect(await chargesOf(failing)).toEqual([]);
    expect((await chargesOf(healthy)).map((charge) => charge.amount_cents)).toEqual([19_700]);
    expect(recording.refunds).toEqual([]);
    expect(await isListed(failing)).toBe(true);
    expect(await isListed(healthy)).toBe(false);
  });
});

// The review of #790 (Coruja): the simulated provider answers the same key with the same reference, and the database only knew the
// reference had been charged. A renewal that was refunded was confirmed later with the reference whose money had gone back, and the
// period came out paid with nothing. Both scenarios below were proven by the review against the job as it was.
describe('a refunded renewal never comes back as a renewal', { timeout: 60_000 }, () => {
  const isMine = (agencyId: string, request: ChargeRequest): boolean => request.idempotencyKey.startsWith(`renewal:${agencyId}:`);

  it('scenario A: canceled while the card is charged, refunded, reactivated in the same period: the next charge is another payment and renews with money', async () => {
    const agencyId = await seedAgency();
    let own = 0;
    const { provider, recording } = await recordedProvider(async (request) => {
      if (!isMine(agencyId, request)) return;
      own += 1;
      if (own === 1) await knex().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    });
    const periodEnd = (await subscriptionOf(agencyId)).current_period_end as Date;

    await runJob(provider, captureLogs());

    const [first] = mine(recording, agencyId);
    expect(recording.refunds).toEqual([{ idempotencyKey: `refund:${first!.idempotencyKey}`, providerRef: `sim:${first!.idempotencyKey}`, amountCents: 9_700 }]);
    expect(await chargesOf(agencyId)).toEqual([]);
    expect(await refundsOf(agencyId)).toEqual([expect.objectContaining({
      provider: 'simulado', provider_ref: `sim:${first!.idempotencyKey}`, amount_cents: 9_700, reason: 'A0115', status: 'refunded'
    })]);
    expect((await refundsOf(agencyId))[0]!.period_end).toEqual(periodEnd);

    // The Owner reactivates inside the same period, and the next run charges again.
    await reactivate(agencyId);
    expect(await isListed(agencyId)).toBe(true);
    await runJob(provider, captureLogs());

    const [, second] = mine(recording, agencyId);
    expect(mine(recording, agencyId)).toHaveLength(2);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
    expect(second!.idempotencyKey.endsWith(':1')).toBe(true);
    const charges = await chargesOf(agencyId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kind: 'renewal', status: 'confirmed', amount_cents: 9_700, provider_ref: `sim:${second!.idempotencyKey}` });
    expect(charges[0]!.provider_ref).not.toBe(`sim:${first!.idempotencyKey}`);
    expect(recording.refunds).toHaveLength(1);
    expect(await auditOf(agencyId)).toEqual(['subscription.renewed']);
    expect(await isListed(agencyId)).toBe(false);
  });

  it('scenario B: a scheduled decrease whose usage oscillates is refused twice in a run, and the next run charges neither of the refunded payments', async () => {
    const agencyId = await seedAgency({ plan: 'profissional', pending: { plan: 'essencial' } });
    let own = 0;
    // The first charge (9700) finds the usage grown (expected 19700); the second (19700) finds it back (expected 9700).
    const { provider, recording } = await recordedProvider(async (request) => {
      if (!isMine(agencyId, request)) return;
      own += 1;
      if (own === 1) await addClients(agencyId, 12);
      if (own === 2) await knex()('clients').where({ agency_id: agencyId }).delete();
    });
    const captured = captureLogs();

    await runJob(provider, captured);

    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([9_700, 19_700]);
    expect(recording.refunds.map((request) => request.amountCents)).toEqual([9_700, 19_700]);
    expect(await chargesOf(agencyId)).toEqual([]);
    expect(await subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: 'essencial' });
    expect((await refundsOf(agencyId)).map((row) => [row.amount_cents, row.reason, row.status])).toEqual([[9_700, 'A0114', 'refunded'], [19_700, 'A0114', 'refunded']]);

    await runJob(provider, captureLogs());

    // 9700 again, as in the first charge, but another attempt: the provider is asked for a payment, not handed the refunded one.
    const keys = mine(recording, agencyId).map((request) => request.idempotencyKey);
    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([9_700, 19_700, 9_700]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]!.endsWith(':2')).toBe(true);
    const charges = await chargesOf(agencyId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ status: 'confirmed', amount_cents: 9_700, provider_ref: `sim:${keys[2]}` });
    expect(recording.refunds).toHaveLength(2);
    expect(await subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', pending_plan_key: null });
    expect(await auditOf(agencyId)).toEqual(['subscription.downgrade_applied']);
  });

  it('records the refund in the database before the provider is asked for it', async () => {
    const agencyId = await seedAgency();
    const { provider: inner } = await recordedProvider(async (request) => {
      if (isMine(agencyId, request)) await knex().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    });
    let seenWhenAsked: Array<Record<string, unknown>> | undefined;
    const provider: PaymentProvider = {
      name: inner.name,
      charge: (request) => inner.charge(request),
      async refund(request) {
        seenWhenAsked = await refundsOf(agencyId);
        return inner.refund(request);
      }
    };

    await runJob(provider, captureLogs());

    expect(seenWhenAsked).toEqual([expect.objectContaining({ amount_cents: 9_700, status: 'recorded', settled_at: null })]);
    expect((await refundsOf(agencyId))[0]).toMatchObject({ status: 'refunded' });
  });

  it('refuses a provider that answers a refunded reference again, whatever the key: nothing renews, nothing is refunded twice, and a person is told', async () => {
    const agencyId = await seedAgency();
    const periodEndBefore = (await subscriptionOf(agencyId)).current_period_end;
    let own = 0;
    const { provider: inner, recording } = await recordedProvider(async (request) => {
      if (!isMine(agencyId, request)) return;
      own += 1;
      if (own === 1) await knex().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    });
    // A provider that ignores the idempotency key and hands back the one payment it has: the database must not take it.
    const provider: PaymentProvider = {
      name: inner.name,
      async charge(request) {
        const result = await inner.charge(request);
        return result.status === 'approved' && isMine(agencyId, request) ? { ...result, providerRef: 'sim:one-payment-for-every-key' } : result;
      },
      refund: (request) => inner.refund(request)
    };
    await runJob(provider, captureLogs());
    await reactivate(agencyId);
    const captured = captureLogs();

    await runJob(provider, captured);

    expect(mine(recording, agencyId)).toHaveLength(2);
    expect(await chargesOf(agencyId)).toEqual([]);
    expect(await auditOf(agencyId)).toEqual([]);
    expect((await subscriptionOf(agencyId)).current_period_end).toEqual(periodEndBefore);
    expect(recording.refunds).toHaveLength(1);
    expect(captured.records()).toContainEqual(expect.objectContaining({
      level: 50, agencyId, providerRef: 'sim:one-payment-for-every-key', amountCents: 9_700, code: 'RENEWAL_REFUNDED_REFERENCE'
    }));
    expect(await isListed(agencyId)).toBe(true);
  });

  it('catches a refund that throws: it is logged with the reference and the amount, the record stays to be reconciled, and the next run charges a new payment', async () => {
    const agencyId = await seedAgency({ plan: 'profissional', pending: { plan: 'essencial' } });
    let own = 0;
    const { provider: inner, recording } = await recordedProvider(async (request) => {
      if (!isMine(agencyId, request)) return;
      own += 1;
      if (own === 1) await addClients(agencyId, 12);
    });
    const provider: PaymentProvider = {
      name: inner.name,
      charge: (request) => inner.charge(request),
      refund: () => Promise.reject(new TypeError('socket hang up'))
    };
    const captured = captureLogs();

    await runJob(provider, captured);

    const [first] = mine(recording, agencyId);
    expect(mine(recording, agencyId)).toHaveLength(1);
    expect(captured.records()).toContainEqual(expect.objectContaining({
      level: 50, agencyId, providerRef: `sim:${first!.idempotencyKey}`, amountCents: 9_700, reason: 'refund_threw', code: 'RENEWAL_REFUND_FAILED'
    }));
    expect(await refundsOf(agencyId)).toEqual([expect.objectContaining({ provider_ref: `sim:${first!.idempotencyKey}`, amount_cents: 9_700, status: 'recorded', settled_at: null })]);
    expect(await chargesOf(agencyId)).toEqual([]);

    await runJob(inner, captureLogs());

    const [, second] = mine(recording, agencyId);
    expect(mine(recording, agencyId).map((request) => request.amountCents)).toEqual([9_700, 19_700]);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
    expect((await chargesOf(agencyId)).map((charge) => [charge.amount_cents, charge.provider_ref])).toEqual([[19_700, `sim:${second!.idempotencyKey}`]]);
  });

  it('writes down a refund the provider could not make as failed, with its reason', async () => {
    const agencyId = await seedAgency();
    const { provider: inner } = await recordedProvider(async (request) => {
      if (isMine(agencyId, request)) await knex().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    });
    const provider: PaymentProvider = {
      name: inner.name,
      charge: (request) => inner.charge(request),
      refund: () => Promise.resolve({ status: 'failed', reason: 'provider_unavailable' })
    };
    const captured = captureLogs();

    await runJob(provider, captured);

    expect(await refundsOf(agencyId)).toEqual([expect.objectContaining({ amount_cents: 9_700, reason: 'A0115', status: 'failed', failure: 'provider_unavailable' })]);
    expect(captured.records()).toContainEqual(expect.objectContaining({ level: 50, agencyId, amountCents: 9_700, reason: 'provider_unavailable', code: 'RENEWAL_REFUND_FAILED' }));
  });
});
