import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, GIB } from './support/subscriptions.js';

// Issue #771 (epic #770): the life of a subscription in the database. A plan or a limit moves only when the provider
// confirmed a charge the Owner was quoted; the periods are moved by the database clock, never by the test's.
const h = createHarness('subscription-lifecycle');
const owner = () => h.owner();

const CLIENT_LIMIT = { code: 'A0091' };
const READ_ONLY = { code: 'A0090' };

const agencyRow = (agencyId: string) => owner()('agencies').where({ id: agencyId }).first('plan', 'trial_ends_at');
const chargesOf = (agencyId: string) => owner()('subscription_charges').where({ agency_id: agencyId }).orderBy('created_at');
const auditActions = async (agencyId: string): Promise<string[]> =>
  (await owner().raw<{ rows: Array<{ action: string }> }>("select action from audit.events where agency_id = ? and action like 'subscription.%' order by occurred_at, id", [agencyId])).rows.map((row) => row.action);
const addClients = async (agencyId: string, count: number): Promise<void> => {
  await owner()('clients').insert(Array.from({ length: count }, () => ({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` })));
};
const activeClients = async (agencyId: string): Promise<number> =>
  Number((await owner()('clients').where({ agency_id: agencyId, status: 'active' }).count('* as n').first())?.n);
const renew = (agencyId: string, ref: string, cents: number, provider = 'simulado') =>
  h.asNobody(async (transaction) => (await transaction.raw<{ rows: Array<{ renewed: boolean }> }>(
    'select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed', [agencyId, provider, ref, cents]
  )).rows[0]!.renewed);
const renewalCents = async (agencyId: string): Promise<number | null> =>
  (await owner().raw<{ rows: Array<{ cents: number | null }> }>('select app_private.next_renewal_cents(?::uuid) as cents', [agencyId])).rows[0]!.cents;
const dueList = async (): Promise<string[]> =>
  (await owner().raw<{ rows: Array<{ id: string }> }>('select app_private.agencies_due_for_renewal(500) as id')).rows.map((row) => row.id);
const advance = (ownerId: string, agencyId: string) => h.asUser(ownerId, (t) => t.raw('select app_private.advance_simulated_period(?::uuid)', [agencyId]));
const cancel = (ownerId: string, agencyId: string) => h.asUser(ownerId, (t) => t.raw('select app_private.cancel_subscription(?::uuid)', [agencyId]));

// Nobody bound is the server: the provider's webhook and the worker.
const run = <TResult>(userId: string | null, work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult> =>
  userId === null ? h.asNobody(work) : h.asUser(userId, work);

// Waits for a backend blocked on an advisory lock, as the trial's race tests do.
const waitForBlockedLock = async (isSettled: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !isSettled(); attempt += 1) {
    const { rows } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('subscribing', () => {
  it('changes nothing until the provider confirms, then moves the agency from trial to the plan with its quota', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const quoted = await h.request(ownerId, agencyId, 'profissional', 5, 30);
    expect(quoted).toMatchObject({ effect: 'subscribe', monthly_cents: 23900, amount_cents: 23900 });

    expect(await agencyRow(agencyId)).toMatchObject({ plan: 'trial' });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
    expect(await h.quotaOf(agencyId)).toBe(String(2 * GIB));
    expect(await chargesOf(agencyId)).toMatchObject([{ kind: 'subscribe', status: 'pending', amount_cents: 23900, requested_by_user_id: ownerId, provider: null, provider_ref: null }]);

    expect(await h.confirm(quoted.charge_id!, 'ref-subscribe', 23900)).toBe(true);

    expect(await agencyRow(agencyId)).toEqual({ plan: 'ativo', trial_ends_at: null });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({
      plan_key: 'profissional', extra_clients: 5, extra_storage_gib: 30, provider: 'simulado', cancel_at_period_end: false,
      pending_plan_key: null, pending_extra_clients: null, pending_extra_storage_gib: null
    });
    const { rows: period } = await owner().raw<{ rows: Array<{ one_month: boolean; starts_now: boolean }> }>(
      `select current_period_end = current_period_start + interval '1 month' as one_month,
              abs(extract(epoch from now() - current_period_start)) < 30 as starts_now
       from public.agency_subscriptions where agency_id = ?`, [agencyId]);
    expect(period).toEqual([{ one_month: true, starts_now: true }]);
    expect(await h.quotaOf(agencyId)).toBe(String(130 * GIB));
    expect(await chargesOf(agencyId)).toMatchObject([{ status: 'confirmed', provider: 'simulado', provider_ref: 'ref-subscribe', amount_cents: 23900 }]);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed']);
  });

  it('lets an expired trial subscribe, and the agency writes again', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner().raw("update public.agencies set trial_ends_at = now() - interval '1 minute' where id = ?", [agencyId]);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
    await h.subscribe(ownerId, agencyId, 'essencial');
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('refuses a confirmation that does not match: the wrong amount, an unknown charge, no provider, no reference', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(ownerId, agencyId, 'essencial');
    await expect(h.confirm(chargeId!, 'ref-a', 9699)).rejects.toMatchObject({ code: 'A0114' });
    await expect(h.confirm(chargeId!, 'ref-a', 9701)).rejects.toMatchObject({ code: 'A0114' });
    await expect(h.confirm(randomUUID(), 'ref-a', 9700)).rejects.toMatchObject({ code: 'A0114' });
    await expect(h.confirm(chargeId!, 'ref-a', 9700, 'stripe')).rejects.toMatchObject({ code: 'A0114' });
    await expect(h.confirm(chargeId!, 'ref-a', 9700, 'cortesia')).rejects.toMatchObject({ code: 'A0114' });
    await expect(h.confirm(chargeId!, '  ', 9700)).rejects.toMatchObject({ code: 'A0114' });
    expect(await agencyRow(agencyId)).toMatchObject({ plan: 'trial' });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
    expect(await chargesOf(agencyId)).toMatchObject([{ status: 'pending' }]);
  });

  it('answers false to the same confirmation again, and refuses another reference for a confirmed charge', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(ownerId, agencyId, 'essencial');
    expect(await h.confirm(chargeId!, 'ref-once', 9700)).toBe(true);
    const before = await h.subscriptionOf(agencyId);
    expect(await h.confirm(chargeId!, 'ref-once', 9700)).toBe(false);
    await expect(h.confirm(chargeId!, 'ref-other', 9700)).rejects.toMatchObject({ code: 'A0114' });
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
    expect(await chargesOf(agencyId)).toHaveLength(1);
  });

  it('refuses an upgrade confirmed after the period ended, which would raise a plan nobody renewed', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    const raise = await h.request(ownerId, agencyId, 'profissional');
    expect(raise.effect).toBe('upgrade');
    await h.setPeriod(agencyId, 31, 0);
    await expect(h.confirm(raise.charge_id!, 'ref-late-upgrade', raise.amount_cents)).rejects.toMatchObject({ code: 'A0114', message: expect.stringContaining('changed after the charge') });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial' });
    expect(await chargesOf(agencyId)).toMatchObject([{ kind: 'subscribe', status: 'confirmed' }, { kind: 'upgrade', status: 'pending' }]);
  });

  it('gives a pending charge thirty minutes', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const quoted = await h.request(ownerId, agencyId, 'essencial');
    const { rows } = await owner().raw<{ rows: Array<{ window: boolean }> }>(
      "select expires_at - created_at = interval '30 minutes' as window from public.subscription_charges where id = ?", [quoted.charge_id]);
    expect(rows[0]!.window).toBe(true);
  });

  it('tells when a quoted change takes effect: now to raise, the end of the period to lower', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    const quote = async (plan: string) => (await h.asUser(ownerId, (t) => t.raw<{ rows: Array<{ effect: string; effective_at: Date }> }>(
      'select * from app_private.quote_subscription_change(?::uuid, ?, 0, 0)', [agencyId, plan]))).rows[0]!;
    const up = await quote('agencia');
    expect(up.effect).toBe('upgrade');
    expect(Math.abs(up.effective_at.getTime() - Date.now())).toBeLessThan(60_000);
    const down = await quote('essencial');
    expect(down.effect).toBe('downgrade');
    expect(down.effective_at).toEqual((await h.subscriptionOf(agencyId))!.current_period_end);
  });

  it('refuses a provider reference that already confirmed another charge', async () => {
    const first = await h.trialAgency();
    const second = await h.trialAgency();
    const one = await h.request(first.ownerId, first.agencyId, 'essencial');
    const two = await h.request(second.ownerId, second.agencyId, 'essencial');
    await h.confirm(one.charge_id!, 'ref-shared', 9700);
    await expect(h.confirm(two.charge_id!, 'ref-shared', 9700)).rejects.toMatchObject({ code: 'A0114' });
    expect(await agencyRow(second.agencyId)).toMatchObject({ plan: 'trial' });
  });

  it('refuses a charge that expired by time, and one a newer request replaced', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const old = await h.request(ownerId, agencyId, 'essencial');
    await owner().raw("update public.subscription_charges set expires_at = now() - interval '1 second' where id = ?", [old.charge_id]);
    await expect(h.confirm(old.charge_id!, 'ref-late', 9700)).rejects.toMatchObject({ code: 'A0114' });

    const replaced = await h.request(ownerId, agencyId, 'essencial');
    const newer = await h.request(ownerId, agencyId, 'profissional');
    expect((await chargesOf(agencyId)).map((row) => row.status)).toEqual(['expired', 'expired', 'pending']);
    await expect(h.confirm(replaced.charge_id!, 'ref-replaced', 9700)).rejects.toMatchObject({ code: 'A0114' });
    expect(await h.confirm(newer.charge_id!, 'ref-newer', 19700)).toBe(true);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional' });
  });

  it('refuses to confirm when the clients in use outgrew the plan meanwhile', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(ownerId, agencyId, 'essencial');
    await addClients(agencyId, 11);
    await expect(h.confirm(chargeId!, 'ref-big', 9700)).rejects.toMatchObject({ code: 'A0111' });
    expect(await agencyRow(agencyId)).toMatchObject({ plan: 'trial' });
  });

  it('keeps one pending charge when the Owner asks twice at the same time', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await Promise.all([h.request(ownerId, agencyId, 'essencial'), h.request(ownerId, agencyId, 'profissional')]);
    expect((await chargesOf(agencyId)).map((row) => row.status).sort()).toEqual(['expired', 'pending']);
  });

  it('applies one confirmation when it arrives twice at the same time', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(ownerId, agencyId, 'essencial');
    const results = await Promise.all([h.confirm(chargeId!, 'ref-twin', 9700), h.confirm(chargeId!, 'ref-twin', 9700)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed']);
  });

  it('takes the provider as data: a confirmation by asaas sets asaas, and the simulated provider cannot renew it', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(ownerId, agencyId, 'essencial');
    await h.confirm(chargeId!, 'pay_123', 9700, 'asaas');
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ provider: 'asaas' });
    await owner().raw("update public.agency_subscriptions set current_period_end = now() where agency_id = ?", [agencyId]);
    await expect(renew(agencyId, 'sim-1', 9700, 'simulado')).rejects.toMatchObject({ code: 'A0114' });
    expect(await renew(agencyId, 'pay_124', 9700, 'asaas')).toBe(true);
  });

  it('refuses an agency that is exempt, one whose plan the operation manages, and a suspended one', async () => {
    const exempt = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'isenta', trial_ends_at = null where id = ?", [exempt.agencyId]);
    await expect(h.request(exempt.ownerId, exempt.agencyId, 'essencial')).rejects.toMatchObject({ code: 'A0110' });

    const legacy = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'ativo', trial_ends_at = null where id = ?", [legacy.agencyId]);
    await expect(h.request(legacy.ownerId, legacy.agencyId, 'essencial')).rejects.toMatchObject({ code: 'A0110' });

    const suspended = await h.trialAgency();
    await owner().raw("update public.agencies set status = 'suspended' where id = ?", [suspended.agencyId]);
    await expect(h.request(suspended.ownerId, suspended.agencyId, 'essencial')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('raising the plan or buying an extra', () => {
  it('charges the days left, applies at once and leaves the period alone', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 10, 20);
    const before = await h.subscriptionOf(agencyId);

    const quoted = await h.request(ownerId, agencyId, 'profissional');
    // R$ 100 of difference for 20 of the 30 days.
    expect(quoted).toMatchObject({ effect: 'upgrade', monthly_cents: 19700, amount_cents: 6667 });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial' });
    expect(await h.quotaOf(agencyId)).toBe(String(20 * GIB));

    expect(await h.confirm(quoted.charge_id!, 'ref-up', 6667)).toBe(true);
    const after = await h.subscriptionOf(agencyId);
    expect(after).toMatchObject({ plan_key: 'profissional' });
    expect(after!.current_period_start).toEqual(before!.current_period_start);
    expect(after!.current_period_end).toEqual(before!.current_period_end);
    expect(await h.quotaOf(agencyId)).toBe(String(100 * GIB));
    expect((await chargesOf(agencyId)).map((row) => [row.kind, row.status, row.amount_cents])).toEqual([['subscribe', 'confirmed', 9700], ['upgrade', 'confirmed', 6667]]);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.upgraded']);
  });

  it('raises the client limit and the quota by the extras, and not before the confirmation', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await addClients(agencyId, 10);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(CLIENT_LIMIT);

    const quoted = await h.request(ownerId, agencyId, 'essencial', 3, 10);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(CLIENT_LIMIT);
    await h.confirm(quoted.charge_id!, 'ref-extra', quoted.amount_cents);
    expect(await h.quotaOf(agencyId)).toBe(String(30 * GIB));
    for (let n = 0; n < 3; n += 1) await h.insertClient(ownerId, agencyId);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ ...CLIENT_LIMIT, message: expect.stringContaining('The plan allows at most 13 active clients.') });
  });

  it('drops a scheduled decrease when the Owner raises before the period ends', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ pending_plan_key: 'essencial' });
    await h.subscribe(ownerId, agencyId, 'agencia');
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'agencia', pending_plan_key: null, pending_extra_clients: null, pending_extra_storage_gib: null });
  });

  it('refuses a confirmation after the subscription moved: the pending charge dies with a scheduled decrease or a cancellation', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    const raise = await h.request(ownerId, agencyId, 'agencia');
    await h.request(ownerId, agencyId, 'essencial');
    await expect(h.confirm(raise.charge_id!, 'ref-dead-1', raise.amount_cents)).rejects.toMatchObject({ code: 'A0114' });

    const again = await h.request(ownerId, agencyId, 'agencia');
    await cancel(ownerId, agencyId);
    await expect(h.confirm(again.charge_id!, 'ref-dead-2', again.amount_cents)).rejects.toMatchObject({ code: 'A0114' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional' });
  });
});

describe('lowering the plan or an extra', () => {
  it('waits for the next period: nothing changes now, nothing is charged', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    const before = await h.subscriptionOf(agencyId);

    const scheduled = await h.request(ownerId, agencyId, 'essencial');
    expect(scheduled).toMatchObject({ charge_id: null, effect: 'downgrade', monthly_cents: 9700, amount_cents: 0 });
    expect(scheduled.effective_at).toEqual(before!.current_period_end);

    expect(await h.subscriptionOf(agencyId)).toMatchObject({
      plan_key: 'profissional', extra_clients: 0, extra_storage_gib: 0,
      pending_plan_key: 'essencial', pending_extra_clients: 0, pending_extra_storage_gib: 0
    });
    expect(await h.quotaOf(agencyId)).toBe(String(100 * GIB));
    await addClients(agencyId, 25);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
    expect(await chargesOf(agencyId)).toHaveLength(1);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.downgrade_scheduled']);
  });

  it('replaces the scheduled change with the newest one', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'agencia');
    await h.request(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial', 4, 0);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ pending_plan_key: 'essencial', pending_extra_clients: 4, pending_extra_storage_gib: 0 });
  });

  it('refuses a ceiling below the active clients, counting the archived ones out', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await addClients(agencyId, 11);
    await expect(h.request(ownerId, agencyId, 'essencial')).rejects.toMatchObject({ code: 'A0111' });
    const [oldest] = await owner()('clients').where({ agency_id: agencyId }).select('id').limit(1);
    await owner()('clients').where({ id: oldest.id }).update({ status: 'archived', archived_at: new Date() });
    expect(await activeClients(agencyId)).toBe(10);
    await expect(h.request(ownerId, agencyId, 'essencial')).resolves.toMatchObject({ effect: 'downgrade' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ pending_plan_key: 'essencial' });
  });

  it('refuses a ceiling below the storage in use, and accepts one equal to it', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.seedConfirmedBytes(agencyId, 20 * GIB + 1);
    await expect(h.request(ownerId, agencyId, 'essencial')).rejects.toMatchObject({ code: 'A0117' });
    await owner()('media_assets').where({ agency_id: agencyId }).update({ confirmed_size_bytes: 20 * GIB });
    await expect(h.request(ownerId, agencyId, 'essencial')).resolves.toMatchObject({ effect: 'downgrade' });
  });

  it('counts only the confirmed storage that was not purged', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.seedConfirmedBytes(agencyId, 25 * GIB);
    await owner()('media_assets').where({ agency_id: agencyId }).update({ purged_at: new Date(), removed_at: new Date() });
    await expect(h.request(ownerId, agencyId, 'essencial')).resolves.toMatchObject({ effect: 'downgrade' });
    const used = (await owner().raw<{ rows: Array<{ bytes: string }> }>('select app_private.agency_storage_used_bytes(?::uuid) as bytes', [agencyId])).rows[0]!.bytes;
    expect(used).toBe('0');
  });

  it('refuses a change that raises one limit and lowers the other, and a change that changes nothing', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'agencia');
    await expect(h.request(ownerId, agencyId, 'profissional', 0, 250)).rejects.toMatchObject({ code: 'A0112' });
    await expect(h.request(ownerId, agencyId, 'agencia')).rejects.toMatchObject({ code: 'A0113' });
    expect(await chargesOf(agencyId)).toHaveLength(1);
  });
});

describe('canceling', () => {
  it('keeps everything until the period ends, then makes the agency read-only, and lets it subscribe again', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await cancel(ownerId, agencyId);

    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true, pending_plan_key: null });
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
    await expect(h.request(ownerId, agencyId, 'profissional')).rejects.toMatchObject({ code: 'A0110' });
    await expect(h.request(ownerId, agencyId, 'essencial', 1, 0)).rejects.toMatchObject({ code: 'A0110' });

    await advance(ownerId, agencyId);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);

    const again = await h.request(ownerId, agencyId, 'profissional');
    expect(again).toMatchObject({ effect: 'subscribe', amount_cents: 19700 });
    await h.confirm(again.charge_id!, 'ref-again', 19700);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', cancel_at_period_end: false });
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('is idempotent, and drops the scheduled decrease', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    await cancel(ownerId, agencyId);
    await cancel(ownerId, agencyId);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.downgrade_scheduled', 'subscription.canceled']);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ pending_plan_key: null });
  });

  it('has nothing to cancel in a trial or after the period', async () => {
    const trial = await h.trialAgency();
    await expect(cancel(trial.ownerId, trial.agencyId)).rejects.toMatchObject({ code: 'A0110' });

    const ended = await h.trialAgency();
    await h.subscribe(ended.ownerId, ended.agencyId, 'essencial');
    await advance(ended.ownerId, ended.agencyId);
    await expect(cancel(ended.ownerId, ended.agencyId)).rejects.toMatchObject({ code: 'A0110' });
  });

  it('stops being renewed', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await advance(ownerId, agencyId);
    expect(await dueList()).toContain(agencyId);
    await owner().raw('update public.agency_subscriptions set cancel_at_period_end = true where agency_id = ?', [agencyId]);
    expect(await dueList()).not.toContain(agencyId);
    expect(await renewalCents(agencyId)).toBeNull();
    await expect(renew(agencyId, 'ref-canceled', 9700)).rejects.toMatchObject({ code: 'A0115' });
  });
});

describe('renewing', () => {
  it('is not due a day or more before the period ends', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    expect(await renewalCents(agencyId)).toBeNull();
    expect(await dueList()).not.toContain(agencyId);
    await expect(renew(agencyId, 'ref-early', 9700)).rejects.toMatchObject({ code: 'A0115' });
    await h.setPeriod(agencyId, 29, 2);
    expect(await renewalCents(agencyId)).toBeNull();
    expect(await dueList()).not.toContain(agencyId);
    await h.setPeriod(agencyId, 29, 1);
    expect(await renewalCents(agencyId)).toBe(9700);
    expect(await dueList()).toContain(agencyId);
  });

  it('refuses a renewal that names no valid provider or no reference, and writes nothing', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    const before = await h.subscriptionOf(agencyId);
    for (const [provider, ref] of [['cortesia', 'ref-a'], ['stripe', 'ref-b'], ['simulado', ''], ['simulado', '   ']] as const) {
      await expect(renew(agencyId, ref, 9700, provider), `${provider} ${ref}`).rejects.toMatchObject({ code: 'A0114' });
    }
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
    expect((await chargesOf(agencyId)).map((row) => row.kind)).toEqual(['subscribe']);
  });

  it('expires the pending charge of a raise when the period is renewed', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    const raise = await h.request(ownerId, agencyId, 'profissional');
    await h.setPeriod(agencyId, 29, 1);
    expect(await renew(agencyId, 'ref-renews-over-raise', 9700)).toBe(true);
    expect(await owner()('subscription_charges').where({ id: raise.charge_id }).first('status')).toEqual({ status: 'expired' });
    await expect(h.confirm(raise.charge_id!, 'ref-late-raise', raise.amount_cents)).rejects.toMatchObject({ code: 'A0114' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial' });
  });

  it('starts the new period where the old one ends, charges the next period and records it once', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial', 2, 5);
    await h.setPeriod(agencyId, 29, 1);
    const before = await h.subscriptionOf(agencyId);
    const expected = 9700 + 1200 + 200;

    await expect(renew(agencyId, 'ref-renew', expected - 1)).rejects.toMatchObject({ code: 'A0114' });
    expect(await renew(agencyId, 'ref-renew', expected)).toBe(true);
    const after = await h.subscriptionOf(agencyId);
    expect(after!.current_period_start).toEqual(before!.current_period_end);
    const { rows } = await owner().raw<{ rows: Array<{ one_month: boolean }> }>(
      "select current_period_end = current_period_start + interval '1 month' as one_month from public.agency_subscriptions where agency_id = ?", [agencyId]);
    expect(rows[0]!.one_month).toBe(true);

    expect(await renew(agencyId, 'ref-renew', expected)).toBe(false);
    expect((await h.subscriptionOf(agencyId))!.current_period_end).toEqual(after!.current_period_end);
    expect((await chargesOf(agencyId)).map((row) => [row.kind, row.status, row.amount_cents])).toEqual([['subscribe', 'confirmed', 9700 + 1200 + 200], ['renewal', 'confirmed', expected]]);
    expect(await auditActions(agencyId)).toEqual(['subscription.subscribed', 'subscription.renewed']);
  });

  it('refuses a provider reference another agency already used', async () => {
    const first = await h.trialAgency();
    const second = await h.trialAgency();
    await h.subscribe(first.ownerId, first.agencyId, 'essencial');
    await h.subscribe(second.ownerId, second.agencyId, 'essencial');
    await h.setPeriod(first.agencyId, 29, 1);
    await h.setPeriod(second.agencyId, 29, 1);
    expect(await renew(first.agencyId, 'ref-shared-renewal', 9700)).toBe(true);
    const before = await h.subscriptionOf(second.agencyId);
    await expect(renew(second.agencyId, 'ref-shared-renewal', 9700)).rejects.toMatchObject({ code: 'A0114', message: expect.stringContaining('belongs to another charge') });
    expect(await h.subscriptionOf(second.agencyId)).toEqual(before);
    expect((await chargesOf(second.agencyId)).map((row) => row.kind)).toEqual(['subscribe']);
  });

  it('starts at the instant of a late renewal, not in the past', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 33, -3);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await renew(agencyId, 'ref-late', 9700);
    const { rows } = await owner().raw<{ rows: Array<{ from_now: boolean }> }>(
      'select abs(extract(epoch from now() - current_period_start)) < 30 as from_now from public.agency_subscriptions where agency_id = ?', [agencyId]);
    expect(rows[0]!.from_now).toBe(true);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
  });

  it('applies the scheduled decrease and moves the quota down', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    expect(await renewalCents(agencyId)).toBe(9700);

    await expect(renew(agencyId, 'ref-down-wrong', 19700)).rejects.toMatchObject({ code: 'A0114' });
    await renew(agencyId, 'ref-down', 9700);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', pending_plan_key: null });
    expect(await h.quotaOf(agencyId)).toBe(String(20 * GIB));
    expect((await auditActions(agencyId)).at(-1)).toBe('subscription.downgrade_applied');
    await addClients(agencyId, 10);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(CLIENT_LIMIT);
  });

  it('keeps the current plan when the usage outgrew the scheduled decrease, and says so', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    for (let n = 0; n < 12; n += 1) await h.insertClient(ownerId, agencyId);
    await h.setPeriod(agencyId, 29, 1);
    expect(await renewalCents(agencyId)).toBe(19700);

    await expect(renew(agencyId, 'ref-skip-wrong', 9700)).rejects.toMatchObject({ code: 'A0114' });
    await renew(agencyId, 'ref-skip', 19700);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
    expect(await h.quotaOf(agencyId)).toBe(String(100 * GIB));
    expect((await auditActions(agencyId)).at(-1)).toBe('subscription.downgrade_skipped');
  });

  it('keeps the current plan when the storage outgrew the scheduled decrease', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    await h.seedConfirmedBytes(agencyId, 30 * GIB);
    await h.setPeriod(agencyId, 29, 1);
    expect(await renewalCents(agencyId)).toBe(19700);
  });

  it('is not for a courtesy plan, an agency that left the paid plan, or one nobody subscribed', async () => {
    const courtesy = await h.trialAgency();
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [courtesy.agencyId]);
    expect(await renewalCents(courtesy.agencyId)).toBeNull();
    expect(await dueList()).not.toContain(courtesy.agencyId);

    const left = await h.trialAgency();
    await h.subscribe(left.ownerId, left.agencyId, 'essencial');
    await h.setPeriod(left.agencyId, 29, 0);
    await owner().raw("update public.agencies set plan = 'isenta' where id = ?", [left.agencyId]);
    expect(await renewalCents(left.agencyId)).toBeNull();
    expect(await dueList()).not.toContain(left.agencyId);
    await expect(renew(left.agencyId, 'ref-left', 9700)).rejects.toMatchObject({ code: 'A0115' });

    const none = await h.trialAgency();
    await expect(renew(none.agencyId, 'ref-none', 9700)).rejects.toMatchObject({ code: 'A0114' });
  });

  it('lists at most 500 agencies whatever number is asked', async () => {
    const { rows: created } = await owner().raw<{ rows: Array<{ id: string }> }>(
      "insert into public.agencies (name, plan) select 'Lote ' || n, 'ativo' from generate_series(1, 501) n returning id");
    const ids = created.map((row) => row.id);
    try {
      await owner().raw(
        `insert into public.agency_subscriptions (agency_id, plan_key, provider, current_period_start, current_period_end)
         select id, 'essencial', 'simulado', now() - interval '29 days', now() + interval '6 hours' from public.agencies where id = any(?::uuid[])`, [ids]);
      const rows = (await owner().raw<{ rows: unknown[] }>('select app_private.agencies_due_for_renewal(100000) as id')).rows;
      expect(rows).toHaveLength(500);
    } finally {
      await owner().raw('delete from public.agency_subscriptions where agency_id = any(?::uuid[])', [ids]);
      await owner().raw('delete from public.agencies where id = any(?::uuid[])', [ids]);
    }
  });

  it('lists at most the number asked for, oldest period first, and never a negative number', async () => {
    const a = await h.trialAgency();
    const b = await h.trialAgency();
    await h.subscribe(a.ownerId, a.agencyId, 'essencial');
    await h.subscribe(b.ownerId, b.agencyId, 'essencial');
    await h.setPeriod(a.agencyId, 430, -400);
    await h.setPeriod(b.agencyId, 31, -1);
    const limited = (await owner().raw<{ rows: Array<{ id: string }> }>('select app_private.agencies_due_for_renewal(1) as id')).rows;
    expect(limited).toEqual([{ id: a.agencyId }]);
    expect((await owner().raw<{ rows: unknown[] }>('select app_private.agencies_due_for_renewal(-5) as id')).rows).toEqual([]);
  });
});

describe('the simulated clock', () => {
  it('ends the period now without changing its length, once', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    const length = 'select (current_period_end - current_period_start)::text as length from public.agency_subscriptions where agency_id = ?';
    const lengthBefore = (await owner().raw<{ rows: Array<{ length: string }> }>(length, [agencyId])).rows[0]!.length;
    await advance(ownerId, agencyId);
    const { rows } = await owner().raw<{ rows: Array<{ ended: boolean; length: string }> }>(
      `select current_period_end <= now() as ended, (current_period_end - current_period_start)::text as length
       from public.agency_subscriptions where agency_id = ?`, [agencyId]);
    expect(rows).toEqual([{ ended: true, length: lengthBefore }]);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    await advance(ownerId, agencyId);
    expect((await auditActions(agencyId)).filter((action) => action === 'subscription.simulated_period_ended')).toHaveLength(1);
  });

  it('moves only a subscription of the simulated provider', async () => {
    const real = await h.trialAgency();
    const { charge_id: chargeId } = await h.request(real.ownerId, real.agencyId, 'essencial');
    await h.confirm(chargeId!, 'pay_9', 9700, 'asaas');
    const before = await h.subscriptionOf(real.agencyId);
    await expect(advance(real.ownerId, real.agencyId)).rejects.toMatchObject({ code: 'A0110' });
    expect(await h.subscriptionOf(real.agencyId)).toEqual(before);

    const none = await h.trialAgency();
    await expect(advance(none.ownerId, none.agencyId)).rejects.toMatchObject({ code: 'A0110' });
  });
});

describe('a courtesy plan', () => {
  it('is changed by the operation only: the Owner cannot buy, cancel or move its clock', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [agencyId]);
    await expect(h.request(ownerId, agencyId, 'profissional')).rejects.toMatchObject({ code: 'A0110' });
    await expect(cancel(ownerId, agencyId)).rejects.toMatchObject({ code: 'A0110' });
    await expect(advance(ownerId, agencyId)).rejects.toMatchObject({ code: 'A0110' });
  });

  it('can replace a paid subscription, dropping its extras and its scheduled change', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'agencia', 5, 5);
    await h.request(ownerId, agencyId, 'essencial');
    const pending = await h.request(ownerId, agencyId, 'agencia', 6, 5);
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [agencyId]);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', provider: 'cortesia', extra_clients: 0, extra_storage_gib: 0, pending_plan_key: null, cancel_at_period_end: false });
    expect(await h.quotaOf(agencyId)).toBe(String(20 * GIB));
    await expect(h.confirm(pending.charge_id!, 'ref-courtesy', pending.amount_cents)).rejects.toMatchObject({ code: 'A0114' });
  });

});

describe('the writes of an agency by its plan', () => {
  it('refuse a person\'s writes once the period ended, keep what reduces access, and give the writes back on renewal', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const colleague = await h.withRole(agencyId, 'admin');
    const email = `${randomUUID()}@subscription-lifecycle.test`;
    const productionRole = (await owner()('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
    await h.subscribe(ownerId, agencyId, 'essencial');
    const invitationId = await h.asUser(ownerId, async (t) => (await t('invitations').insert({
      agency_id: agencyId, purpose: 'collaborator_invite', email,
      role_id: productionRole,
      token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: ownerId
    }).returning('id'))[0].id as string);

    await advance(ownerId, agencyId);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
    await expect(h.asUser(ownerId, (t) => t('invitations').insert({
      agency_id: agencyId, purpose: 'collaborator_invite', email: `x-${email}`, role_id: productionRole,
      token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: ownerId
    }))).rejects.toMatchObject(READ_ONLY);
    expect(await h.asUser(ownerId, (t: Knex.Transaction) => t('invitations').where({ id: invitationId }).update({ revoked_at: new Date() }))).toBe(1);
    expect(await h.asUser(ownerId, (t) => t('agency_memberships').where({ agency_id: agencyId, user_id: colleague }).update({ status: 'removed', updated_at: new Date() }))).toBe(1);

    expect(await renew(agencyId, 'ref-back', 9700)).toBe(true);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });
});

describe('the ceiling of clients against a confirmation and a scheduled decrease', () => {
  it('makes the confirmation of a raise wait for a client being created, and then count it', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await addClients(agencyId, 9);
    const raise = await h.request(ownerId, agencyId, 'profissional');
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` });
      let settled = false;
      const waiting = h.confirm(raise.charge_id!, 'ref-race-raise', raise.amount_cents).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).resolves.toBe(true);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await activeClients(agencyId)).toBe(10);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional' });
  });

  it('makes a client being created wait for a raise being confirmed, and then count against the new ceiling', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await addClients(agencyId, 10);
    const raise = await h.request(ownerId, agencyId, 'profissional');
    const holder = await h.openTransactionAsNobody();
    try {
      await holder.raw('select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer)', [raise.charge_id, 'simulado', 'ref-race-client', raise.amount_cents]);
      let settled = false;
      const waiting = h.insertClient(ownerId, agencyId).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).resolves.toEqual(expect.any(String));
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await activeClients(agencyId)).toBe(11);
  });

  it('makes a scheduled decrease wait for a client being created, and count it', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await addClients(agencyId, 10);
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` });
      let settled = false;
      const waiting = h.request(ownerId, agencyId, 'essencial').finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject({ code: 'A0111' });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ pending_plan_key: null });
  });
});

describe('what only the server may do', () => {
  it('refuses a confirmation and a renewal made inside a person\'s transaction, the Owner\'s included', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const { charge_id: chargeId, amount_cents: amount } = await h.request(ownerId, agencyId, 'essencial');
    await expect(h.asUser(ownerId, (t) => t.raw('select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer)', [chargeId, 'simulado', 'ref-person', amount])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('not from a person') });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
    expect(await chargesOf(agencyId)).toMatchObject([{ status: 'pending' }]);

    await h.confirm(chargeId!, 'ref-server', amount);
    await h.setPeriod(agencyId, 29, 0);
    await expect(h.asUser(ownerId, (t) => t.raw('select app_private.renew_subscription(?::uuid, ?, ?, ?::integer)', [agencyId, 'simulado', 'ref-person-renew', 9700])))
      .rejects.toMatchObject({ code: '42501' });
    expect((await chargesOf(agencyId)).map((row) => row.kind)).toEqual(['subscribe']);
  });

  it('shows the next renewal to the members of the agency and to the server, and to nobody else', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    const outsider = await h.person();
    await h.subscribe(ownerId, agencyId, 'essencial', 1, 0);
    await h.setPeriod(agencyId, 29, 1);
    const cents = (userId: string | null) => run(userId,
      async (t) => (await t.raw<{ rows: Array<{ cents: number | null }> }>('select app_private.next_renewal_cents(?::uuid) as cents', [agencyId])).rows[0]!.cents);
    expect(await cents(null)).toBe(10300);
    expect(await cents(ownerId)).toBe(10300);
    expect(await cents(admin)).toBe(10300);
    expect(await cents(outsider)).toBeNull();
  });

  it('lists the agencies due for renewal to the server only', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 0);
    const list = (userId: string | null) => run(userId,
      async (t) => (await t.raw<{ rows: Array<{ id: string }> }>('select app_private.agencies_due_for_renewal(500) as id')).rows.map((row) => row.id));
    expect(await list(null)).toContain(agencyId);
    expect(await list(ownerId)).toEqual([]);
  });
});

describe('the overview the screen reads', () => {
  const overview = (userId: string | null, agencyId: string) =>
    run(userId, async (t) => (await t.raw<{ rows: Array<Record<string, unknown>> }>('select * from app_private.subscription_overview(?::uuid)', [agencyId])).rows);

  it('prices the period and the next one, gives the ceilings and the usage, to every member and no one else', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    const outsider = await h.person();
    await h.subscribe(ownerId, agencyId, 'profissional', 5, 30);
    await addClients(agencyId, 5);
    await owner().raw("update public.clients set status = 'archived', archived_at = now() where id = (select id from public.clients where agency_id = ? limit 1)", [agencyId]);
    await h.seedConfirmedBytes(agencyId, 3 * GIB);
    const expected = { monthly_cents: 23900, next_monthly_cents: 23900, client_limit: 35, storage_bytes: String(130 * GIB), used_clients: '4', used_bytes: String(3 * GIB) };
    expect(await overview(ownerId, agencyId)).toEqual([expected]);
    expect(await overview(admin, agencyId)).toEqual([expected]);
    expect(await overview(outsider, agencyId)).toEqual([]);
    expect(await overview(null, agencyId)).toEqual([]);
  });

  it('prices the next period with the scheduled change, and none after a cancellation', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional', 5, 30);
    await h.request(ownerId, agencyId, 'essencial');
    expect(await overview(ownerId, agencyId)).toMatchObject([{ monthly_cents: 23900, next_monthly_cents: 9700 }]);
    await cancel(ownerId, agencyId);
    expect(await overview(ownerId, agencyId)).toMatchObject([{ monthly_cents: 23900, next_monthly_cents: null }]);
  });

  it('charges a courtesy plan nothing', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner().raw("select app_private.grant_courtesy_subscription(?::uuid, 'agencia')", [agencyId]);
    expect(await overview(ownerId, agencyId)).toMatchObject([{ monthly_cents: 0, next_monthly_cents: null, client_limit: 60 }]);
  });

  it('has nothing to show for an agency nobody subscribed', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    expect(await overview(ownerId, agencyId)).toEqual([]);
  });
});

describe('the lock of the agency in the other operations', () => {
  // A client being created holds the lock of the agency: the operation under test has to wait for it and then see the client.
  const waitsBehindAClient = async (agencyId: string, ownerId: string, operation: () => Promise<unknown>): Promise<unknown> => {
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` });
      let settled = false;
      const waiting = operation().finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      return await waiting;
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  };

  it('makes the cancel wait for a client being created', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await waitsBehindAClient(agencyId, ownerId, () => cancel(ownerId, agencyId));
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ cancel_at_period_end: true });
  });

  it('makes the renewal wait for a client being created, and keep a plan the new client no longer fits', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.request(ownerId, agencyId, 'essencial');
    await addClients(agencyId, 10);
    await h.setPeriod(agencyId, 29, 1);
    await waitsBehindAClient(agencyId, ownerId, () => renew(agencyId, 'ref-race-renew', 19700));
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
    expect((await auditActions(agencyId)).at(-1)).toBe('subscription.downgrade_skipped');
  });

});

describe('the isolation levels', () => {
  it.each(['repeatable read', 'serializable'] as const)('refuses the raise, the confirmation and the cancel in %s, which would count past the lock', async (level) => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    const raise = await h.request(ownerId, agencyId, 'profissional');
    for (const sql of [
      ['select * from app_private.request_subscription_change(?::uuid, ?, 0, 0)', [agencyId, 'profissional']],
      ['select app_private.cancel_subscription(?::uuid)', [agencyId]],
      ['select app_private.advance_simulated_period(?::uuid)', [agencyId]],
      ['select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer)', [raise.charge_id, 'simulado', 'ref-iso', raise.amount_cents]]
    ] as const) {
      const transaction = await h.openTransactionAs(ownerId, level);
      try {
        await expect(transaction.raw(sql[0], [...sql[1]]), sql[0]).rejects.toMatchObject({ code: '40001' });
      } finally {
        await transaction.rollback();
      }
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', cancel_at_period_end: false });
  });
});

describe('the renewal in the isolation levels', () => {
  it.each(['repeatable read', 'serializable'] as const)('refuses the renewal in %s, which would count past the lock', async (level) => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    const before = await h.subscriptionOf(agencyId);
    const transaction = await h.openTransactionAsNobody(level);
    try {
      await expect(transaction.raw('select app_private.renew_subscription(?::uuid, ?, ?, ?::integer)', [agencyId, 'simulado', 'ref-iso-renew', 9700])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
  });
});

describe('the simulated clock against a confirmation', () => {
  it('makes a confirmation wait for the clock and refuse the period it ended', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'essencial');
    const raise = await h.request(ownerId, agencyId, 'profissional');
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder.raw('select app_private.advance_simulated_period(?::uuid)', [agencyId]);
      let settled = false;
      const waiting = h.confirm(raise.charge_id!, 'ref-after-clock', raise.amount_cents).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject({ code: 'A0114', message: expect.stringContaining('changed after the charge') });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial' });
  });
});

describe('the storage in use against an upload being confirmed', () => {
  // The media service confirms an upload under the lock 'media-quota:<agency>' and writes the storage in use. A change of ceiling
  // that reads the storage in use has to wait for it, whatever the other lock it holds.
  const MEDIA_LOCK = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-quota:' || ?::text, 0))";

  const behindAnUploadBeingConfirmed = async (agencyId: string, bytes: number, operation: () => Promise<unknown>): Promise<{ value?: unknown; error?: { code?: string; message?: string } }> => {
    const holder = await owner().transaction();
    try {
      await holder.raw(MEDIA_LOCK, [agencyId]);
      await h.seedConfirmedBytes(agencyId, bytes, holder);
      let settled = false;
      const waiting = operation().finally(() => { settled = true; });
      const outcome = waiting.then((value) => ({ value }), (error: { code?: string; message?: string }) => ({ error }));
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      return await outcome;
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  };

  it('makes the scheduled decrease wait, and then refuse the storage the upload brought', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.seedConfirmedBytes(agencyId, 19 * GIB);
    const outcome = await behindAnUploadBeingConfirmed(agencyId, 5 * GIB, () => h.request(ownerId, agencyId, 'essencial'));
    expect(outcome.error).toMatchObject({ code: 'A0117' });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
  });

  it('makes the first subscription wait, and then refuse a plan the upload outgrew', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedConfirmedBytes(agencyId, 15 * GIB);
    const quoted = await h.request(ownerId, agencyId, 'essencial');
    const outcome = await behindAnUploadBeingConfirmed(agencyId, 6 * GIB, () => h.confirm(quoted.charge_id!, 'ref-media-subscribe', quoted.amount_cents));
    expect(outcome.error).toMatchObject({ code: 'A0117' });
    expect(await agencyRow(agencyId)).toMatchObject({ plan: 'trial' });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
  });

  it('makes the request wait, and then count the upload for the first subscription', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedConfirmedBytes(agencyId, 15 * GIB);
    const outcome = await behindAnUploadBeingConfirmed(agencyId, 6 * GIB, () => h.request(ownerId, agencyId, 'essencial'));
    expect(outcome.error).toMatchObject({ code: 'A0117' });
    expect(await chargesOf(agencyId)).toHaveLength(0);
  });

  it('makes the renewal wait, and then keep the plan the upload outgrew the decrease of', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.subscribe(ownerId, agencyId, 'profissional');
    await h.seedConfirmedBytes(agencyId, 15 * GIB);
    await h.request(ownerId, agencyId, 'essencial');
    await h.setPeriod(agencyId, 29, 1);
    const outcome = await behindAnUploadBeingConfirmed(agencyId, 6 * GIB, () => renew(agencyId, 'ref-media-renew', 19700));
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(true);
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', pending_plan_key: null });
    expect((await auditActions(agencyId)).at(-1)).toBe('subscription.downgrade_skipped');
  });

  it('takes the upload confirmation\'s lock before the agency\'s, and never the other way round', async () => {
    const { agencyId } = await h.trialAgency();
    const upload = await owner().transaction();
    const change = await owner().transaction();
    try {
      await upload.raw(MEDIA_LOCK, [agencyId]);
      const { rows: pidRows } = await change.raw<{ rows: Array<{ pid: number }> }>('select pg_backend_pid() as pid');
      const pid = pidRows[0]!.pid;
      let settled = false;
      const waiting = change.raw('select app_private.lock_subscription_change(?::uuid)', [agencyId]).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      const { rows: held } = await owner().raw<{ rows: Array<{ held: string }> }>(
        `select count(*)::text as held from pg_locks
         where locktype = 'advisory' and granted and pid = ?
           and ((classid::bigint << 32) | objid::bigint) = pg_catalog.hashtextextended('agency_trial_limits:' || ?::text, 0)`, [pid, agencyId]);
      expect(held[0]!.held).toBe('0');
      await upload.commit();
      await waiting;
      const { rows: both } = await owner().raw<{ rows: Array<{ held: string }> }>(
        `select count(*)::text as held from pg_locks where locktype = 'advisory' and granted and pid = ?`, [pid]);
      expect(both[0]!.held).toBe('2');
    } finally {
      if (!upload.isCompleted()) await upload.rollback();
      if (!change.isCompleted()) await change.rollback();
    }
  });
});
