import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness } from './support/subscriptions.js';

// Issue #772 (epic #770): what the worker charges for a renewal and the period it belongs to, read in one statement. The key of the
// charge is built from both, so a wrong period or a wrong amount here is a double charge or a renewal that never happens.
const h = createHarness('subscription-renewal-quote');
const owner = () => h.owner();

interface Quote { period_end: Date; amount_cents: number; provider: string }

const quoteOf = async (agencyId: string): Promise<Quote[]> =>
  (await h.asNobody(async (transaction) => transaction.raw<{ rows: Quote[] }>('select * from app_private.renewal_quote(?::uuid)', [agencyId]))).rows;
const periodEndOf = async (agencyId: string): Promise<Date> => (await h.subscriptionOf(agencyId))!.current_period_end as Date;
const cancel = (userId: string, agencyId: string) => h.asUser(userId, (t) => t.raw('select app_private.cancel_subscription(?::uuid)', [agencyId]));

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('renewal_quote', () => {
  it('answers the end of the period and what the next period costs, for a subscription that is due', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial', 2, 3);
    await h.setPeriod(agencyId, 29, 1);

    const quote = await quoteOf(agencyId);
    expect(quote).toHaveLength(1);
    // 97,00 + 2 clients at 6,00 + 3 GiB at 0,40, in cents.
    expect(quote[0]!.amount_cents).toBe(9700 + 2 * 600 + 3 * 40);
    expect(quote[0]!.period_end.getTime()).toBe((await periodEndOf(agencyId)).getTime());
    expect(quote[0]!.provider).toBe('simulado');
  });

  it('prices the scheduled decrease when it fits the usage, and the current terms when the usage outgrew it', async () => {
    const down = await h.trialAgency();
    await h.subscribe(down.ownerId, down.agencyId, 'profissional');
    await h.request(down.ownerId, down.agencyId, 'essencial');
    await h.setPeriod(down.agencyId, 29, 1);
    expect((await quoteOf(down.agencyId))[0]!.amount_cents).toBe(9700);

    const kept = await h.trialAgency();
    await h.subscribe(kept.ownerId, kept.agencyId, 'profissional');
    await h.request(kept.ownerId, kept.agencyId, 'essencial');
    for (let n = 0; n < 12; n += 1) await h.insertClient(kept.ownerId, kept.agencyId);
    await h.setPeriod(kept.agencyId, 29, 1);
    expect((await quoteOf(kept.agencyId))[0]!.amount_cents).toBe(19700);
  });

  it('is the same number as next_renewal_cents, which the renewal checks the charge against', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'agencia', 5, 7);
    await h.setPeriod(agencyId, 29, 1);
    const cents = (await owner().raw<{ rows: Array<{ cents: number }> }>('select app_private.next_renewal_cents(?::uuid) as cents', [agencyId])).rows[0]!.cents;
    expect((await quoteOf(agencyId))[0]!.amount_cents).toBe(cents);
  });

  it('prices the extras of a scheduled decrease that keeps the plan, not the extras being paid now', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional', 10, 50);
    await h.request(ownerId, agencyId, 'profissional', 2, 5);
    await h.setPeriod(agencyId, 29, 1);
    expect((await quoteOf(agencyId))[0]!.amount_cents).toBe(19700 + 2 * 600 + 5 * 40);
  });

  it('names the provider of the subscription, so the worker charges only the one it has', async () => {
    const { agencyId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial', { provider: 'asaas', startedDaysAgo: 29, endsInDays: 1 });
    expect((await quoteOf(agencyId))[0]!.provider).toBe('asaas');
  });

  it('answers nothing when the subscription does not renew now', async () => {
    const early = await h.trialAgency();
    await h.subscribe(early.ownerId, early.agencyId, 'essencial');
    expect(await quoteOf(early.agencyId)).toEqual([]);

    const canceled = await h.trialAgency();
    await h.subscribe(canceled.ownerId, canceled.agencyId, 'essencial');
    await cancel(canceled.ownerId, canceled.agencyId);
    await h.setPeriod(canceled.agencyId, 29, 1);
    expect(await quoteOf(canceled.agencyId)).toEqual([]);

    const trial = await h.trialAgency();
    expect(await quoteOf(trial.agencyId)).toEqual([]);

    const courtesy = await h.trialAgency();
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [courtesy.agencyId]);
    expect(await quoteOf(courtesy.agencyId)).toEqual([]);

    expect(await quoteOf('00000000-0000-4000-8000-000000000000')).toEqual([]);
  });

  it('answers nothing inside a transaction that has a person: only the server asks', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    const asOwner = await h.asUser(ownerId, async (transaction) =>
      (await transaction.raw<{ rows: Quote[] }>('select * from app_private.renewal_quote(?::uuid)', [agencyId])).rows);
    expect(asOwner).toEqual([]);
    expect(await quoteOf(agencyId)).toHaveLength(1);
  });

  it('moves its period with the renewal, so the next month makes another key', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    const before = (await quoteOf(agencyId))[0]!;
    await h.asNobody(async (transaction) => transaction.raw('select app_private.renew_subscription(?::uuid, ?, ?, ?::integer)', [agencyId, 'simulado', 'ref-quote-1', before.amount_cents]));
    expect(await quoteOf(agencyId)).toEqual([]);
    await h.setPeriod(agencyId, 29, 1);
    const after = (await quoteOf(agencyId))[0]!;
    expect(after.period_end.getTime()).not.toBe(before.period_end.getTime());
  });
});
