import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness } from './support/subscriptions.js';

// Scope redesign-igual, subtask W5-S1 (decision 2026-11-11, item 4): the quote also tells the days that fall on the proportional charge. The
// count of those days was inside `prorated_cents`; it is now two helpers that the charge and the quote share, so the days shown are the days
// charged. The arithmetic must not have moved: it is compared, over a grid, with the expression `prorated_cents` had before.
const h = createHarness('subscription-quote-days');
const owner = () => h.owner();

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

const scalar = async <T>(sql: string, bindings: unknown[] = []): Promise<T> => (await owner().raw<{ rows: Array<{ value: T }> }>(sql, bindings)).rows[0]!.value;

const START = '2026-11-01 00:00:00+00';
const END_30_DAYS = '2026-12-01 00:00:00+00';

describe('the days of a period', () => {
  const left = (start: string, end: string, at: string) =>
    scalar<number>('select app_private.period_days_left(?::timestamptz, ?::timestamptz, ?::timestamptz) as value', [start, end, at]);
  const length = (start: string, end: string) => scalar<number>('select app_private.period_length_days(?::timestamptz, ?::timestamptz) as value', [start, end]);

  it('counts the day that has begun and stops at the two ends: the whole period and nothing', async () => {
    expect(await left(START, END_30_DAYS, START)).toBe(30);
    expect(await left(START, END_30_DAYS, '2026-11-02 00:00:00+00')).toBe(29);
    expect(await left(START, END_30_DAYS, '2026-11-30 23:59:59+00')).toBe(1);
    expect(await left(START, END_30_DAYS, '2026-11-30 00:00:00+00')).toBe(1);
    expect(await left(START, END_30_DAYS, '2026-11-29 23:59:59+00')).toBe(2);
    expect(await left(START, END_30_DAYS, END_30_DAYS)).toBe(0);
    // Before the period began the days do not exceed it, and after it ended they do not go below nothing.
    expect(await left(START, END_30_DAYS, '2026-10-01 00:00:00+00')).toBe(30);
    expect(await left(START, END_30_DAYS, '2026-12-06 00:00:00+00')).toBe(0);
  });

  it('rounds the length of a period to the nearest whole day and never to less than one', async () => {
    expect(await length(START, END_30_DAYS)).toBe(30);
    expect(await length('2026-11-01 00:00:00+00', '2026-12-01 14:00:00+00')).toBe(31);
    expect(await length('2026-11-01 00:00:00+00', '2026-12-01 10:00:00+00')).toBe(30);
    expect(await length('2026-11-01 00:00:00+00', '2026-11-30 14:00:00+00')).toBe(30);
    expect(await length('2026-11-01 00:00:00+00', '2026-11-30 10:00:00+00')).toBe(29);
    expect(await length('2026-11-01 00:00:00+00', '2026-11-01 01:00:00+00')).toBe(1);
    expect(await length(START, START)).toBe(1);
  });

  it('keeps the helpers out of the reach of PUBLIC and of the application role', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ proname: string; public_exec: boolean; app_exec: boolean }> }>(`
      select p.proname, has_function_privilege('public', p.oid, 'execute') as public_exec, has_function_privilege('ageniza_app', p.oid, 'execute') as app_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('period_days_left', 'period_length_days', 'prorated_cents', 'quote_subscription_change') order by p.proname
    `);
    expect(rows).toEqual([
      { proname: 'period_days_left', public_exec: false, app_exec: false },
      { proname: 'period_length_days', public_exec: false, app_exec: false },
      { proname: 'prorated_cents', public_exec: false, app_exec: false },
      { proname: 'quote_subscription_change', public_exec: false, app_exec: true }
    ]);
  });
});

describe('the proportional charge did not move', () => {
  // The body `prorated_cents` had in 20261029000200, written out in full, run against the function as it is now.
  it('gives, over a grid of differences, periods and instants, what the expression it had gives', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ total: string; differing: string }> }>(`
      with grid as (
        select difference, period.period_start, period.period_end, period.period_start + make_interval(hours => offset_hours) as at
        from unnest(array[-9700, -1, 0, 1, 3, 5, 99, 100, 5000, 10000, 29900, 1234567]) difference
        cross join (values
          (timestamptz '2026-11-01 00:00:00+00', timestamptz '2026-12-01 00:00:00+00'),
          (timestamptz '2026-11-12 13:00:00+00', timestamptz '2026-12-12 13:00:00+00'),
          (timestamptz '2026-02-01 00:00:00+00', timestamptz '2026-03-01 00:00:00+00'),
          (timestamptz '2026-12-01 00:00:00+00', timestamptz '2027-01-01 00:00:00+00'),
          (timestamptz '2026-11-01 00:00:00+00', timestamptz '2026-11-03 00:00:00+00'),
          (timestamptz '2026-11-01 00:00:00+00', timestamptz '2026-11-01 05:00:00+00'),
          (timestamptz '2026-11-01 00:00:00+00', timestamptz '2026-11-30 14:00:00+00')
        ) as period (period_start, period_end)
        cross join unnest(array[-30, -1, 0, 1, 11, 12, 13, 23, 24, 25, 47, 48, 49, 100, 359, 360, 361, 719, 720, 721, 800]) offset_hours
      )
      select count(*) as total,
             count(*) filter (where app_private.prorated_cents(difference, period_start, period_end, at) is distinct from (
               select pg_catalog.round(
                 difference::numeric
                 * least(greatest(pg_catalog.ceil(pg_catalog.date_part('epoch', period_end - at) / 86400), 0), total.days)
                 / total.days
               )::integer
               from (select greatest(pg_catalog.round(pg_catalog.date_part('epoch', period_end - period_start) / 86400), 1) as days) total
             )) as differing
      from grid
    `);
    expect(Number(rows[0]!.total)).toBe(12 * 7 * 21);
    expect(Number(rows[0]!.differing)).toBe(0);
  });

  it('rounds the half to the even, as it did: one cent over two days is nothing and three cents over two days are two', async () => {
    const day = (difference: number, hours: number) => scalar<number>(
      "select app_private.prorated_cents(?::integer, timestamptz '2026-11-01 00:00:00+00', timestamptz '2026-11-03 00:00:00+00', timestamptz '2026-11-01 00:00:00+00' + make_interval(hours => ?::int)) as value",
      [difference, hours]
    );
    expect(await day(1, 24)).toBe(0);
    expect(await day(3, 24)).toBe(2);
    expect(await day(5, 24)).toBe(2);
    expect(await day(10000, 0)).toBe(10000);
    expect(await day(10000, 48)).toBe(0);
  });
});

describe('the quote tells the days of the proportional charge (decision 2026-11-11)', () => {
  const quote = async (user: string, agencyId: string, plan: string, clients = 0, gib = 0) =>
    (await h.asUser(user, (t) => t.raw<{ rows: Array<{ effect: string; monthly_cents: number; amount_cents: number; days_left: number | null; period_days: number | null }> }>(
      'select effect, monthly_cents, amount_cents, days_left, period_days from app_private.quote_subscription_change(?::uuid, ?, ?::integer, ?::integer)',
      [agencyId, plan, clients, gib]
    ))).rows[0]!;

  it('gives the days left and the days of the period for a raise, and the amount is that share of the difference', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial', { startedDaysAgo: 10, endsInDays: 20 });
    // Professional costs R$ 100,00 more a month: twenty days of thirty are R$ 66,67.
    expect(await quote(ownerId, agencyId, 'profissional')).toEqual({ effect: 'upgrade', monthly_cents: 19700, amount_cents: 6667, days_left: 20, period_days: 30 });
    await h.setPeriod(agencyId, 11, 20);
    expect(await quote(ownerId, agencyId, 'profissional')).toMatchObject({ effect: 'upgrade', amount_cents: 6452, days_left: 20, period_days: 31 });
  });

  it('counts the day that has begun: five hours left are one day of thirty', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    await owner().raw("update public.agency_subscriptions set current_period_end = now() + interval '5 hours', current_period_start = now() + interval '5 hours' - interval '30 days' where agency_id = ?", [agencyId]);
    expect(await quote(ownerId, agencyId, 'profissional')).toEqual({ effect: 'upgrade', monthly_cents: 19700, amount_cents: 333, days_left: 1, period_days: 30 });
  });

  it('gives the days of a raise that costs nothing too, since it is still a raise', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    // R$ 249,00 a month for 30 clients and 100 GiB; the plan below is R$ 197,40 for 30 clients and 101 GiB.
    await h.seedSubscription(agencyId, 'essencial', { extraClients: 20, extraGib: 80, startedDaysAgo: 10, endsInDays: 20 });
    expect(await quote(ownerId, agencyId, 'profissional', 0, 1)).toEqual({ effect: 'upgrade', monthly_cents: 19740, amount_cents: 0, days_left: 20, period_days: 30 });
  });

  it('gives no days for the first subscription, which charges the whole month, nor for a decrease, which charges nothing', async () => {
    const first = await h.trialAgency();
    expect(await quote(first.ownerId, first.agencyId, 'essencial')).toEqual({ effect: 'subscribe', monthly_cents: 9700, amount_cents: 9700, days_left: null, period_days: null });

    const running = await h.trialAgency();
    await h.seedSubscription(running.agencyId, 'profissional', { startedDaysAgo: 10, endsInDays: 20 });
    expect(await quote(running.ownerId, running.agencyId, 'essencial')).toEqual({ effect: 'downgrade', monthly_cents: 9700, amount_cents: 0, days_left: null, period_days: null });
  });

  it('gives no days for a subscription whose period ended: the next one is a first subscription', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    await h.endPeriod(agencyId, 3_600);
    expect(await quote(ownerId, agencyId, 'profissional')).toMatchObject({ effect: 'subscribe', days_left: null, period_days: null });
  });

  it('is still the Owner\'s alone: the answer of everybody else is the refusal it always was', async () => {
    const { agencyId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    await expect(quote(admin, agencyId, 'essencial')).rejects.toMatchObject({ code: '42501' });
    await expect(h.asNobody((t) => t.raw('select * from app_private.quote_subscription_change(?::uuid, ?, 0, 0)', [agencyId, 'essencial']))).rejects.toMatchObject({ code: '42501' });
  });

  it('charges, once requested, the amount that was quoted with those days', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial', { startedDaysAgo: 10, endsInDays: 20 });
    const quoted = await quote(ownerId, agencyId, 'profissional');
    const requested = await h.request(ownerId, agencyId, 'profissional');
    expect(requested.amount_cents).toBe(quoted.amount_cents);
    expect(Math.round(10000 * quoted.days_left! / quoted.period_days!)).toBe(requested.amount_cents);
  });
});
