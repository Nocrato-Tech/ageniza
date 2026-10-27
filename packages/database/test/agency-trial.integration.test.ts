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

// A world agency has no Owner by possession; its key only has to be its own.
const expireTrial = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)') });
const runningTrial = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'trial', trial_ends_at: owner().raw("now() + interval '3 days'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)') });
const exempt = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });

const person = async (verified = true, emailOf?: string): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = emailOf ?? `${id}@agency-trial.test`;
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
    await expect(owner()('agencies').insert({ id, name: 'Outro trial', owner_user_id: creator.id, plan: 'trial', trial_ends_at: new Date(Date.now() + 1000), trial_owner_email_key: `outra-${id}` }))
      .rejects.toMatchObject({ code: '23505', constraint: 'agencies_one_trial_per_owner' });
  });

  it('holds one trial per normalized e-mail in the index itself, and a trial always carries the key', async () => {
    const creator = await person();
    const first = await createTrial(creator.id);
    const key = (await owner()('agencies').where({ id: first }).first('trial_owner_email_key')).trial_owner_email_key as string;
    expect(key).toBe(creator.email);
    const other = await person();
    const id = randomUUID();
    await expect(owner()('agencies').insert({ id, name: 'Mesmo e-mail', owner_user_id: other.id, plan: 'trial', trial_ends_at: new Date(Date.now() + 1000), trial_owner_email_key: key }))
      .rejects.toMatchObject({ code: '23505', constraint: 'agencies_one_trial_per_email_key' });
    await expect(owner()('agencies').insert({ id, name: 'Sem chave', owner_user_id: other.id, plan: 'trial', trial_ends_at: new Date(Date.now() + 1000) }))
      .rejects.toMatchObject({ code: '23514', constraint: 'agencies_trial_owner_email_key_check' });
  });

  it('normalizes the e-mail: lower case, no +alias, and no dots with one domain for Gmail', async () => {
    const key = async (email: string) => (await owner().raw<{ rows: Array<{ key: string }> }>('select app_private.trial_email_key(?) as key', [email])).rows[0]!.key;
    expect(await key(' Vitima+a1@GMAIL.com ')).toBe('vitima@gmail.com');
    expect(await key('v.i.t.i.m.a@gmail.com')).toBe('vitima@gmail.com');
    expect(await key('V.itima+x@googlemail.com')).toBe('vitima@gmail.com');
    expect(await key('Ana.Souza+loja@Empresa.com.br')).toBe('ana.souza@empresa.com.br');
    expect(await key('ana.souza@empresa.com.br')).not.toBe(await key('anasouza@empresa.com.br'));
  });

  it('refuses a trial to the aliases of an e-mail that already has one: +alias, dots and googlemail', async () => {
    const base = `vitima${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const victim = await person(true, `${base}@gmail.com`);
    await createTrial(victim.id);
    const can = (userId: string) => w.asUser(userId, async (transaction) =>
      (await transaction.raw<{ rows: Array<{ can: boolean }> }>('select app_private.can_create_trial_agency() as can')).rows[0]!.can);
    for (const alias of [`${base}+a1@gmail.com`, `${base.split('').join('.')}@gmail.com`, `${base.slice(0, 3)}.${base.slice(3)}@googlemail.com`, `${base}+x@googlemail.com`]) {
      const attacker = await person(true, alias);
      expect(await can(attacker.id), alias).toBe(false);
      await expect(createTrial(attacker.id), alias).rejects.toMatchObject({ code: 'A0094' });
    }
    expect(await owner()('agencies').where({ plan: 'trial', trial_owner_email_key: `${base}@gmail.com` })).toHaveLength(1);
    // Another address of a domain of its own is accepted: the risk is reduced, not removed (item 7).
    const otherAddress = await person(true, `${base}@outro-dominio.test`);
    await expect(createTrial(otherAddress.id)).resolves.toEqual(expect.any(String));
  });

  it('makes an alias wait for the trial being created with the same e-mail, and then refuses it', async () => {
    const base = `espera${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const first = await person(true, `${base}@gmail.com`);
    const alias = await person(true, `${base}+b@gmail.com`);
    const holder = await w.openTransactionAs(first.id);
    try {
      const { rows } = await holder.raw<{ rows: Array<{ id: string }> }>('select app_private.create_trial_agency(?) as id', ['Primeira']);
      extraAgencies.push(rows[0]!.id);
      let settled = false;
      const waiting = createTrial(alias.id).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
        const { rows: blocked } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
        if (blocked.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject({ code: 'A0094' });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  });

  it('creates one trial when two aliases of the same e-mail create at the same time', async () => {
    const base = `corrida${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const people = [await person(true, `${base}@gmail.com`), await person(true, `${base}+b@gmail.com`), await person(true, `${base}@googlemail.com`)];
    const results = await Promise.allSettled(people.map((each) => createTrial(each.id)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['A0094', 'A0094']);
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

  // One write per table, each through a path the application role holds (a grant it has today). Removing the trigger of
  // any one table turns its own case red: the write would then succeed or fail with another code.
  it.each([
    ['media_assets', async () => {
      const asset = await w.seedAsset(ids.clientA1, await w.folderOf(ids.clientA1));
      return () => w.asUser(ids.adminA, (t) => t('media_assets').where({ id: asset }).update({ updated_at: new Date() }));
    }],
    ['client_memberships', async () =>
      () => w.asUser(ids.portalA1, (t) => t('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1 }).update({ onboarding_seen_at: new Date() }))],
    ['client_brand_sections', async () =>
      () => w.asUser(ids.adminA, (t) => t('client_brand_sections').insert({ client_id: ids.clientA1, section_key: 'observations', body: 'Nova', updated_by: ids.adminA }))],
    ['client_thread_comments', async () =>
      () => w.asUser(ids.portalA1, (t) => t('client_thread_comments').insert({ client_id: ids.clientA1, thread_id: randomUUID(), author_user_id: ids.portalA1, author_side: 'client', body: 'Oi' }))],
    ['content_tasks', async () => {
      const content = await w.seedContent(ids.clientA1);
      return () => w.asUser(ids.adminA, (t) => t('content_tasks').insert({ client_id: ids.clientA1, content_id: content, title: 'Tarefa' }));
    }],
    ['story_script_scenes', async () =>
      () => w.asUser(ids.adminA, (t) => t('story_script_scenes').insert({ client_id: ids.clientA1, script_id: randomUUID(), position: 1, text: 'Cena' }))]
  ] as const)('refuses a write to %s', async (_table, prepare) => {
    const write = await prepare();
    await withExpiredAgencyA(async () => {
      await expect(write()).rejects.toMatchObject(READ_ONLY);
    });
  });

  // No grant of the application role writes these today (roles, content_media and notification_queue are written only by
  // the owner or by functions that touch other governed tables first). The trigger still has to hold the day one appears:
  // the case grants a column for one transaction, as the application role with an actor, and the transaction rolls back.
  it.each([
    ['roles', 'agency_id', () => ids.agencyA],
    ['content_media', 'client_id', () => ids.clientA1],
    ['notification_queue', 'client_id', () => ids.clientA1]
  ] as const)('refuses a write to %s even with a grant that does not exist today', async (table, column, value) => {
    await withExpiredAgencyA(async () => {
      await expect(owner().transaction(async (t) => {
        await t.raw(`grant insert (${column}) on public.${table} to ageniza_app`);
        await t.raw('set local session authorization ageniza_app');
        await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
        await t.raw(`insert into public.${table} (${column}) values (?::uuid)`, [value()]);
      })).rejects.toMatchObject(READ_ONLY);
    });
    const { rows } = await owner().raw<{ rows: Array<{ granted: boolean }> }>(`select has_column_privilege('ageniza_app', 'public.${table}', ?, 'INSERT') as granted`, [column]);
    expect(rows[0]!.granted).toBe(false);
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

  it('does not count an expired invitation as a seat', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    const expiring = await invite(creator.id, agencyId, `vence-${randomUUID()}@agency-trial.test`);
    await invite(creator.id, agencyId, `fica-${randomUUID()}@agency-trial.test`);
    await expect(invite(creator.id, agencyId, `cheio-${randomUUID()}@agency-trial.test`)).rejects.toMatchObject(COLLABORATOR_LIMIT);
    await owner()('invitations').where({ id: expiring }).update({ expires_at: new Date(Date.now() - 60_000) });
    await expect(invite(creator.id, agencyId, `vaga-${randomUUID()}@agency-trial.test`)).resolves.toEqual(expect.any(String));
  });

  it('counts the Owner by possession, without a membership, as a seat', async () => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    const admin = await person();
    const adminRole = await roleId('admin');
    await owner()('agency_memberships').insert({ agency_id: agencyId, user_id: admin.id, role_id: adminRole });
    await owner()('agency_memberships').where({ agency_id: agencyId, user_id: creator.id }).delete();
    // The Owner and the admin hold two seats: one invitation fits, a second does not.
    await invite(admin.id, agencyId, `um-${randomUUID()}@agency-trial.test`);
    await expect(invite(admin.id, agencyId, `dois-${randomUUID()}@agency-trial.test`)).rejects.toMatchObject(COLLABORATOR_LIMIT);
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

describe('the daily e-mail limit of an agency (review of #725)', () => {
  const DAILY_LIMIT = { code: 'A0095' };

  const agencyWithClient = async (plan: 'trial' | 'ativo' | 'isenta') => {
    const creator = await person();
    const agencyId = await createTrial(creator.id);
    if (plan !== 'trial') await owner()('agencies').where({ id: agencyId }).update({ plan, trial_ends_at: null });
    const clientId = await insertClient(creator.id, agencyId);
    return { creator, agencyId, clientId };
  };
  const portalInvite = (actor: string, agencyId: string, clientId: string) =>
    invite(actor, agencyId, `portal-${randomUUID()}@agency-trial.test`, 'client_invite', { client_id: clientId });
  /** Rows the owner writes as if sent earlier today (or at `at`), without going through the limit. */
  const sentBefore = async (agencyId: string, clientId: string, actor: string, count: number, at?: Date) => {
    const rows = Array.from({ length: count }, () => ({
      agency_id: agencyId, purpose: 'client_invite', client_id: clientId, email: `antes-${randomUUID()}@agency-trial.test`,
      token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: actor,
      ...(at === undefined ? {} : { created_at: at })
    }));
    await owner()('invitations').insert(rows);
  };
  const countOf = async (agencyId: string) => Number((await owner()('invitations').where({ agency_id: agencyId }).count({ n: '*' }))[0]!.n);

  it('accepts 20 e-mails a day in trial and refuses the 21st, writing nothing', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('trial');
    await sentBefore(agencyId, clientId, creator.id, 19);
    await expect(portalInvite(creator.id, agencyId, clientId)).resolves.toEqual(expect.any(String));
    await expect(portalInvite(creator.id, agencyId, clientId)).rejects.toMatchObject(DAILY_LIMIT);
    // A collaborator invitation is an e-mail too.
    await expect(invite(creator.id, agencyId, `colab-${randomUUID()}@agency-trial.test`)).rejects.toMatchObject(DAILY_LIMIT);
    expect(await countOf(agencyId)).toBe(20);
  });

  it('accepts 200 e-mails a day out of trial and refuses the 201st', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('ativo');
    await sentBefore(agencyId, clientId, creator.id, 199);
    await expect(portalInvite(creator.id, agencyId, clientId)).resolves.toEqual(expect.any(String));
    await expect(portalInvite(creator.id, agencyId, clientId)).rejects.toMatchObject(DAILY_LIMIT);
  });

  it('counts a resend, which is a new invitation row', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 2 });
    const email = `reenvio-${randomUUID()}@agency-trial.test`;
    const first = await invite(creator.id, agencyId, email, 'client_invite', { client_id: clientId });
    await w.asUser(creator.id, (t) => t('invitations').where({ id: first }).update({ revoked_at: new Date() }));
    await invite(creator.id, agencyId, email, 'client_invite', { client_id: clientId });
    await w.asUser(creator.id, (t) => t('invitations').where({ agency_id: agencyId, email }).whereNull('revoked_at').update({ revoked_at: new Date() }));
    await expect(invite(creator.id, agencyId, email, 'client_invite', { client_id: clientId })).rejects.toMatchObject(DAILY_LIMIT);
  });

  it('follows the limit the operation sets, and does not count the days before', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('trial');
    await sentBefore(agencyId, clientId, creator.id, 30, new Date(Date.now() - 2 * 86_400_000));
    // The last minute of yesterday in Brasília: inside the last 48 hours, but another day.
    const { rows } = await owner().raw<{ rows: Array<{ at: Date }> }>(
      "select (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') - interval '1 minute' as at"
    );
    await sentBefore(agencyId, clientId, creator.id, 30, rows[0]!.at);
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 1 });
    await expect(portalInvite(creator.id, agencyId, clientId)).resolves.toEqual(expect.any(String));
    await expect(portalInvite(creator.id, agencyId, clientId)).rejects.toMatchObject(DAILY_LIMIT);
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 3 });
    await expect(portalInvite(creator.id, agencyId, clientId)).resolves.toEqual(expect.any(String));
  });

  // The trigger counts against the database clock, which a test cannot move, so the sends are placed on the day of São Paulo
  // that the clock is in: `dayOffset` 0 is today there and -1 yesterday, at the given wall-clock time of São Paulo.
  const brasiliaAt = async (dayOffset: number, hours: number, minutes: number): Promise<Date> => {
    const { rows } = await owner().raw<{ rows: Array<{ at: Date }> }>(
      "select (date_trunc('day', now() at time zone 'America/Sao_Paulo') + make_interval(days => ?, hours => ?, mins => ?)) at time zone 'America/Sao_Paulo' as at",
      [dayOffset, hours, minutes]
    );
    return rows[0]!.at;
  };
  const sentAt = async (agencyId: string, clientId: string, actor: string, when: ReadonlyArray<readonly [number, number, number]>) => {
    for (const [dayOffset, hours, minutes] of when) await sentBefore(agencyId, clientId, actor, 1, await brasiliaAt(dayOffset, hours, minutes));
  };
  /** Sends one e-mail at a time until the limit refuses, and says how many went through. */
  const acceptedUntilRefused = async (actor: string, agencyId: string, clientId: string): Promise<number> => {
    for (let accepted = 0; accepted < 10; accepted += 1) {
      try {
        await portalInvite(actor, agencyId, clientId);
      } catch (error) {
        expect(error).toMatchObject(DAILY_LIMIT);
        return accepted;
      }
    }
    throw new Error('The limit never refused.');
  };

  it('counts together the sends of the whole day of São Paulo, from 00:30 to 23:30', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 3 });
    await sentAt(agencyId, clientId, creator.id, [[0, 0, 30], [0, 23, 30]]);
    // Two are counted, so exactly one place is left: a window shorter than the day would leave more.
    expect(await acceptedUntilRefused(creator.id, agencyId, clientId)).toBe(1);
  });

  it('does not count what was sent the day before in São Paulo, however close to midnight', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 2 });
    await sentAt(agencyId, clientId, creator.id, [[-1, 0, 30], [-1, 22, 30], [-1, 23, 59]]);
    await sentAt(agencyId, clientId, creator.id, [[0, 0, 30]]);
    // Only today's send counts: the three of yesterday are inside the last 48 hours and, mostly, inside the last 24.
    expect(await acceptedUntilRefused(creator.id, agencyId, clientId)).toBe(1);
  });

  it('keeps the day of São Paulo when UTC has already turned to the next one', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 3 });
    // 21:30 and 23:50 in São Paulo are 00:30 and 02:50 of the next day in UTC: still today in São Paulo, so they count
    // with the one of noon; 21:30 of yesterday is 00:30 of today in UTC, and is not today in São Paulo. Three today and one
    // yesterday: a day counted in UTC finds two before 21:00 in São Paulo and two after it, never the three.
    await sentAt(agencyId, clientId, creator.id, [[0, 12, 0], [0, 21, 30], [0, 23, 50], [-1, 21, 30]]);
    expect(await acceptedUntilRefused(creator.id, agencyId, clientId)).toBe(0);
  });

  it('is not writable by the application role', async () => {
    const { creator, agencyId } = await agencyWithClient('trial');
    await expect(w.asUser(creator.id, (t) => t('agencies').where({ id: agencyId }).update({ daily_email_limit: 1000 }))).rejects.toMatchObject({ code: '42501' });
  });

  it('makes a second e-mail wait for the one that takes the last place, and then refuses it', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 1 });
    const holder = await w.openTransactionAs(creator.id);
    try {
      await holder('invitations').insert({ agency_id: agencyId, purpose: 'client_invite', client_id: clientId, email: `h-${randomUUID()}@agency-trial.test`, token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: creator.id });
      let settled = false;
      const waiting = portalInvite(creator.id, agencyId, clientId).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
        const { rows } = await owner().raw<{ rows: unknown[] }>("select 1 from pg_locks where locktype = 'advisory' and not granted");
        if (rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject(DAILY_LIMIT);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await countOf(agencyId)).toBe(1);
  });

  it.each(['repeatable read', 'serializable'] as const)('refuses counting under %s', async (isolationLevel) => {
    const { creator, agencyId, clientId } = await agencyWithClient('isenta');
    const transaction = await w.openTransactionAs(creator.id, isolationLevel);
    try {
      await expect(transaction('invitations').insert({ agency_id: agencyId, purpose: 'client_invite', client_id: clientId, email: `rr-${randomUUID()}@agency-trial.test`, token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: creator.id }))
        .rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
  });
});
