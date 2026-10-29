import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, GIB } from './support/subscriptions.js';

// Issue #771 (epic #770): what a subscription does to an agency in the database, with the subscription written as the
// schema owner would write it. How a subscription is asked for, confirmed, renewed and canceled is the next PR's (#775).
const h = createHarness('subscription-limits');
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
const grantCourtesy = (agencyId: string, plan: string) => owner().raw('select app_private.grant_courtesy_subscription(?::uuid, ?)', [agencyId, plan]);

const productionRole = async (): Promise<string> =>
  (await owner()('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
const invite = async (ownerId: string, agencyId: string, roleId: string): Promise<void> => {
  await h.asUser(ownerId, (t) => t('invitations').insert({
    agency_id: agencyId, purpose: 'collaborator_invite', email: `${randomUUID()}@subscription-limits.test`, role_id: roleId,
    token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: ownerId
  }));
};

// Waits for a backend blocked on an advisory lock, as the trial's race tests do.
const waitForBlockedLock = async (isSettled: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !isSettled(); attempt += 1) {
    const { rows } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

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

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('a courtesy plan', () => {
  it('puts the agency in a paid plan without charging, with its limits and quota and no end', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await grantCourtesy(agencyId, 'profissional');
    expect(await agencyRow(agencyId)).toEqual({ plan: 'ativo', trial_ends_at: null });
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'profissional', provider: 'cortesia', current_period_end: null, extra_clients: 0 });
    expect(await h.quotaOf(agencyId)).toBe(String(100 * GIB));
    expect(await chargesOf(agencyId)).toHaveLength(0);
    expect(await h.acceptsWrites(agencyId)).toBe(true);
    await addClients(agencyId, 30);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ ...CLIENT_LIMIT, message: expect.stringContaining('The plan allows at most 30 active clients.') });
    expect(await auditActions(agencyId)).toEqual(['subscription.courtesy_granted']);
  });

  it('can replace a paid subscription, dropping its extras, its scheduled change and its pending charge', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'agencia', { extraClients: 5, extraGib: 5 });
    await owner().raw("update public.agency_subscriptions set pending_plan_key = 'essencial', pending_extra_clients = 0, pending_extra_storage_gib = 0, cancel_at_period_end = true where agency_id = ?", [agencyId]);
    const pending = await h.seedCharge(agencyId, ownerId, 'pending');
    await grantCourtesy(agencyId, 'essencial');
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', provider: 'cortesia', extra_clients: 0, extra_storage_gib: 0, pending_plan_key: null, cancel_at_period_end: false, current_period_end: null });
    expect(await h.quotaOf(agencyId)).toBe(String(20 * GIB));
    expect(await owner()('subscription_charges').where({ id: pending }).first('status')).toEqual({ status: 'expired' });
  });

  it('refuses a plan that does not exist and an agency that does not exist', async () => {
    const { agencyId } = await h.trialAgency();
    await expect(grantCourtesy(agencyId, 'inexistente')).rejects.toMatchObject({ code: 'A0116' });
    await expect(grantCourtesy(randomUUID(), 'essencial')).rejects.toMatchObject({ code: 'A0110' });
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
  });

  it('refuses a caller that does not bypass RLS even when the privilege is handed over by mistake', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner().raw('grant execute on function app_private.grant_courtesy_subscription(uuid, text) to ageniza_app');
    try {
      await expect(h.asUser(ownerId, (t) => t.raw("select app_private.grant_courtesy_subscription(?::uuid, 'agencia')", [agencyId])))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('Only the operation grants a courtesy plan.') });
    } finally {
      await owner().raw('revoke execute on function app_private.grant_courtesy_subscription(uuid, text) from ageniza_app');
    }
    expect(await h.subscriptionOf(agencyId)).toBeUndefined();
  });

  it('makes the courtesy wait for a client being created', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await waitsBehindAClient(agencyId, ownerId, () => grantCourtesy(agencyId, 'essencial'));
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ provider: 'cortesia' });
  });
});

describe('the writes of an agency by its plan', () => {
  it('accept or refuse by plan and by period, with the database clock', async () => {
    const trial = await h.trialAgency();
    expect(await h.acceptsWrites(trial.agencyId)).toBe(true);
    await owner().raw("update public.agencies set trial_ends_at = now() - interval '1 second' where id = ?", [trial.agencyId]);
    expect(await h.acceptsWrites(trial.agencyId)).toBe(false);

    const exempt = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'isenta', trial_ends_at = null where id = ?", [exempt.agencyId]);
    expect(await h.acceptsWrites(exempt.agencyId)).toBe(true);

    const legacy = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'ativo', trial_ends_at = null where id = ?", [legacy.agencyId]);
    expect(await h.acceptsWrites(legacy.agencyId)).toBe(true);

    const paid = await h.trialAgency();
    await h.seedSubscription(paid.agencyId, 'essencial');
    expect(await h.acceptsWrites(paid.agencyId)).toBe(true);
    // The owner's tolerance of 2026-10-29: three days of writes after the period ended, then read-only (see subscription-grace).
    await h.setPeriod(paid.agencyId, 31, 0);
    expect(await h.acceptsWrites(paid.agencyId)).toBe(true);
    await h.endPeriod(paid.agencyId, 3 * 86400 + 3600);
    expect(await h.acceptsWrites(paid.agencyId)).toBe(false);
    await h.setPeriod(paid.agencyId, 29, 1);
    expect(await h.acceptsWrites(paid.agencyId)).toBe(true);

    const courtesy = await h.trialAgency();
    await grantCourtesy(courtesy.agencyId, 'essencial');
    expect(await h.acceptsWrites(courtesy.agencyId)).toBe(true);

    const unknown = (await owner().raw<{ rows: Array<{ accepts: boolean }> }>('select app_private.agency_accepts_writes(?::uuid) as accepts', [randomUUID()])).rows[0]!.accepts;
    expect(unknown).toBe(false);
  });

  it('refuse a person\'s writes once the period ended, keep what reduces access, and give the writes back when the period is renewed', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const colleague = await h.withRole(agencyId, 'admin');
    const role = await productionRole();
    await h.seedSubscription(agencyId, 'essencial');
    await invite(ownerId, agencyId, role);
    const invitationId = (await owner()('invitations').where({ agency_id: agencyId }).first('id')).id as string;

    await h.endPeriod(agencyId, 3 * 86400 + 3600);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject(READ_ONLY);
    await expect(invite(ownerId, agencyId, role)).rejects.toMatchObject(READ_ONLY);
    expect(await h.asUser(ownerId, (t: Knex.Transaction) => t('invitations').where({ id: invitationId }).update({ revoked_at: new Date() }))).toBe(1);
    expect(await h.asUser(ownerId, (t) => t('agency_memberships').where({ agency_id: agencyId, user_id: colleague }).update({ status: 'removed', updated_at: new Date() }))).toBe(1);

    await h.setPeriod(agencyId, 0, 30);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('give an agency in a paid plan no ceiling of collaborators, where the trial stops at 3', async () => {
    const trial = await h.trialAgency();
    const paid = await h.trialAgency();
    await h.seedSubscription(paid.agencyId, 'essencial');
    const role = await productionRole();
    for (let n = 0; n < 6; n += 1) await invite(paid.ownerId, paid.agencyId, role);
    expect(await owner()('invitations').where({ agency_id: paid.agencyId }).count('* as n').first()).toMatchObject({ n: '6' });

    let sent = 0;
    await expect((async () => {
      for (let n = 0; n < 6; n += 1) { await invite(trial.ownerId, trial.agencyId, role); sent += 1; }
    })()).rejects.toMatchObject({ code: 'A0092' });
    expect(sent).toBeLessThanOrEqual(3);
  });

  it('give an agency in a paid plan the daily e-mail limit of the other agencies, and the trial its own', async () => {
    const trial = await h.trialAgency();
    const paid = await h.trialAgency();
    await h.seedSubscription(paid.agencyId, 'essencial');
    const limit = async (agencyId: string) =>
      (await owner().raw<{ rows: Array<{ n: number }> }>('select app_private.agency_daily_email_limit(?::uuid) as n', [agencyId])).rows[0]!.n;
    expect(await limit(trial.agencyId)).toBe(20);
    expect(await limit(paid.agencyId)).toBe(200);
  });
});

describe('the ceiling of clients', () => {
  const limitOf = async (agencyId: string): Promise<number | null> =>
    (await owner().raw<{ rows: Array<{ limit: number | null }> }>('select app_private.agency_client_limit(?::uuid) as "limit"', [agencyId])).rows[0]!.limit;

  it('is 3 in a trial, the plan\'s plus the extras in a paid plan, and none for the exempt, the legacy and the unknown', async () => {
    const { agencyId } = await h.trialAgency();
    expect(await limitOf(agencyId)).toBe(3);
    await h.seedSubscription(agencyId, 'profissional', { extraClients: 4 });
    expect(await limitOf(agencyId)).toBe(34);
    await owner().raw("update public.agencies set plan = 'isenta' where id = ?", [agencyId]);
    expect(await limitOf(agencyId)).toBeNull();
    await owner().raw("update public.agencies set plan = 'ativo' where id = ?", [agencyId]);
    expect(await limitOf(agencyId)).toBe(34);
    await owner().raw('delete from public.agency_subscriptions where agency_id = ?', [agencyId]);
    expect(await limitOf(agencyId)).toBeNull();
    expect(await limitOf(randomUUID())).toBeNull();
  });

  it('stops at the plan\'s, counts the archived out, and counts a reactivated client again', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    await addClients(agencyId, 9);
    const tenth = await h.insertClient(ownerId, agencyId);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ ...CLIENT_LIMIT, message: expect.stringContaining('The plan allows at most 10 active clients.') });

    await owner()('clients').where({ id: tenth }).update({ status: 'archived', archived_at: new Date() });
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
    await expect(h.asUser(ownerId, (t) => t.raw('select app_private.reactivate_client(?::uuid)', [tenth]))).rejects.toMatchObject(CLIENT_LIMIT);
    expect(await activeClients(agencyId)).toBe(10);
  });

  it('adds the extras to the plan\'s ceiling', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial', { extraClients: 2 });
    await addClients(agencyId, 11);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ ...CLIENT_LIMIT, message: expect.stringContaining('The plan allows at most 12 active clients.') });
  });

  it('keeps the trial\'s own message and its ceiling of 3', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await addClients(agencyId, 3);
    await expect(h.insertClient(ownerId, agencyId)).rejects.toMatchObject({ ...CLIENT_LIMIT, message: expect.stringContaining('The trial allows at most 3 active clients.') });
  });

  it('is no ceiling for an agency whose plan the operation granted without a subscription', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'ativo', trial_ends_at = null where id = ?", [agencyId]);
    await addClients(agencyId, 12);
    await expect(h.insertClient(ownerId, agencyId)).resolves.toEqual(expect.any(String));
  });

  it('lets the operation seed clients past the ceiling, as it does in a trial', async () => {
    const { agencyId } = await h.trialAgency();
    await addClients(agencyId, 5);
    expect(await activeClients(agencyId)).toBe(5);
    await h.seedSubscription(agencyId, 'essencial');
    await addClients(agencyId, 20);
    expect(await activeClients(agencyId)).toBe(25);
  });

  it('takes no lock and counts nothing for an agency without a ceiling, in any isolation level', async () => {
    const exempt = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'isenta', trial_ends_at = null where id = ?", [exempt.agencyId]);
    const legacy = await h.trialAgency();
    await owner().raw("update public.agencies set plan = 'ativo', trial_ends_at = null where id = ?", [legacy.agencyId]);
    for (const { agencyId, ownerId } of [exempt, legacy]) {
      const holder = await h.openTransactionAs(ownerId);
      try {
        await holder('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` });
        // The holder is still open: a lock of the agency would keep this insert waiting past the timer.
        const second = h.insertClient(ownerId, agencyId).then(() => 'inserted');
        const timer = new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 1500));
        expect(await Promise.race([second, timer])).toBe('inserted');
      } finally {
        await holder.rollback();
      }
      const repeatable = await h.openTransactionAs(ownerId, 'repeatable read');
      try {
        await expect(repeatable('clients').insert({ agency_id: agencyId, name: 'Cliente' })).resolves.toBeDefined();
      } finally {
        await repeatable.rollback();
      }
    }
  });

  it.each(['trial', 'paid'] as const)('creates the client of a writer who waited while the plan of a %s agency became exempt', async (kind) => {
    // H (the operation) holds the lock of the agency and moves the agency to the exempt plan; A is already queued for it.
    // After H commits, A reads a ceiling that is null: it must create the client, not refuse it with a ceiling of zero.
    const { agencyId, ownerId } = await h.trialAgency();
    if (kind === 'paid') await h.seedSubscription(agencyId, 'essencial');
    await addClients(agencyId, 1);
    const holder = await owner().transaction();
    try {
      await holder.raw("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || ?::text, 0))", [agencyId]);
      await holder.raw("update public.agencies set plan = 'isenta', trial_ends_at = null where id = ?", [agencyId]);
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
    expect(await activeClients(agencyId)).toBe(2);
    expect(await agencyRow(agencyId)).toMatchObject({ plan: 'isenta' });
  });

  it('makes the second writer wait for the one who takes the last place, and then refuses it', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    await addClients(agencyId, 9);
    const holder = await h.openTransactionAs(ownerId);
    try {
      await holder('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` });
      let settled = false;
      const waiting = h.insertClient(ownerId, agencyId).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBlockedLock(() => settled);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject(CLIENT_LIMIT);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await activeClients(agencyId)).toBe(10);
  });
});

describe('the isolation levels', () => {
  it.each(['repeatable read', 'serializable'] as const)('refuses to create a client of a paid agency in %s, which would count past the lock', async (level) => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    const transaction = await h.openTransactionAs(ownerId, level);
    try {
      await expect(transaction('clients').insert({ agency_id: agencyId, name: 'Cliente' })).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    expect(await activeClients(agencyId)).toBe(0);
  });
});

describe('the storage quota that follows the plan', () => {
  it('is the plan\'s bytes plus the extras, written with the terms', async () => {
    const { agencyId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'profissional', { extraGib: 11 });
    expect(await h.quotaOf(agencyId)).toBe(String(111 * GIB));
    await h.seedSubscription(agencyId, 'agencia');
    expect(await h.quotaOf(agencyId)).toBe(String(300 * GIB));
  });

  it('counts only the agency\'s own storage, whatever another agency holds', async () => {
    const other = await h.trialAgency();
    await h.seedConfirmedBytes(other.agencyId, 5 * GIB);
    const { agencyId } = await h.trialAgency();
    const used = async (id: string) => (await owner().raw<{ rows: Array<{ bytes: string }> }>('select app_private.agency_storage_used_bytes(?::uuid) as bytes', [id])).rows[0]!.bytes;
    expect(await used(agencyId)).toBe('0');
    await h.seedConfirmedBytes(agencyId, 2 * GIB);
    expect(await used(agencyId)).toBe(String(2 * GIB));
    expect(await used(other.agencyId)).toBe(String(5 * GIB));
  });

  it('does not count an upload that was never confirmed', async () => {
    const { agencyId } = await h.trialAgency();
    await h.seedConfirmedBytes(agencyId, GIB);
    await owner()('media_assets').where({ agency_id: agencyId }).update({ status: 'pending' });
    const used = (await owner().raw<{ rows: Array<{ bytes: string }> }>('select app_private.agency_storage_used_bytes(?::uuid) as bytes', [agencyId])).rows[0]!.bytes;
    expect(used).toBe('0');
  });

  it('counts only the confirmed storage that was not purged', async () => {
    const { agencyId } = await h.trialAgency();
    const used = async () => (await owner().raw<{ rows: Array<{ bytes: string }> }>('select app_private.agency_storage_used_bytes(?::uuid) as bytes', [agencyId])).rows[0]!.bytes;
    expect(await used()).toBe('0');
    await h.seedConfirmedBytes(agencyId, 3 * GIB);
    expect(await used()).toBe(String(3 * GIB));
    await owner()('media_assets').where({ agency_id: agencyId }).update({ purged_at: new Date(), removed_at: new Date() });
    expect(await used()).toBe('0');
  });
});
