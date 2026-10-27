import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issues #708 and #709: the plan of the agency, the trial, its limits and the read-only state after it, all in the
// database. The end of the trial is moved by the database clock (`trial_ends_at` against `now()`), never by the API's.
const w = createContentWorld('agency-trial');
const { ids } = w;

const READ_ONLY = { code: 'A0090' };
const CLIENT_LIMIT = { code: 'A0091' };
const COLLABORATOR_LIMIT = { code: 'A0092' };
const TRIAL_STORAGE_BYTES = '2147483648';

const extraUsers: string[] = [];
const extraAgencies: string[] = [];

const owner = (): Knex => w.getOwner().knex;

const expireTrial = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'") });
const runningTrial = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'trial', trial_ends_at: owner().raw("now() + interval '3 days'") });
const exempt = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'isenta', trial_ends_at: null });

const person = async (verified = true): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = `${id}@agency-trial.test`;
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `Pessoa ${id.slice(0, 8)}`, email, emailVerified: verified });
  return { id, email };
};

const createTrial = (userId: string, name = `Trial ${randomUUID().slice(0, 8)}`): Promise<string> =>
  w.asUser(userId, async (transaction) => {
    const { rows } = await transaction.raw<{ rows: Array<{ id: string }> }>('select app_private.create_trial_agency(?) as id', [name]);
    const id = rows[0]!.id;
    extraAgencies.push(id);
    return id;
  });

const roleId = async (key: string): Promise<string> =>
  (await owner()('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

const invite = (actor: string, agencyId: string, email: string, purpose: 'collaborator_invite' | 'client_invite' = 'collaborator_invite', extra: Record<string, unknown> = {}) =>
  w.asUser(actor, async (transaction) => {
    const [row] = await transaction('invitations').insert({
      agency_id: agencyId,
      purpose,
      email,
      ...(purpose === 'collaborator_invite' ? { role_id: await roleId('production') } : {}),
      token_hash: `hash-${randomUUID()}`,
      expires_at: new Date(Date.now() + 86_400_000),
      invited_by_user_id: actor,
      ...extra
    }).returning('id');
    return row.id as string;
  });

const insertClient = (actor: string, agencyId: string) =>
  w.asUser(actor, async (transaction) => {
    const [row] = await transaction('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` }).returning('id');
    return row.id as string;
  });

beforeAll(async () => {
  await w.setup();
});

afterAll(async () => {
  const knex = owner();
  if (extraAgencies.length > 0) {
    const clientIds = (await knex('clients').whereIn('agency_id', extraAgencies).select('id')).map((row) => row.id as string);
    await knex('invitations').whereIn('agency_id', extraAgencies).delete();
    await knex('media_folders').whereIn('client_id', clientIds).delete();
    await knex('clients').whereIn('id', clientIds).delete();
    await knex('agency_storage_quotas').whereIn('agency_id', extraAgencies).delete();
    await knex('agency_memberships').whereIn('agency_id', extraAgencies).delete();
    await knex('agencies').whereIn('id', extraAgencies).delete();
  }
  await knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [extraAgencies]);
  await knex('invitations').where({ agency_id: ids.agencyA }).delete();
  await knex('legal_acceptances').whereIn('user_id', extraUsers).delete();
  await knex('auth.user').whereIn('id', extraUsers).delete();
  await w.teardown();
});

describe('the plan of an agency', () => {
  it('is isenta for an agency that names none, and a trial always carries its end', async () => {
    expect(await owner()('agencies').where({ id: ids.agencyA }).first('plan', 'trial_ends_at')).toEqual({ plan: 'isenta', trial_ends_at: null });
    await expect(owner()('agencies').where({ id: ids.agencyB }).update({ plan: 'trial' })).rejects.toMatchObject({ code: '23514' });
    await expect(owner()('agencies').where({ id: ids.agencyB }).update({ plan: 'pago' })).rejects.toMatchObject({ code: '23514' });
  });

  it('is not writable by the application role', async () => {
    await expect(w.asUser(ids.ownerA, (transaction) => transaction('agencies').where({ id: ids.agencyA }).update({ plan: 'ativo' })))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('creating an agency in trial (issue #709)', () => {
  it('refuses an account whose e-mail is not verified', async () => {
    const unverified = await person(false);
    await expect(createTrial(unverified.id)).rejects.toMatchObject({ code: 'A0093' });
    expect(await owner()('agencies').where({ owner_user_id: unverified.id })).toHaveLength(0);
  });

  it('makes the actor Owner with the Admin membership, 14 days of trial and the 2 GiB quota', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id, 'Agência do Trial');
    const agency = await owner()('agencies').where({ id: agencyId }).first();
    expect(agency).toMatchObject({ name: 'Agência do Trial', status: 'active', owner_user_id: creator.id, plan: 'trial' });
    const { rows } = await owner().raw<{ rows: Array<{ days: string }> }>(
      "select round(extract(epoch from trial_ends_at - now()) / 86400) as days from public.agencies where id = ?", [agencyId]
    );
    expect(Number(rows[0]!.days)).toBe(14);
    expect(await owner()('agency_memberships').where({ agency_id: agencyId }).select('user_id', 'role_id', 'status'))
      .toEqual([{ user_id: creator.id, role_id: await roleId('admin'), status: 'active' }]);
    expect((await owner()('agency_storage_quotas').where({ agency_id: agencyId }).first('quota_bytes')).quota_bytes).toBe(TRIAL_STORAGE_BYTES);
    const audit = await owner().raw<{ rows: unknown[] }>("select 1 from audit.events where action = 'agency.created' and agency_id = ? and actor_user_id = ?", [agencyId, creator.id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('refuses a second trial for the same account, even an expired one, and accepts it once the first is ativo', async () => {
    const creator = await person();
    const first = await createTrial(creator.id);
    await expect(createTrial(creator.id)).rejects.toMatchObject({ code: 'A0094' });
    await expireTrial(first);
    await expect(createTrial(creator.id)).rejects.toMatchObject({ code: 'A0094' });
    await owner()('agencies').where({ id: first }).update({ plan: 'ativo', trial_ends_at: null });
    await expect(createTrial(creator.id)).resolves.toEqual(expect.any(String));
  });

  it('creates one trial when the same account creates two at the same time', async () => {
    const creator = await person();
    const results = await Promise.allSettled([createTrial(creator.id), createTrial(creator.id), createTrial(creator.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await owner()('agencies').where({ owner_user_id: creator.id, plan: 'trial' })).toHaveLength(1);
  });

  it('holds one trial per owner in the index itself', async () => {
    const creator = await person();
    await createTrial(creator.id);
    const id = randomUUID();
    await expect(owner()('agencies').insert({ id, name: 'Outro trial', owner_user_id: creator.id, plan: 'trial', trial_ends_at: new Date(Date.now() + 1000) }))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('answers whether the actor can create an agency with the same rule', async () => {
    const creator = await person();
    const unverified = await person(false);
    const can = (userId: string) => w.asUser(userId, async (transaction) =>
      (await transaction.raw<{ rows: Array<{ can: boolean }> }>('select app_private.can_create_trial_agency() as can')).rows[0]!.can);
    expect(await can(unverified.id)).toBe(false);
    expect(await can(creator.id)).toBe(true);
    await createTrial(creator.id);
    expect(await can(creator.id)).toBe(false);
  });
});

describe('the read-only agency after the trial (issue #708)', () => {
  const withExpiredAgencyA = async (work: () => Promise<void>): Promise<void> => {
    await expireTrial(ids.agencyA);
    try {
      await work();
    } finally {
      await exempt(ids.agencyA);
    }
  };

  it('refuses the writes of Clientes: editing the client and its brand study', async () => {
    await withExpiredAgencyA(async () => {
      await expect(w.asUser(ids.adminA, (t) => t('clients').where({ id: ids.clientA1 }).update({ name: 'Outro nome' }))).rejects.toMatchObject(READ_ONLY);
      await expect(w.asUser(ids.adminA, (t) => t('client_personas').insert({ client_id: ids.clientA1, name: 'Persona' }))).rejects.toMatchObject(READ_ONLY);
      await expect(insertClient(ids.adminA, ids.agencyA)).rejects.toMatchObject(READ_ONLY);
    });
  });

  it('refuses the writes of Colaboradores: editing a membership and inviting', async () => {
    await withExpiredAgencyA(async () => {
      await expect(w.asUser(ids.adminA, (t) => t('agency_memberships').where({ agency_id: ids.agencyA, user_id: ids.productionA }).update({ job_title: 'Diretora' })))
        .rejects.toMatchObject(READ_ONLY);
      await expect(invite(ids.adminA, ids.agencyA, `novo-${randomUUID()}@agency-trial.test`)).rejects.toMatchObject(READ_ONLY);
    });
  });

  it('refuses the writes of Conteúdo: editing a content, a story script and a media folder', async () => {
    const content = await w.seedContent(ids.clientA1);
    await withExpiredAgencyA(async () => {
      await expect(w.asUser(ids.adminA, (t) => t('contents').where({ id: content }).update({ caption: 'Nova legenda' }))).rejects.toMatchObject(READ_ONLY);
      await expect(w.asUser(ids.adminA, (t) => t('story_scripts').insert({ client_id: ids.clientA1, script_on: '2026-11-01' }))).rejects.toMatchObject(READ_ONLY);
      await expect(w.asUser(ids.adminA, (t) => t('media_folders').insert({ client_id: ids.clientA1, name: 'Nova pasta' }))).rejects.toMatchObject(READ_ONLY);
    });
    expect((await w.contentRow(content)).caption).toBe('Legenda original');
  });

  it('refuses the writes of the portal: opening a conversation and approving', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const revision = (await w.contentRow(content)).revision as number;
    await withExpiredAgencyA(async () => {
      await expect(w.asUser(ids.portalA1, (t) => t('client_threads').insert({ client_id: ids.clientA1, section_key: 'branding', opened_by: ids.portalA1, opened_side: 'client' })))
        .rejects.toMatchObject(READ_ONLY);
      await expect(w.asUser(ids.portalA1, (t) => t.raw('select app_private.approve_content(?::uuid, ?)', [content, revision]))).rejects.toMatchObject(READ_ONLY);
    });
    expect((await w.contentRow(content)).status).toBe('awaiting_approval');
  });

  it('keeps every read: the agency and the portal still see their data', async () => {
    await withExpiredAgencyA(async () => {
      expect(await w.asUser(ids.adminA, (t) => t('clients').where({ id: ids.clientA1 }).select('id'))).toHaveLength(1);
      expect(await w.asUser(ids.adminA, (t) => t('contents').where({ client_id: ids.clientA1 }).select('id'))).not.toHaveLength(0);
      expect(await w.asUser(ids.portalA1, (t) => t('clients').where({ id: ids.clientA1 }).select('id'))).toHaveLength(1);
    });
  });

  it('keeps what reduces access: removing a collaborator, removing a portal access and cancelling an invitation', async () => {
    const email = `cancelar-${randomUUID()}@agency-trial.test`;
    const invitationId = await invite(ids.adminA, ids.agencyA, email);
    const portalMembership = (await owner()('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1Second }).first('id')).id as string;
    await withExpiredAgencyA(async () => {
      expect(await w.asUser(ids.adminA, (t) => t('invitations').where({ id: invitationId }).update({ revoked_at: new Date() }))).toBe(1);
      expect(await w.asUser(ids.adminA, (t) => t('agency_memberships').where({ agency_id: ids.agencyA, user_id: ids.dualRemoved }).update({ status: 'removed', updated_at: new Date() }))).toBe(1);
      await w.asUser(ids.adminA, (t) => t.raw('select app_private.set_client_membership_status(?::uuid, ?)', [portalMembership, 'removed']));
      // The exception is the exact change: removing and editing in one statement is still a write.
      await expect(w.asUser(ids.adminA, (t) => t('agency_memberships').where({ agency_id: ids.agencyA, user_id: ids.financeA }).update({ status: 'removed', job_title: 'Saída' })))
        .rejects.toMatchObject(READ_ONLY);
      // Bringing back is not reducing access.
      await expect(w.asUser(ids.adminA, (t) => t('agency_memberships').where({ agency_id: ids.agencyA, user_id: ids.dualRemoved }).update({ status: 'active' })))
        .rejects.toMatchObject(READ_ONLY);
    });
    expect((await owner()('client_memberships').where({ id: portalMembership }).first('status')).status).toBe('removed');
    await owner()('client_memberships').where({ id: portalMembership }).update({ status: 'active' });
    await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: ids.dualRemoved }).update({ status: 'active' });
  });

  it('accepts the same writes while the trial runs and in an exempt agency', async () => {
    const content = await w.seedContent(ids.clientA1);
    await runningTrial(ids.agencyA);
    try {
      expect(await w.asUser(ids.adminA, (t) => t('contents').where({ id: content }).update({ caption: 'Durante o trial' }))).toBe(1);
    } finally {
      await exempt(ids.agencyA);
    }
    expect(await w.asUser(ids.adminA, (t) => t('contents').where({ id: content }).update({ caption: 'Isenta' }))).toBe(1);
  });

  it('makes a pending invitation invalid and not acceptable', async () => {
    const invited = await person();
    const tokenHash = `hash-${randomUUID()}`;
    await invite(ids.adminA, ids.agencyA, invited.email, 'collaborator_invite', { token_hash: tokenHash });
    const lookup = async () => (await owner().raw<{ rows: Array<{ valid: boolean }> }>('select valid from app_private.invitation_by_token_hash(?)', [tokenHash])).rows[0]!.valid;
    expect(await lookup()).toBe(true);
    await withExpiredAgencyA(async () => {
      expect(await lookup()).toBe(false);
      await expect(w.asUser(invited.id, (t) => t.raw('select * from app_private.accept_invitation(?, ?::uuid, ?, ?, false)', [tokenHash, invited.id, 'v1', 'v1'])))
        .rejects.toMatchObject({ code: 'A0001' });
    });
    expect(await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: invited.id })).toHaveLength(0);
    await owner()('invitations').where({ token_hash: tokenHash }).update({ revoked_at: new Date() });
  });

  it('stops the e-mails: a queued notification no longer holds', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const holds = async () => (await owner().raw<{ rows: Array<{ holds: boolean }> }>(
      "select app_private.notification_item_still_holds('content_awaiting_approval', ?::uuid, ?::uuid, ?::uuid) as holds",
      [ids.clientA1, ids.portalA1, content]
    )).rows[0]!.holds;
    expect(await holds()).toBe(true);
    await withExpiredAgencyA(async () => {
      expect(await holds()).toBe(false);
    });
  });
});

describe('the limits of a trial (issue #708)', () => {
  it('accepts 3 active clients, not a 4th, and does not count an archived one', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    const [first] = [await insertClient(creator.id, agencyId), await insertClient(creator.id, agencyId), await insertClient(creator.id, agencyId)];
    await expect(insertClient(creator.id, agencyId)).rejects.toMatchObject(CLIENT_LIMIT);
    await owner()('clients').where({ id: first }).update({ status: 'archived', archived_at: new Date() });
    await expect(insertClient(creator.id, agencyId)).resolves.toEqual(expect.any(String));
    // Bringing the archived one back would make a 4th.
    await expect(w.asUser(creator.id, (t) => t.raw('select app_private.reactivate_client(?::uuid)', [first]))).rejects.toMatchObject(CLIENT_LIMIT);
  });

  // The holder writes the last place and keeps its transaction open: the second writer must wait on the agency lock and
  // then count what the holder committed. Without the lock it would count before the commit and take a 4th place.
  const raceAgainstHolder = async (write: (t: Knex.Transaction) => Promise<unknown>, second: () => Promise<unknown>, code: string) => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    return { creator, agencyId, run: async () => {
      const holder = await w.openTransactionAs(creator.id);
      try {
        await write(holder);
        let settled = false;
        const waiting = second().finally(() => { settled = true; });
        waiting.catch(() => undefined);
        for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
          const { rows } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
          if (rows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(settled).toBe(false);
        await holder.commit();
        await expect(waiting).rejects.toMatchObject({ code });
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
      }
    } };
  };

  it('makes a second client wait for the one that takes the last place, and then refuses it', async () => {
    let target = '';
    let actor = '';
    const race = await raceAgainstHolder(
      (t) => t('clients').insert({ agency_id: target, name: `Cliente ${randomUUID().slice(0, 8)}` }),
      () => insertClient(actor, target),
      'A0091'
    );
    target = race.agencyId;
    actor = race.creator.id;
    await insertClient(actor, target);
    await insertClient(actor, target);
    await race.run();
    expect(await owner()('clients').where({ agency_id: target, status: 'active' })).toHaveLength(3);
  });

  it('makes a second invitation wait for the one that takes the last place, and then refuses it', async () => {
    let target = '';
    let actor = '';
    const production = await roleId('production');
    const race = await raceAgainstHolder(
      (t) => t('invitations').insert({ agency_id: target, purpose: 'collaborator_invite', email: `h-${randomUUID()}@agency-trial.test`, role_id: production, token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: actor }),
      () => invite(actor, target, `s-${randomUUID()}@agency-trial.test`),
      'A0092'
    );
    target = race.agencyId;
    actor = race.creator.id;
    await invite(actor, target, `a-${randomUUID()}@agency-trial.test`);
    await race.run();
    expect(await owner()('invitations').where({ agency_id: target, purpose: 'collaborator_invite' }).whereNull('revoked_at')).toHaveLength(2);
  });

  it('accepts one client when two are created at the same time with one place left', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    await insertClient(creator.id, agencyId);
    await insertClient(creator.id, agencyId);
    const results = await Promise.allSettled([insertClient(creator.id, agencyId), insertClient(creator.id, agencyId), insertClient(creator.id, agencyId)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['A0091', 'A0091']);
    expect(await owner()('clients').where({ agency_id: agencyId, status: 'active' })).toHaveLength(3);
  });

  it.each(['repeatable read', 'serializable'] as const)('refuses counting the limits under %s, where the count would miss what the lock holder committed', async (isolationLevel) => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    for (const write of [
      (t: Knex.Transaction) => t('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` }),
      (t: Knex.Transaction) => t('invitations').insert({ agency_id: agencyId, purpose: 'collaborator_invite', email: `${randomUUID()}@agency-trial.test`, token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: creator.id })
    ]) {
      const transaction = await w.openTransactionAs(creator.id, isolationLevel);
      try {
        await expect(write(transaction)).rejects.toMatchObject({ code: '40001' });
      } finally {
        await transaction.rollback();
      }
    }
  });

  it('counts the Owner and the pending collaborator invitations, not portal invitations nor cancelled ones', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    const client = await insertClient(creator.id, agencyId);
    const firstInvite = await invite(creator.id, agencyId, `a-${randomUUID()}@agency-trial.test`);
    await invite(creator.id, agencyId, `b-${randomUUID()}@agency-trial.test`);
    await expect(invite(creator.id, agencyId, `c-${randomUUID()}@agency-trial.test`)).rejects.toMatchObject(COLLABORATOR_LIMIT);
    await expect(invite(creator.id, agencyId, `portal-${randomUUID()}@agency-trial.test`, 'client_invite', { client_id: client })).resolves.toEqual(expect.any(String));
    await w.asUser(creator.id, (t) => t('invitations').where({ id: firstInvite }).update({ revoked_at: new Date() }));
    await expect(invite(creator.id, agencyId, `d-${randomUUID()}@agency-trial.test`)).resolves.toEqual(expect.any(String));
  });

  it('lets a pending invitation be accepted when the trial is full, and refuses bringing back a removed collaborator', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    const invited = await person();
    const tokenHash = `hash-${randomUUID()}`;
    await invite(creator.id, agencyId, invited.email, 'collaborator_invite', { token_hash: tokenHash });
    await invite(creator.id, agencyId, `outro-${randomUUID()}@agency-trial.test`);
    await w.asUser(invited.id, (t) => t.raw('select * from app_private.accept_invitation(?, ?::uuid, ?, ?, false)', [tokenHash, invited.id, 'v1', 'v1']));
    expect(await owner()('agency_memberships').where({ agency_id: agencyId, user_id: invited.id, status: 'active' })).toHaveLength(1);

    await w.asUser(creator.id, (t) => t('agency_memberships').where({ agency_id: agencyId, user_id: invited.id }).update({ status: 'removed' }));
    await invite(creator.id, agencyId, `terceiro-${randomUUID()}@agency-trial.test`);
    await expect(w.asUser(creator.id, (t) => t('agency_memberships').where({ agency_id: agencyId, user_id: invited.id }).update({ status: 'active' })))
      .rejects.toMatchObject(COLLABORATOR_LIMIT);
  });

  it('accepts one invitation when two are created at the same time with one place left', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    await invite(creator.id, agencyId, `a-${randomUUID()}@agency-trial.test`);
    const results = await Promise.allSettled([1, 2, 3].map((n) => invite(creator.id, agencyId, `${n}-${randomUUID()}@agency-trial.test`)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await owner()('invitations').where({ agency_id: agencyId, purpose: 'collaborator_invite' }).whereNull('revoked_at')).toHaveLength(2);
  });

  it('does not limit an agency out of trial', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    await owner()('agencies').where({ id: agencyId }).update({ plan: 'ativo', trial_ends_at: null });
    for (let index = 0; index < 4; index += 1) await insertClient(creator.id, agencyId);
    for (let index = 0; index < 3; index += 1) await invite(creator.id, agencyId, `${index}-${randomUUID()}@agency-trial.test`);
    expect(await owner()('clients').where({ agency_id: agencyId, status: 'active' })).toHaveLength(4);
  });
});
