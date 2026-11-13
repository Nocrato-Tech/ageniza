import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { buildBillingWorld, type BillingWorld } from './support/billing-people.js';
import { createHarness } from './support/subscriptions.js';

// Scope redesign-igual, subtask W5-S1c1 (decision 2026-11-12): a charge records that its payment was declined. `declined_at` is written only by
// `decline_subscription_charge`, which the API calls when the simulated payment answers `declined`; a declined charge is neither confirmed nor
// declined again; and a declined payment never changes the plan.
const h = createHarness('charge-declined');
const owner = () => h.owner();

const worlds: BillingWorld[] = [];

const declineIn = (transaction: Knex.Transaction, agencyId: string, chargeId: string | null): Promise<unknown> =>
  transaction.raw('select app_private.decline_subscription_charge(?::uuid, ?::uuid)', [agencyId, chargeId]);

const decline = (user: string | undefined, agencyId: string, chargeId: string | null): Promise<unknown> => {
  const work = (transaction: Knex.Transaction) => declineIn(transaction, agencyId, chargeId);
  return user === undefined ? h.asNobody(work) : h.asUser(user, work);
};

const confirmIn = (transaction: Knex.Transaction, chargeId: string, cents: number, ref = `ref-${randomUUID()}`): Promise<unknown> =>
  transaction.raw('select app_private.confirm_subscription_charge(?::uuid, ?, ?, ?::integer)', [chargeId, 'simulado', ref, cents]);

type Settled = Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
const settle = (promise: Promise<unknown>): Settled => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

const stateOf = (chargeId: string) => owner()('subscription_charges').where({ id: chargeId }).first();
const eventsOf = (agencyId: string) => owner()('audit.events').where({ agency_id: agencyId, action: 'subscription.charge_declined' }).orderBy('id');
const planOf = async (agencyId: string) => (await owner()('agencies').where({ id: agencyId }).first('plan')).plan as string;

// An agency with an open charge of the Essencial plan, asked by its Owner as the product asks.
const openCharge = async (plan = 'essencial') => {
  const { agencyId, ownerId } = await h.trialAgency();
  const requested = await h.request(ownerId, agencyId, plan);
  return { agencyId, ownerId, chargeId: requested.charge_id!, cents: requested.amount_cents };
};

const UNCHANGED = { status: 'pending', declined_at: null, confirmed_at: null, provider: null, provider_ref: null };

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  try {
    for (const world of worlds) await world.cleanUp();
  } finally {
    await h.teardown();
  }
});

describe('who declines a charge (acceptance a)', () => {
  it('lets the Owner decline an open charge of the agency: the instant comes from the database and the state stays pending', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    const clock = async () => (await owner().raw<{ rows: Array<{ at: Date }> }>('select clock_timestamp() as at')).rows[0]!.at;
    const first = await clock();
    await decline(ownerId, agencyId, chargeId);
    const last = await clock();

    const row = (await stateOf(chargeId))!;
    expect(row).toMatchObject({ status: 'pending', confirmed_at: null, provider: null, provider_ref: null });
    expect(row.declined_at.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect(row.declined_at.getTime()).toBeLessThanOrEqual(last.getTime());
    expect(await planOf(agencyId)).toBe('trial');
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
  });

  it('refuses everybody else with the same words, whatever claim they have on the agency, and changes nothing', async () => {
    const world = await buildBillingWorld(h);
    worlds.push(world);
    const requested = await h.request(world.ownerId, world.agencyId, 'essencial');
    const chargeId = requested.charge_id!;

    for (const { who, user } of world.denied) {
      await expect(decline(user, world.agencyId, chargeId), who).rejects.toMatchObject({ code: '42501' });
    }
    expect(await stateOf(chargeId)).toMatchObject(UNCHANGED);
    expect(await eventsOf(world.agencyId)).toEqual([]);

    // The Owner of the agency declines the same charge: what stopped the others was the person, not a spent charge.
    await decline(world.ownerId, world.agencyId, chargeId);
    expect((await stateOf(chargeId))!.declined_at).toBeInstanceOf(Date);
  });

  it('keeps one agency\'s charge out of another Owner\'s hands, whichever agency they name, and answers a missing charge the same way', async () => {
    const mine = await openCharge();
    const theirs = await h.trialAgency();

    await expect(decline(theirs.ownerId, mine.agencyId, mine.chargeId)).rejects.toMatchObject({ code: '42501' });
    await expect(decline(theirs.ownerId, theirs.agencyId, mine.chargeId)).rejects.toMatchObject({ code: 'A0125' });
    await expect(decline(mine.ownerId, theirs.agencyId, mine.chargeId)).rejects.toMatchObject({ code: '42501' });
    await expect(decline(mine.ownerId, mine.agencyId, randomUUID())).rejects.toMatchObject({ code: 'A0125' });
    await expect(decline(mine.ownerId, mine.agencyId, null)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(mine.chargeId)).toMatchObject(UNCHANGED);
    expect(await eventsOf(mine.agencyId)).toEqual([]);
    expect(await eventsOf(theirs.agencyId)).toEqual([]);

    const theirCharge = (await h.request(theirs.ownerId, theirs.agencyId, 'essencial')).charge_id!;
    await decline(theirs.ownerId, theirs.agencyId, theirCharge);
    expect((await stateOf(theirCharge))!.declined_at).toBeInstanceOf(Date);
    expect(await stateOf(mine.chargeId)).toMatchObject(UNCHANGED);
  });

  it('turns a person without the permission away before it says anything about the charge', async () => {
    const { agencyId, chargeId } = await openCharge();
    const stranger = await h.person();
    for (const id of [chargeId, randomUUID()]) {
      await expect(decline(stranger, agencyId, id)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('runs in READ COMMITTED only, like every writer of the charges', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    for (const level of ['repeatable read', 'serializable'] as const) {
      const transaction = await h.openTransactionAs(ownerId, level);
      try {
        await expect(declineIn(transaction, agencyId, chargeId), level).rejects.toMatchObject({ code: '40001' });
      } finally {
        await transaction.rollback();
      }
    }
    expect(await stateOf(chargeId)).toMatchObject(UNCHANGED);
  });
});

describe('the application role cannot write the instant (acceptance b)', () => {
  const COLUMN_PRIVILEGES = `
    select has_column_privilege('ageniza_app', 'public.subscription_charges', 'declined_at', 'SELECT') as can_select,
           has_column_privilege('ageniza_app', 'public.subscription_charges', 'declined_at', 'INSERT') as can_insert,
           has_column_privilege('ageniza_app', 'public.subscription_charges', 'declined_at', 'UPDATE') as can_update,
           has_column_privilege('ageniza_app', 'public.subscription_charges', 'declined_at', 'REFERENCES') as can_reference
  `;

  it('can read the column, and has no privilege to write or reference it, on the column or on the table', async () => {
    const { rows } = await owner().raw<{ rows: Array<Record<string, boolean>> }>(COLUMN_PRIVILEGES);
    expect(rows[0]).toEqual({ can_select: true, can_insert: false, can_update: false, can_reference: false });
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const { rows: table } = await owner().raw<{ rows: Array<{ granted: boolean }> }>("select has_table_privilege('ageniza_app', 'public.subscription_charges', ?) as granted", [privilege]);
      expect(table[0]!.granted, `table ${privilege}`).toBe(false);
    }
  });

  it('hands the column to the application role alone, as a SELECT and nothing else: nothing to PUBLIC', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ grantee: string; privilege_type: string }> }>(`
      select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee, acl.privilege_type
      from pg_attribute a, aclexplode(a.attacl) acl
      where a.attrelid = 'public.subscription_charges'::regclass and a.attname = 'declined_at'
    `);
    expect(rows).toEqual([{ grantee: 'ageniza_app', privilege_type: 'SELECT' }]);
  });

  it('refuses a real INSERT and UPDATE of the column, by the Owner and by nobody bound, by privilege and not by a policy, and keeps the row', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    const insert = (t: Knex.Transaction) => t('subscription_charges').insert({
      agency_id: agencyId, kind: 'subscribe', plan_key: 'essencial', extra_clients: 0, extra_storage_gib: 0, amount_cents: 9700,
      expires_at: new Date(Date.now() + 60_000), declined_at: new Date()
    });
    // The one column, alone: it passes the privilege check when the column is granted, and then fails for what it lacks instead.
    const instantAlone = (t: Knex.Transaction) => t('subscription_charges').insert({ declined_at: new Date() });
    const stamp = (t: Knex.Transaction) => t('subscription_charges').where({ id: chargeId }).update({ declined_at: new Date() });
    const clear = (t: Knex.Transaction) => t('subscription_charges').where({ id: chargeId }).update({ declined_at: null });
    const attempts: Array<[string, (transaction: Knex.Transaction) => Promise<unknown>]> = [['insert', insert], ['insert of the instant alone', instantAlone], ['stamp', stamp], ['clear', clear]];
    for (const [name, attempt] of attempts) {
      await expect(h.asUser(ownerId, attempt), `Owner ${name}`).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table subscription_charges') });
      await expect(h.asNobody(attempt), `nobody ${name}`).rejects.toMatchObject({ code: '42501' });
    }
    expect(await stateOf(chargeId)).toMatchObject(UNCHANGED);

    await decline(ownerId, agencyId, chargeId);
    const declined = (await stateOf(chargeId))!.declined_at as Date;
    await expect(h.asUser(ownerId, clear), 'Owner clears a decline').rejects.toMatchObject({ code: '42501' });
    expect((await stateOf(chargeId))!.declined_at).toEqual(declined);
    expect(await owner()('subscription_charges').where({ agency_id: agencyId })).toHaveLength(1);
  });

  it('shows the instant to the Owner of the agency, through the policy, and to nobody else', async () => {
    const mine = await openCharge();
    const theirs = await h.trialAgency();
    await decline(mine.ownerId, mine.agencyId, mine.chargeId);
    const read = (user: string) => h.asUser(user, (t) => t('subscription_charges').where({ id: mine.chargeId }).select('declined_at'));
    expect(await read(mine.ownerId)).toEqual([{ declined_at: (await stateOf(mine.chargeId))!.declined_at }]);
    expect(await read(theirs.ownerId)).toEqual([]);
    expect(await h.asNobody((t) => t('subscription_charges').where({ id: mine.chargeId }).select('declined_at'))).toEqual([]);
  });

  it('keeps the writer closed to PUBLIC, open to the application role, a definer with a fixed search_path, and the only one of its name', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ proname: string; public_exec: boolean; app_exec: boolean; definer: boolean; fixed_path: boolean; arguments: string; result: string }> }>(`
      select p.proname, has_function_privilege('public', p.oid, 'execute') as public_exec, has_function_privilege('ageniza_app', p.oid, 'execute') as app_exec,
             p.prosecdef as definer, coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path,
             pg_get_function_identity_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as result
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname like '%decline%' and n.nspname in ('public', 'app_private')
    `);
    expect(rows).toEqual([{
      proname: 'decline_subscription_charge', public_exec: false, app_exec: true, definer: true, fixed_path: true,
      arguments: 'p_agency_id uuid, p_charge_id uuid', result: 'void'
    }]);
  });
});

describe('what can be declined and what cannot (acceptance c)', () => {
  it('refuses a charge that was confirmed, with A0125, and the charge stays as it was', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const paid = await h.subscribe(ownerId, agencyId, 'essencial');
    const before = await stateOf(paid.charge_id!);
    await expect(decline(ownerId, agencyId, paid.charge_id)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(paid.charge_id!)).toEqual(before);
    expect(before).toMatchObject({ status: 'confirmed', declined_at: null });
    expect(await eventsOf(agencyId)).toEqual([]);
    expect(await planOf(agencyId)).toBe('ativo');
  });

  it('refuses a charge a newer request replaced, with A0125, and still takes the newer one', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const replaced = (await h.request(ownerId, agencyId, 'essencial')).charge_id!;
    const newer = (await h.request(ownerId, agencyId, 'profissional')).charge_id!;
    expect(await stateOf(replaced)).toMatchObject({ status: 'expired', declined_at: null });

    await expect(decline(ownerId, agencyId, replaced)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(replaced)).toMatchObject({ status: 'expired', declined_at: null });
    expect(await eventsOf(agencyId)).toEqual([]);

    await decline(ownerId, agencyId, newer);
    expect((await stateOf(newer))!.declined_at).toBeInstanceOf(Date);
  });

  it('refuses a pending charge whose time ran out, with A0125: it is expired even while its row still says pending', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    await owner().raw("update public.subscription_charges set expires_at = now() - interval '1 second' where id = ?", [chargeId]);
    await expect(decline(ownerId, agencyId, chargeId)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(chargeId)).toMatchObject({ status: 'pending', declined_at: null });
    expect(await eventsOf(agencyId)).toEqual([]);
  });

  it('refuses a second decline of the same charge, with A0125, and keeps the instant and the single event of the first', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    await decline(ownerId, agencyId, chargeId);
    const first = (await stateOf(chargeId))!;
    expect(first).toMatchObject({ status: 'pending' });

    await expect(decline(ownerId, agencyId, chargeId)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(chargeId)).toEqual(first);
    expect(await eventsOf(agencyId)).toHaveLength(1);
  });

  it('keeps the decline when a newer request replaces the charge, and refuses to decline that charge again', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    await decline(ownerId, agencyId, chargeId);
    const declinedAt = (await stateOf(chargeId))!.declined_at as Date;

    const newer = (await h.request(ownerId, agencyId, 'essencial')).charge_id!;
    expect(await stateOf(chargeId)).toMatchObject({ status: 'expired', declined_at: declinedAt });
    await expect(decline(ownerId, agencyId, chargeId)).rejects.toMatchObject({ code: 'A0125' });
    expect(await stateOf(newer)).toMatchObject(UNCHANGED);
    expect(await eventsOf(agencyId)).toHaveLength(1);
  });

  it('refuses to confirm a declined charge, with the answer of a charge that is not open, and changes nothing', async () => {
    const declined = await openCharge();
    const control = await openCharge();
    await decline(declined.ownerId, declined.agencyId, declined.chargeId);
    const before = (await stateOf(declined.chargeId))!;

    await expect(h.confirm(declined.chargeId, 'ref-after-decline', declined.cents)).rejects.toMatchObject({ code: 'A0114', message: expect.stringContaining('The charge is not open for confirmation.') });
    expect(await stateOf(declined.chargeId)).toEqual(before);
    expect(await h.subscriptionOf(declined.agencyId)).toBeUndefined();
    expect(await planOf(declined.agencyId)).toBe('trial');

    // The same charge, of the same plan and the same amount, confirms when nobody declined it: only the decline stopped the first one.
    expect(control.cents).toBe(declined.cents);
    expect(await h.confirm(control.chargeId, 'ref-control', control.cents)).toBe(true);
    expect(await planOf(control.agencyId)).toBe('ativo');
  });

  it('keeps a declined charge out of the plan even when the confirmation comes again with the same reference', async () => {
    const { agencyId, ownerId, chargeId, cents } = await openCharge();
    await decline(ownerId, agencyId, chargeId);
    for (const ref of ['ref-1', 'ref-1', 'ref-2']) {
      await expect(h.confirm(chargeId, ref, cents)).rejects.toMatchObject({ code: 'A0114' });
    }
    expect(await stateOf(chargeId)).toMatchObject({ status: 'pending', confirmed_at: null, provider_ref: null });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
  });

  describe('the table keeps a confirmed charge and a declined one apart, whoever writes', () => {
    const row = (agencyId: string, extra: Record<string, unknown>) => ({
      agency_id: agencyId, kind: 'subscribe', plan_key: 'essencial', extra_clients: 0, extra_storage_gib: 0, amount_cents: 9700,
      expires_at: new Date(Date.now() + 1_800_000), ...extra
    });
    const confirmedColumns = () => ({
      status: 'confirmed', provider: 'simulado', provider_ref: `ref-${randomUUID()}`, period_start: new Date(), period_end: new Date(Date.now() + 86_400_000), confirmed_at: new Date()
    });

    it('refuses an INSERT of a confirmed charge that carries the instant, and an UPDATE that gives it to one', async () => {
      const { agencyId } = await h.trialAgency();
      await expect(owner()('subscription_charges').insert(row(agencyId, { ...confirmedColumns(), declined_at: new Date() })))
        .rejects.toMatchObject({ code: '23514', constraint: 'subscription_charges_declined_check' });

      const [paid] = await owner()('subscription_charges').insert(row(agencyId, confirmedColumns())).returning('id');
      await expect(owner()('subscription_charges').where({ id: paid.id }).update({ declined_at: new Date() }))
        .rejects.toMatchObject({ code: '23514', constraint: 'subscription_charges_declined_check' });
      expect((await stateOf(paid.id))!.declined_at).toBeNull();
    });

    it('refuses to confirm a charge by an UPDATE once it carries the instant', async () => {
      const { agencyId } = await h.trialAgency();
      const [declined] = await owner()('subscription_charges').insert(row(agencyId, { declined_at: new Date() })).returning('id');
      await expect(owner()('subscription_charges').where({ id: declined.id }).update(confirmedColumns()))
        .rejects.toMatchObject({ code: '23514' });
      expect(await stateOf(declined.id)).toMatchObject({ status: 'pending', confirmed_at: null });
    });

    it('takes the instant on a pending charge and on an expired one, which is how a declined charge ends once it is replaced', async () => {
      const { agencyId } = await h.trialAgency();
      const [pending] = await owner()('subscription_charges').insert(row(agencyId, { declined_at: new Date() })).returning('id');
      await owner()('subscription_charges').where({ id: pending.id }).update({ status: 'expired' });
      expect(await stateOf(pending.id)).toMatchObject({ status: 'expired' });
      expect((await stateOf(pending.id))!.declined_at).toBeInstanceOf(Date);
    });
  });
});

describe('a decline and a confirmation of the same charge at the same time (acceptance d)', () => {
  it('lets the confirmation win when it came first: the decline waits for it and then finds a charge that is no longer open', async () => {
    const { agencyId, ownerId, chargeId, cents } = await openCharge();
    const confirming = await h.openTransactionAsNobody();
    const confirmingPid = await backendPid(confirming);
    let declining: Settled | undefined;
    try {
      await confirmIn(confirming, chargeId, cents);
      declining = settle(decline(ownerId, agencyId, chargeId));
      await waitForBackendsBlockedBy(owner(), confirmingPid, { blockedStatement: '%decline_subscription_charge%' });
    } finally {
      await confirming.commit();
    }

    expect(await declining).toMatchObject({ ok: false, error: { code: 'A0125' } });
    expect(await stateOf(chargeId)).toMatchObject({ status: 'confirmed', declined_at: null });
    expect(await eventsOf(agencyId)).toEqual([]);
    expect(await planOf(agencyId)).toBe('ativo');
  });

  it('lets the decline win when it came first: the confirmation waits for it and then finds a charge that is not open', async () => {
    const { agencyId, ownerId, chargeId, cents } = await openCharge();
    const declining = await h.openTransactionAs(ownerId);
    const decliningPid = await backendPid(declining);
    let confirming: Settled | undefined;
    try {
      await declineIn(declining, agencyId, chargeId);
      confirming = settle(h.confirm(chargeId, 'ref-race', cents));
      await waitForBackendsBlockedBy(owner(), decliningPid, { blockedStatement: '%confirm_subscription_charge%' });
    } finally {
      await declining.commit();
    }

    expect(await confirming).toMatchObject({ ok: false, error: { code: 'A0114', message: expect.stringContaining('The charge is not open for confirmation.') } });
    expect(await stateOf(chargeId)).toMatchObject({ status: 'pending', confirmed_at: null, provider_ref: null });
    expect((await stateOf(chargeId))!.declined_at).toBeInstanceOf(Date);
    expect(await eventsOf(agencyId)).toHaveLength(1);
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
    expect(await planOf(agencyId)).toBe('trial');
  });

  it('lets one of two declines at the same time win, and refuses the other, with one event and the instant of the winner', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    const first = await h.openTransactionAs(ownerId);
    const firstPid = await backendPid(first);
    let second: Settled | undefined;
    try {
      await declineIn(first, agencyId, chargeId);
      second = settle(h.asUser(ownerId, (transaction) => declineIn(transaction, agencyId, chargeId)));
      await waitForBackendsBlockedBy(owner(), firstPid, { blockedStatement: '%decline_subscription_charge%' });
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ ok: false, error: { code: 'A0125' } });
    expect(await eventsOf(agencyId)).toHaveLength(1);
    expect((await stateOf(chargeId))!.declined_at).toBeInstanceOf(Date);
  });

  it('waits for whoever holds the lock of the agency, takes no other, and writes nothing while it waits', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    const other = await h.trialAgency();
    const LOCK = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || ?::text, 0))";
    const holder = await h.openTransactionAsNobody();
    const holderPid = await backendPid(holder);
    let declining: Settled | undefined;
    try {
      await holder.raw(LOCK, [agencyId]);
      declining = settle(decline(ownerId, agencyId, chargeId));
      await waitForBackendsBlockedBy(owner(), holderPid, { blockedStatement: '%decline_subscription_charge%' });
      expect(await stateOf(chargeId)).toMatchObject(UNCHANGED);
    } finally {
      await holder.commit();
    }
    expect(await declining).toMatchObject({ ok: true });
    expect((await stateOf(chargeId))!.declined_at).toBeInstanceOf(Date);

    // The lock is the agency's: somebody holding another agency's lock keeps nobody waiting.
    const otherCharge = (await h.request(other.ownerId, other.agencyId, 'essencial')).charge_id!;
    const unrelated = await h.openTransactionAsNobody();
    try {
      await unrelated.raw(LOCK, [agencyId]);
      await decline(other.ownerId, other.agencyId, otherCharge);
    } finally {
      await unrelated.commit();
    }
    expect((await stateOf(otherCharge))!.declined_at).toBeInstanceOf(Date);
  });
});

describe('the audit of a decline (acceptance e)', () => {
  it('records one event per decline with the actor, the agency and the charge as the target, and nothing of the card or the provider', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    await decline(ownerId, agencyId, chargeId);

    const rows = await eventsOf(agencyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'subscription.charge_declined', actor_user_id: ownerId, agency_id: agencyId, target_type: 'subscription_charge', target_id: chargeId, request_id: null });
    // The table of events has no column that could carry a value: what it holds is the five fields above, and the rest is the id and the time.
    const { rows: columns } = await owner().raw<{ rows: Array<{ column_name: string }> }>(
      "select column_name from information_schema.columns where table_schema = 'audit' and table_name = 'events' order by column_name"
    );
    expect(columns.map((column) => column.column_name)).toEqual(['action', 'actor_user_id', 'agency_id', 'id', 'occurred_at', 'request_id', 'target_id', 'target_type']);
    expect(await stateOf(chargeId)).toMatchObject({ provider: null, provider_ref: null });
  });

  it('records the actor from the transaction: the Owner who declines is the one in the event, even when the agency changed hands', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    const newOwner = await h.person();
    await owner()('agencies').where({ id: agencyId }).update({ owner_user_id: newOwner });
    await expect(decline(ownerId, agencyId, chargeId)).rejects.toMatchObject({ code: '42501' });
    await decline(newOwner, agencyId, chargeId);
    expect((await eventsOf(agencyId)).map((event) => event.actor_user_id)).toEqual([newOwner]);
  });

  it('records nothing for a refused decline, and the event goes with the instant when the transaction is rolled back', async () => {
    const { agencyId, ownerId, chargeId } = await openCharge();
    await expect(decline(ownerId, agencyId, randomUUID())).rejects.toMatchObject({ code: 'A0125' });
    expect(await eventsOf(agencyId)).toEqual([]);

    const transaction = await h.openTransactionAs(ownerId);
    await declineIn(transaction, agencyId, chargeId);
    await transaction.rollback();
    expect(await eventsOf(agencyId)).toEqual([]);
    expect(await stateOf(chargeId)).toMatchObject(UNCHANGED);
  });
});
