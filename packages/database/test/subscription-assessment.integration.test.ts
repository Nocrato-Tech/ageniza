import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, GIB } from './support/subscriptions.js';

// Issue #775 (epic #770): the rules of a change and who may ask for it. The pure rules of a change (what it costs, what
// it refuses) are called with a fixed instant and fixed usage, so no clock decides a result.
const h = createHarness('subscription-assessment');
const owner = () => h.owner();

const T0 = '2026-11-16T00:00:00Z';
const assess = async (args: {
  current?: { plan: string; clients: number; gib: number; start: string; end: string };
  target: { plan: string; clients: number; gib: number };
  used?: { clients: number; bytes: number };
  at?: string;
}) => {
  const c = args.current;
  return (await owner().raw(
    `select * from app_private.assess_subscription_change(?, ?::integer, ?::integer, ?::timestamptz, ?::timestamptz, ?, ?::integer, ?::integer, ?::bigint, ?::bigint, ?::timestamptz)`,
    [c?.plan ?? null, c?.clients ?? null, c?.gib ?? null, c?.start ?? null, c?.end ?? null,
      args.target.plan, args.target.clients, args.target.gib, args.used?.clients ?? 0, args.used?.bytes ?? 0, args.at ?? T0]
  )).rows as Array<{ effect: string; monthly_cents: number; amount_cents: number }>;
};
const current = (plan: string, clients = 0, gib = 0) => ({ plan, clients, gib, start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' });

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('the pure assessment of a change', () => {
  it('starts a period at the full price of the target when there is no subscription', async () => {
    expect(await assess({ target: { plan: 'profissional', clients: 5, gib: 30 } })).toEqual([{ effect: 'subscribe', monthly_cents: 23900, amount_cents: 23900 }]);
  });

  it('raises at once and charges the difference for the days left of the period', async () => {
    // 30-day period, 15 days left at T0: half of R$ 100.
    expect(await assess({ current: current('essencial'), target: { plan: 'profissional', clients: 0, gib: 0 } }))
      .toEqual([{ effect: 'upgrade', monthly_cents: 19700, amount_cents: 5000 }]);
    // An extra client alone: R$ 6, half of it.
    expect(await assess({ current: current('essencial'), target: { plan: 'essencial', clients: 1, gib: 0 } }))
      .toEqual([{ effect: 'upgrade', monthly_cents: 10300, amount_cents: 300 }]);
    // An extra GiB: 40 cents, half of it.
    expect(await assess({ current: current('essencial'), target: { plan: 'essencial', clients: 0, gib: 1 } }))
      .toEqual([{ effect: 'upgrade', monthly_cents: 9740, amount_cents: 20 }]);
  });

  it('charges nothing for a raise of the limits whose price is lower than the current terms', async () => {
    // Essencial with 20 extra clients is 30 clients and 20 GiB at R$ 217; Profissional is 30 clients and 100 GiB at R$ 197.
    expect(await assess({ current: current('essencial', 20, 0), target: { plan: 'profissional', clients: 0, gib: 0 } }))
      .toEqual([{ effect: 'upgrade', monthly_cents: 19700, amount_cents: 0 }]);
  });

  it('waits for the next period to lower and charges nothing', async () => {
    expect(await assess({ current: current('profissional'), target: { plan: 'essencial', clients: 0, gib: 0 } }))
      .toEqual([{ effect: 'downgrade', monthly_cents: 9700, amount_cents: 0 }]);
    expect(await assess({ current: current('essencial', 4, 4), target: { plan: 'essencial', clients: 2, gib: 4 } }))
      .toEqual([{ effect: 'downgrade', monthly_cents: 11060, amount_cents: 0 }]);
  });

  it('judges by the limits: the same limits at a lower price wait, and at the same price change nothing', async () => {
    // Profissional is 30 clients and 100 GiB; Essencial with 20 extra clients and 80 extra GiB is the same limits, dearer.
    const same = { plan: 'essencial', clients: 20, gib: 80 };
    expect(await assess({ current: current('profissional'), target: same }))
      .toEqual([{ effect: 'upgrade', monthly_cents: 9700 + 20 * 600 + 80 * 40, amount_cents: Math.round(((9700 + 12000 + 3200) - 19700) / 2) }]);
    expect(await assess({ current: { ...current('essencial', 20, 80) }, target: { plan: 'profissional', clients: 0, gib: 0 } }))
      .toEqual([{ effect: 'downgrade', monthly_cents: 19700, amount_cents: 0 }]);
    await expect(assess({ current: current('profissional'), target: { plan: 'profissional', clients: 0, gib: 0 } })).rejects.toMatchObject({ code: 'A0113' });
  });

  it('refuses an increase together with a decrease', async () => {
    // Agência has 60 clients and 300 GiB. Profissional with 100 extra GiB: fewer clients, more storage.
    await expect(assess({ current: current('agencia'), target: { plan: 'profissional', clients: 0, gib: 250 } })).rejects.toMatchObject({ code: 'A0112' });
    await expect(assess({ current: current('profissional', 0, 250), target: { plan: 'agencia', clients: 0, gib: 0 } })).rejects.toMatchObject({ code: 'A0112' });
  });

  it('refuses a limit below the clients in use or the storage in use, and accepts a limit equal to it', async () => {
    await expect(assess({ current: current('profissional'), target: { plan: 'essencial', clients: 0, gib: 0 }, used: { clients: 11, bytes: 0 } }))
      .rejects.toMatchObject({ code: 'A0111', message: expect.stringContaining('10 clients') });
    await expect(assess({ current: current('profissional'), target: { plan: 'essencial', clients: 0, gib: 0 }, used: { clients: 0, bytes: 20 * GIB + 1 } }))
      .rejects.toMatchObject({ code: 'A0117' });
    expect(await assess({ current: current('profissional'), target: { plan: 'essencial', clients: 0, gib: 0 }, used: { clients: 10, bytes: 20 * GIB } }))
      .toEqual([{ effect: 'downgrade', monthly_cents: 9700, amount_cents: 0 }]);
    // The usage rule holds for the first subscription too.
    await expect(assess({ target: { plan: 'essencial', clients: 0, gib: 0 }, used: { clients: 11, bytes: 0 } })).rejects.toMatchObject({ code: 'A0111' });
  });

  it('refuses a plan that does not exist and a quantity out of range', async () => {
    await expect(assess({ target: { plan: 'inexistente', clients: 0, gib: 0 } })).rejects.toMatchObject({ code: 'A0116' });
    await expect(assess({ target: { plan: 'essencial', clients: -1, gib: 0 } })).rejects.toMatchObject({ code: 'A0116' });
    await expect(assess({ target: { plan: 'essencial', clients: 0, gib: 10001 } })).rejects.toMatchObject({ code: 'A0116' });
    await expect(assess({ target: { plan: 'essencial', clients: 10001, gib: 0 } })).rejects.toMatchObject({ code: 'A0116' });
    await expect(assess({ target: { plan: 'essencial', clients: 0, gib: -1 } })).rejects.toMatchObject({ code: 'A0116' });
    expect(await assess({ target: { plan: 'essencial', clients: 10000, gib: 10000 } })).toHaveLength(1);
  });
});

describe('the proration', () => {
  const prorated = async (difference: number, start: string, end: string, at: string) =>
    (await owner().raw('select app_private.prorated_cents(?::integer, ?::timestamptz, ?::timestamptz, ?::timestamptz) as cents', [difference, start, end, at])).rows[0].cents as number;
  const START = '2026-11-01T00:00:00Z';
  const END = '2026-12-01T00:00:00Z';

  it('charges the whole difference at the start and nothing at the end', async () => {
    expect(await prorated(10000, START, END, START)).toBe(10000);
    expect(await prorated(10000, START, END, END)).toBe(0);
  });

  it('counts the days left, rounding a started day up', async () => {
    expect(await prorated(9000, START, END, '2026-11-16T00:00:00Z')).toBe(4500);
    // 14 days and 12 hours left count as 15 of 30.
    expect(await prorated(9000, START, END, '2026-11-16T12:00:00Z')).toBe(4500);
    expect(await prorated(9000, START, END, '2026-11-30T23:59:59Z')).toBe(300);
  });

  it('rounds the cents to the nearest', async () => {
    // 20 of 30 days of R$ 100: 66,666... cents of reais, 6667.
    expect(await prorated(10000, START, END, '2026-11-11T00:00:00Z')).toBe(6667);
  });

  it('never charges more than the difference nor less than zero, whatever the instant', async () => {
    expect(await prorated(10000, START, END, '2026-10-01T00:00:00Z')).toBe(10000);
    expect(await prorated(10000, START, END, '2027-01-01T00:00:00Z')).toBe(0);
  });
});

describe('who may quote, ask, cancel and move the clock', () => {
  it('is only the Owner: no Admin, no role with another permission, no outsider, and nobody bound', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    const oneKey = await h.withPermissions(agencyId, 'cliente.cadastrar');
    const outsider = await h.person();
    const quote = (userId: string) => h.asUser(userId, (t) => t.raw('select * from app_private.quote_subscription_change(?::uuid, ?, 0, 0)', [agencyId, 'essencial']));

    await expect(quote(ownerId)).resolves.toBeDefined();
    for (const [name, userId] of [['an Admin', admin], ['a role of one other permission', oneKey], ['an outsider', outsider]] as const) {
      await expect(quote(userId), name).rejects.toMatchObject({ code: '42501' });
      await expect(h.request(userId, agencyId, 'essencial'), name).rejects.toMatchObject({ code: '42501' });
      await expect(h.asUser(userId, (t) => t.raw('select app_private.cancel_subscription(?::uuid)', [agencyId])), name).rejects.toMatchObject({ code: '42501' });
      await expect(h.asUser(userId, (t) => t.raw('select app_private.advance_simulated_period(?::uuid)', [agencyId])), name).rejects.toMatchObject({ code: '42501' });
    }
    await expect(h.asNobody((t) => t.raw('select * from app_private.quote_subscription_change(?::uuid, ?, 0, 0)', [agencyId, 'essencial']))).rejects.toMatchObject({ code: '42501' });
    expect(await owner()('subscription_charges').where({ agency_id: agencyId })).toHaveLength(0);
  });

  it('is the Owner by possession even without a membership', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner()('agency_memberships').where({ agency_id: agencyId, user_id: ownerId }).delete();
    const quoted = await h.asUser(ownerId, (t) => t.raw<{ rows: Array<{ effect: string }> }>('select * from app_private.quote_subscription_change(?::uuid, ?, 0, 0)', [agencyId, 'essencial']));
    expect(quoted.rows[0]!.effect).toBe('subscribe');
  });

  it('is not callable by PUBLIC, and the application role has the doors of the lifecycle and no door to the pure functions', async () => {
    const person = await h.person();
    const door = (sql: string) => h.asUser(person, (t) => t.raw(sql));
    await expect(door("select app_private.assess_subscription_change(null, null, null, null, null, 'essencial', 0, 0, 0, 0, now())")).rejects.toMatchObject({ code: '42501' });
    await expect(door('select app_private.prorated_cents(100, now(), now() + interval \'1 day\', now())')).rejects.toMatchObject({ code: '42501' });
    await expect(door('select app_private.require_no_person()')).rejects.toMatchObject({ code: '42501' });
    await expect(door('select app_private.next_renewal_terms(gen_random_uuid())')).rejects.toMatchObject({ code: '42501' });
    const { rows } = await owner().raw<{ rows: Array<{ proname: string; granted: boolean; definer: boolean; fixed_path: boolean }> }>(`
      select p.proname,
             has_function_privilege('ageniza_app', p.oid, 'execute') as granted,
             p.prosecdef as definer,
             coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in ('quote_subscription_change', 'request_subscription_change', 'confirm_subscription_charge', 'cancel_subscription',
                          'renew_subscription', 'next_renewal_cents', 'agencies_due_for_renewal', 'advance_simulated_period', 'subscription_overview')
    `);
    expect(rows.map((row) => row.proname).sort()).toEqual([
      'advance_simulated_period', 'agencies_due_for_renewal', 'cancel_subscription', 'confirm_subscription_charge',
      'next_renewal_cents', 'quote_subscription_change', 'renew_subscription', 'request_subscription_change', 'subscription_overview'
    ]);
    for (const row of rows) {
      expect(row.granted, row.proname).toBe(true);
      expect(row.definer, row.proname).toBe(true);
      expect(row.fixed_path, row.proname).toBe(true);
    }
    const { rows: publicRows } = await owner().raw<{ rows: Array<{ proname: string }> }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in ('quote_subscription_change', 'request_subscription_change', 'confirm_subscription_charge', 'cancel_subscription', 'renew_subscription',
                          'next_renewal_cents', 'next_renewal_terms', 'agencies_due_for_renewal', 'advance_simulated_period', 'subscription_overview',
                          'prorated_cents', 'assess_subscription_change', 'assess_agency_subscription_change', 'require_no_person', 'require_subscription_owner')
        and has_function_privilege('public', p.oid, 'execute')
    `);
    expect(publicRows).toEqual([]);
  });
});
