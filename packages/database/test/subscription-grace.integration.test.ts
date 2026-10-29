import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness } from './support/subscriptions.js';

// Issue #775 (epic #770), the owner's answers of 2026-10-29: an agency whose period ended without a confirmed renewal keeps writing
// for 3 days and is read-only after them; a canceled one has no such window; a renewal inside the window starts where the old
// period ended; the Owner takes a cancellation back until the period ends. Every clock here is the database's.
const h = createHarness('subscription-grace');
const owner = () => h.owner();

const READ_ONLY = { code: 'A0090' };
const HOUR = 3600;
const DAY = 24 * HOUR;

const auditActions = async (agencyId: string): Promise<string[]> =>
  (await owner().raw<{ rows: Array<{ action: string }> }>("select action from audit.events where agency_id = ? and action like 'subscription.%' order by occurred_at, id", [agencyId])).rows.map((row) => row.action);
const chargesOf = (agencyId: string) => owner()('subscription_charges').where({ agency_id: agencyId }).orderBy('created_at');
const renew = (agencyId: string, ref: string, cents: number) =>
  h.asNobody(async (transaction) => (await transaction.raw<{ rows: Array<{ renewed: boolean }> }>(
    'select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed', [agencyId, 'simulado', ref, cents]
  )).rows[0]!.renewed);
const cancel = (userId: string, agencyId: string) => h.asUser(userId, (t) => t.raw('select app_private.cancel_subscription(?::uuid)', [agencyId]));
const reactivate = (userId: string, agencyId: string) => h.asUser(userId, (t) => t.raw('select app_private.reactivate_subscription(?::uuid)', [agencyId]));
const advance = (userId: string, agencyId: string) => h.asUser(userId, (t) => t.raw('select app_private.advance_simulated_period(?::uuid)', [agencyId]));
// What the worker would charge: null when the subscription is not due, so a list capped at 500 rows cannot hide the agency.
const renewalCents = async (agencyId: string): Promise<number | null> =>
  (await owner().raw<{ rows: Array<{ cents: number | null }> }>('select app_private.next_renewal_cents(?::uuid) as cents', [agencyId])).rows[0]!.cents;
const periodOf = async (agencyId: string): Promise<{ start: Date; end: Date }> => {
  const row = (await h.subscriptionOf(agencyId))!;
  return { start: row.current_period_start as Date, end: row.current_period_end as Date };
};
const startedNow = async (agencyId: string): Promise<boolean> =>
  (await owner().raw<{ rows: Array<{ now: boolean }> }>(
    'select abs(extract(epoch from now() - current_period_start)) < 30 as now from public.agency_subscriptions where agency_id = ?', [agencyId])).rows[0]!.now;
const overview = (userId: string, agencyId: string) =>
  h.asUser(userId, async (t: Knex.Transaction) => (await t.raw<{ rows: Array<{ grace_ends_on: string | null }> }>(
    "select to_char(grace_ends_on, 'YYYY-MM-DD') as grace_ends_on from app_private.subscription_overview(?::uuid)", [agencyId])).rows[0]!.grace_ends_on);

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

const subscribed = async (plan = 'essencial') => {
  const agency = await h.trialAgency();
  await h.subscribe(agency.ownerId, agency.agencyId, plan);
  return agency;
};

describe('the three days after an unpaid period', () => {
  it('keeps the agency writing for three days after the period ended, and not for the fourth', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, 2 * DAY + 23 * HOUR);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));

    await h.endPeriod(agencyId, 3 * DAY + HOUR);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
  });

  it('keeps the ceilings of the plan inside the window', async () => {
    const { agencyId, ownerId } = await subscribed();
    for (let index = 0; index < 10; index += 1) await h.insertClient(ownerId, agencyId);
    await h.endPeriod(agencyId, DAY);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ code: 'A0091' });
  });

  it('gives a canceled subscription no window: it is read-only the moment the period ends', async () => {
    const { agencyId, ownerId } = await subscribed();
    await cancel(ownerId, agencyId);
    await h.endPeriod(agencyId, -HOUR);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    await h.endPeriod(agencyId, HOUR);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
  });

  it('shows the last day to pay in the day of São Paulo, and only while the window is open', async () => {
    const { agencyId, ownerId } = await subscribed();
    // The window ends at 01:30 UTC, which is still the day before in São Paulo.
    await owner().raw(
      `update public.agency_subscriptions
       set current_period_end = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 day' + interval '1 hour 30 minutes',
           current_period_start = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 day' + interval '1 hour 30 minutes' - interval '1 month'
       where agency_id = ?`, [agencyId]);
    const { rows } = await owner().raw<{ rows: Array<{ expected: string }> }>(
      "select to_char((current_period_end + interval '3 days') at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as expected from public.agency_subscriptions where agency_id = ?", [agencyId]);
    const { rows: utc } = await owner().raw<{ rows: Array<{ utc: string }> }>(
      "select to_char((current_period_end + interval '3 days') at time zone 'UTC', 'YYYY-MM-DD') as utc from public.agency_subscriptions where agency_id = ?", [agencyId]);
    expect(rows[0]!.expected).not.toBe(utc[0]!.utc);
    expect(await overview(ownerId, agencyId)).toBe(rows[0]!.expected);

    await h.endPeriod(agencyId, -HOUR);
    expect(await overview(ownerId, agencyId)).toBeNull();
    await h.endPeriod(agencyId, 3 * DAY + HOUR);
    expect(await overview(ownerId, agencyId)).toBeNull();
    await h.endPeriod(agencyId, HOUR);
    await owner().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    expect(await overview(ownerId, agencyId)).toBeNull();
  });
});

describe('renewing and subscribing again inside the window', () => {
  it('starts the renewal where the old period ended, so the days of the window are paid', async () => {
    const { agencyId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    const before = await periodOf(agencyId);
    expect(await renew(agencyId, 'ref-in-window', 9700)).toBe(true);
    const after = await periodOf(agencyId);
    expect(after.start).toEqual(before.end);
    expect((await owner().raw<{ rows: Array<{ month: boolean }> }>(
      "select current_period_end = current_period_start + interval '1 month' as month from public.agency_subscriptions where agency_id = ?", [agencyId])).rows[0]!.month).toBe(true);
    expect(await chargesOf(agencyId)).toMatchObject([{ kind: 'subscribe' }, { kind: 'renewal', status: 'confirmed', period_start: before.end, period_end: after.end }]);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
  });

  it('starts the renewal that comes after the window now, since the days after it were read-only', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, 3 * DAY + HOUR);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
    expect(await renew(agencyId, 'ref-after-window', 9700)).toBe(true);
    expect(await startedNow(agencyId)).toBe(true);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('starts a new subscription of an agency in the window where the old period ended', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    const before = await periodOf(agencyId);
    await h.subscribe(ownerId, agencyId, 'profissional');
    const after = await periodOf(agencyId);
    expect(after.start).toEqual(before.end);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', cancel_at_period_end: false });
  });

  it('starts a new subscription now after the window, and now for a canceled one that ended', async () => {
    const late = await subscribed();
    await h.endPeriod(late.agencyId, 3 * DAY + HOUR);
    await h.subscribe(late.ownerId, late.agencyId, 'profissional');
    expect(await startedNow(late.agencyId)).toBe(true);

    const canceled = await subscribed();
    await cancel(canceled.ownerId, canceled.agencyId);
    await h.endPeriod(canceled.agencyId, HOUR);
    await h.subscribe(canceled.ownerId, canceled.agencyId, 'profissional');
    expect(await startedNow(canceled.agencyId)).toBe(true);
    expect(await h.subscriptionOf(canceled.agencyId)).toMatchObject({ plan_key: 'profissional', cancel_at_period_end: false });
  });

  it('renews a canceled subscription never, and an unpaid one while the window runs', async () => {
    const unpaid = await subscribed();
    await h.endPeriod(unpaid.agencyId, DAY);
    const canceled = await subscribed();
    await cancel(canceled.ownerId, canceled.agencyId);
    await h.endPeriod(canceled.agencyId, DAY);
    expect(await renewalCents(unpaid.agencyId)).toBe(9700);
    expect(await renewalCents(canceled.agencyId)).toBeNull();
  });
});

describe('the read-only answer the agency screen reads (issue #772)', () => {
  const readOnly = (userId: string, agencyId: string) =>
    h.asUser(userId, async (t: Knex.Transaction) => (await t.raw<{ rows: Array<{ read_only: boolean | null }> }>(
      'select app_private.agency_is_read_only(?::uuid) as read_only', [agencyId])).rows[0]!.read_only);

  it('says what the write triggers say, in every state of the plan, to the Owner and to a member', async () => {
    const cases: Array<[string, () => Promise<{ agencyId: string; ownerId: string }>, boolean]> = [
      ['a trial that runs', () => h.trialAgency(), false],
      ['a trial that ended', async () => {
        const agency = await h.trialAgency();
        await owner().raw("update public.agencies set trial_ends_at = now() - interval '1 hour' where id = ?", [agency.agencyId]);
        return agency;
      }, true],
      ['a paid period that runs', () => subscribed(), false],
      ['an unpaid period inside the window', async () => {
        const agency = await subscribed();
        await h.endPeriod(agency.agencyId, DAY);
        return agency;
      }, false],
      ['an unpaid period past the window', async () => {
        const agency = await subscribed();
        await h.endPeriod(agency.agencyId, 3 * DAY + HOUR);
        return agency;
      }, true],
      ['a canceled period that runs', async () => {
        const agency = await subscribed();
        await cancel(agency.ownerId, agency.agencyId);
        return agency;
      }, false],
      ['a canceled period that ended', async () => {
        const agency = await subscribed();
        await cancel(agency.ownerId, agency.agencyId);
        await h.endPeriod(agency.agencyId, HOUR);
        return agency;
      }, true]
    ];
    for (const [name, make, expected] of cases) {
      const { agencyId, ownerId } = await make();
      expect(await h.acceptsWrites(agencyId), name).toBe(!expected);
      expect(await readOnly(ownerId, agencyId), name).toBe(expected);
      expect(await readOnly(await h.withRole(agencyId, 'admin'), agencyId), `${name}, a member`).toBe(expected);
    }
  });

  it('says nothing to a person who is not in the agency', async () => {
    const { agencyId } = await subscribed();
    await h.endPeriod(agencyId, 3 * DAY + HOUR);
    expect(await readOnly(await h.person(), agencyId)).toBeNull();
  });
});

describe('canceling inside the window (owner, 2026-10-29)', () => {
  const dueForRenewal = async (): Promise<string[]> =>
    (await owner().raw<{ rows: Array<{ id: string }> }>('select app_private.agencies_due_for_renewal(500) as id')).rows.map((row) => row.id);

  it('lets the Owner cancel an unpaid period, and the agency is read-only at once', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
    await cancel(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.canceled']);
  });

  it('cancels up to the last hour of the window and not after it', async () => {
    const inside = await subscribed();
    await h.endPeriod(inside.agencyId, 3 * DAY - HOUR);
    await cancel(inside.ownerId, inside.agencyId);
    expect(await h.subscriptionOf(inside.agencyId)).toMatchObject({ cancel_at_period_end: true });

    const outside = await subscribed();
    await h.endPeriod(outside.agencyId, 3 * DAY + HOUR);
    await expect(cancel(outside.ownerId, outside.agencyId)).rejects.toMatchObject({ code: 'A0110' });
    expect(await h.subscriptionOf(outside.agencyId)).toMatchObject({ cancel_at_period_end: false });
  });

  it('answers a second cancellation without a second audit event', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    await cancel(ownerId, agencyId);
    await cancel(ownerId, agencyId);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.canceled']);
  });

  it('tries no renewal after the cancellation: the worker does not list it and a renewal that arrives is refused', async () => {
    const unpaid = await subscribed();
    await h.endPeriod(unpaid.agencyId, DAY);
    const canceled = await subscribed();
    await h.endPeriod(canceled.agencyId, DAY);
    expect(await dueForRenewal()).toEqual(expect.arrayContaining([unpaid.agencyId, canceled.agencyId]));
    await cancel(canceled.ownerId, canceled.agencyId);
    const due = await dueForRenewal();
    expect(due).toContain(unpaid.agencyId);
    expect(due).not.toContain(canceled.agencyId);
    expect(await renewalCents(canceled.agencyId)).toBeNull();
    const before = await h.subscriptionOf(canceled.agencyId);
    await expect(renew(canceled.agencyId, 'ref-after-cancel', 9700)).rejects.toMatchObject({ code: 'A0115' });
    expect(await h.subscriptionOf(canceled.agencyId)).toEqual(before);
    expect(await chargesOf(canceled.agencyId)).toMatchObject([{ kind: 'subscribe' }]);
  });

  it('invalidates the charge that was pending, so the provider can no longer confirm it', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    const requested = await h.request(ownerId, agencyId, 'profissional');
    expect(await chargesOf(agencyId)).toMatchObject([{ status: 'confirmed' }, { status: 'pending' }]);
    await cancel(ownerId, agencyId);
    expect(await chargesOf(agencyId)).toMatchObject([{ status: 'confirmed' }, { status: 'expired' }]);
    await expect(h.confirm(requested.charge_id!, 'ref-after-cancel', requested.amount_cents)).rejects.toMatchObject({ code: 'A0114' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', cancel_at_period_end: true });
  });

  it('cannot be taken back inside the window, and the agency subscribes again instead, starting now', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    await cancel(ownerId, agencyId);
    await expect(reactivate(ownerId, agencyId)).rejects.toMatchObject({ code: 'A0110' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
    await h.subscribe(ownerId, agencyId, 'profissional');
    expect(await startedNow(agencyId)).toBe(true);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', cancel_at_period_end: false });
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('is only for the Owner, inside the window too: no Admin, no role with one other permission, nobody bound', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    const admin = await h.withRole(agencyId, 'admin');
    const oneKey = await h.withPermissions(agencyId, 'cliente.cadastrar');
    await expect(cancel(admin, agencyId)).rejects.toMatchObject({ code: '42501' });
    await expect(cancel(oneKey, agencyId)).rejects.toMatchObject({ code: '42501' });
    await expect(h.asNobody((t) => t.raw('select app_private.cancel_subscription(?::uuid)', [agencyId]))).rejects.toMatchObject({ code: '42501' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: false });
    await cancel(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
  });
});

describe('taking a cancellation back', () => {
  it('lets the Owner undo it with no charge, and the renewal goes on as before', async () => {
    const { agencyId, ownerId } = await subscribed();
    await owner().raw("update public.agency_subscriptions set current_period_end = now() + interval '12 hours' where agency_id = ?", [agencyId]);
    await cancel(ownerId, agencyId);
    expect(await renewalCents(agencyId)).toBeNull();
    const charges = await chargesOf(agencyId);
    // Another agency's cancellation must not be taken back with this one's.
    const neighbour = await subscribed();
    await cancel(neighbour.ownerId, neighbour.agencyId);

    await reactivate(ownerId, agencyId);

    expect(await h.subscriptionOf(neighbour.agencyId)).toMatchObject({ cancel_at_period_end: true });
    expect(await owner()('audit.events').where({ agency_id: agencyId, action: 'subscription.reactivated' }).select('actor_user_id')).toEqual([{ actor_user_id: ownerId }]);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: false, plan_key: 'essencial' });
    expect(await chargesOf(agencyId)).toEqual(charges);
    expect(await renewalCents(agencyId)).toBe(9700);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.canceled', 'subscription.reactivated']);
    expect(await renew(agencyId, 'ref-after-reactivation', 9700)).toBe(true);
  });

  it('keeps the plan that was running, and the decrease the cancellation dropped stays dropped', async () => {
    const { agencyId, ownerId } = await subscribed('profissional');
    await h.request(ownerId, agencyId, 'essencial');
    await cancel(ownerId, agencyId);
    await reactivate(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null, cancel_at_period_end: false });
  });

  it('does nothing for a subscription that is not canceled, and says nothing in the audit', async () => {
    const { agencyId, ownerId } = await subscribed();
    const before = await h.subscriptionOf(agencyId);
    await reactivate(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed']);
  });

  it('refuses after the period ended, canceled or not, and the agency subscribes again instead', async () => {
    const { agencyId, ownerId } = await subscribed();
    await cancel(ownerId, agencyId);
    await h.endPeriod(agencyId, HOUR);
    await expect(reactivate(ownerId, agencyId)).rejects.toMatchObject({ code: 'A0110' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });

    const unpaid = await subscribed();
    await h.endPeriod(unpaid.agencyId, HOUR);
    await expect(reactivate(unpaid.ownerId, unpaid.agencyId)).rejects.toMatchObject({ code: 'A0110' });
  });

  it('refuses an agency with no subscription and a courtesy', async () => {
    const trial = await h.trialAgency();
    await expect(reactivate(trial.ownerId, trial.agencyId)).rejects.toMatchObject({ code: 'A0110' });

    const courtesy = await h.trialAgency();
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [courtesy.agencyId]);
    await expect(reactivate(courtesy.ownerId, courtesy.agencyId)).rejects.toMatchObject({ code: 'A0110' });
  });

  it('is only for the Owner: no Admin, no role with one other permission, no outsider and nobody bound', async () => {
    const { agencyId, ownerId } = await subscribed();
    const admin = await h.withRole(agencyId, 'admin');
    const oneKey = await h.withPermissions(agencyId, 'cliente.cadastrar');
    const outsider = await h.person();
    await cancel(ownerId, agencyId);
    for (const [name, userId] of [['an Admin', admin], ['a role of one other permission', oneKey], ['an outsider', outsider]] as const) {
      await expect(reactivate(userId, agencyId), name).rejects.toMatchObject({ code: '42501' });
    }
    await expect(h.asNobody((t) => t.raw('select app_private.reactivate_subscription(?::uuid)', [agencyId]))).rejects.toMatchObject({ code: '42501' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.canceled']);
  });

  it('waits for a client being created, which holds the lock of the agency', async () => {
    const { agencyId, ownerId } = await subscribed();
    await cancel(ownerId, agencyId);
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder('clients').insert({ agency_id: agencyId, name: 'Cliente que segura a trava' });
      let settled = false;
      const waiting = reactivate(ownerId, agencyId).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
        const { rows } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
        if (rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toBe(false);
      await holder.commit();
      await waiting;
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: false });
  });

  it.each(['repeatable read', 'serializable'] as const)('is refused in %s, which would count past the lock', async (level) => {
    const { agencyId, ownerId } = await subscribed();
    await cancel(ownerId, agencyId);
    const transaction = await h.openTransactionAs(ownerId, level);
    try {
      await expect(transaction.raw('select app_private.reactivate_subscription(?::uuid)', [agencyId])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
  });
});

describe('the simulated clock and the window', () => {
  it('ends the period, and then the window, and then does nothing', async () => {
    const { agencyId, ownerId } = await subscribed();
    await advance(ownerId, agencyId);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    expect(await overview(ownerId, agencyId)).not.toBeNull();

    await advance(ownerId, agencyId);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);

    const settled = await h.subscriptionOf(agencyId);
    await advance(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toEqual(settled);
    expect((await auditActions(agencyId)).filter((action) => action === 'subscription.simulated_period_ended')).toHaveLength(2);
  });

  it('moves the window of a period that ended a day ago so that it ends now', async () => {
    const { agencyId, ownerId } = await subscribed();
    await h.endPeriod(agencyId, DAY);
    await advance(ownerId, agencyId);
    const { rows } = await owner().raw<{ rows: Array<{ window_ended_now: boolean }> }>(
      "select abs(extract(epoch from now() - (current_period_end + interval '3 days'))) < 30 as window_ended_now from public.agency_subscriptions where agency_id = ?", [agencyId]);
    expect(rows).toEqual([{ window_ended_now: true }]);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
  });

  it('does not carry a canceled subscription past its end: there is no window to end', async () => {
    const { agencyId, ownerId } = await subscribed();
    await cancel(ownerId, agencyId);
    await advance(ownerId, agencyId);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    const settled = await h.subscriptionOf(agencyId);
    await advance(ownerId, agencyId);
    expect(await h.subscriptionOf(agencyId)).toEqual(settled);
  });
});
