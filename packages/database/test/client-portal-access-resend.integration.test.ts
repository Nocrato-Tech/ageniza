import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';

// Decision 2026-10-27, "acessos pendentes ... podem ser reenviados e removidos": the welcome e-mail goes again to an access nobody
// has entered, and an old portal invitation becomes the access of its address. Both go through a function of the database, which
// asks the permission, the plan of the agency, the daily limit and the state of the row by itself. Every attack runs as
// `ageniza_app` with the actor of a real person; the owner only prepares the world and reads what was left.
const w = createContentWorld('client-portal-access-resend');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

let worker: DatabaseClient;
const extraUsers: string[] = [];
const extraClients: string[] = [];
const extraAgencies: string[] = [];

const owner = (): Knex => w.getOwner().knex;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
  await w.archiveClient(ids.clientArchived);
});

afterAll(async () => {
  try {
    const knex = owner();
    await knex('client_memberships').whereIn('client_id', extraClients).delete();
    await knex('invitations').whereIn('client_id', extraClients).delete();
    await knex('audit.events').whereIn('agency_id', [ids.agencyA, ids.agencyB, ...extraAgencies]).delete();
    await knex('clients').whereIn('id', extraClients).delete();
    await knex('invitations').whereIn('agency_id', [ids.agencyA, ids.agencyB, ...extraAgencies]).delete();
    await knex('agency_memberships').whereIn('agency_id', extraAgencies).delete();
    await knex('agencies').whereIn('id', extraAgencies).update({ owner_user_id: null });
    await knex('agencies').whereIn('id', extraAgencies).delete();
    await knex('client_memberships').whereIn('user_id', extraUsers).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

const newUser = async (): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = `${id}@portal-resend.test`;
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `User ${id.slice(0, 8)}`, email, emailVerified: true });
  return { id, email };
};
const freshEmail = (): string => `${randomUUID()}@portal-address.test`;
const freshClient = async (agencyId: string = ids.agencyA): Promise<string> => {
  const id = randomUUID();
  extraClients.push(id);
  await owner()('clients').insert({ id, agency_id: agencyId, name: `Reenvio ${id}` });
  return id;
};

const call = <T = Record<string, unknown>>(user: string, statement: string, ...bindings: unknown[]): Promise<T[]> =>
  w.asUser(user, async (transaction) => (await transaction.raw<{ rows: T[] }>(statement, bindings as never[])).rows);

interface AddResult { access_id: string; outcome: 'created' | 'reactivated' | 'already_active'; unlinked_user_id: string | null }
const addAs = async (user: string, clientId: string, email: string): Promise<AddResult> =>
  (await call<AddResult>(user, 'select * from app_private.add_client_portal_access(?::uuid, ?)', clientId, email))[0]!;
const removeAs = (user: string, accessId: string): Promise<unknown[]> =>
  call(user, 'select * from app_private.remove_client_portal_access(?::uuid)', accessId);
const resendAs = async (user: string, accessId: string): Promise<string> =>
  (await call<{ access_id: string }>(user, 'select * from app_private.resend_client_portal_access(?::uuid)', accessId))[0]!.access_id;

interface ConvertResult { access_id: string; outcome: AddResult['outcome']; unlinked_user_id: string | null; invitation_revoked: boolean }
const convertAs = async (user: string, clientId: string, invitationId: string): Promise<ConvertResult> =>
  (await call<ConvertResult>(user, 'select * from app_private.convert_client_portal_invitation(?::uuid, ?::uuid)', clientId, invitationId))[0]!;

const invite = async (clientId: string, email: string, extra: Record<string, unknown> = {}): Promise<{ id: string; tokenHash: string }> => {
  const id = randomUUID();
  const tokenHash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await owner()('invitations').insert({
    id, agency_id: ids.agencyA, purpose: 'client_invite', email, client_id: clientId, token_hash: tokenHash,
    expires_at: new Date(Date.now() + 7 * 86_400_000), ...extra
  });
  return { id, tokenHash };
};
const invitationOf = (id: string): Promise<{ used_at: Date | null; revoked_at: Date | null }> =>
  owner()('invitations').where({ id }).first('used_at', 'revoked_at') as Promise<{ used_at: Date | null; revoked_at: Date | null }>;

type AccessRow = { id: string; status: string; generation: number; user_id: string | null; first_entered_at: Date | null; updated_at: Date };
const accessById = (id: string): Promise<AccessRow> => owner()('client_portal_accesses').where({ id }).first() as Promise<AccessRow>;
const accessByEmail = (clientId: string, email: string): Promise<AccessRow | undefined> =>
  owner()('client_portal_accesses').where({ client_id: clientId, email }).first() as Promise<AccessRow | undefined>;
const countAccesses = async (clientId: string): Promise<number> =>
  Number((await owner()('client_portal_accesses').where({ client_id: clientId }).count<Array<{ count: string }>>('* as count'))[0]!.count);
const eventCount = async (action: string, targetId: string): Promise<number> =>
  Number((await owner()('audit.events').where({ action, target_id: targetId }).count<Array<{ count: string }>>('* as count'))[0]!.count);
/** The cooldown reads the clock of the events; a test that is not about it moves them out of the minute. */
const ageEvents = (targetId: string, seconds = 300): Promise<number> =>
  owner()('audit.events').where({ target_id: targetId }).update({ occurred_at: owner().raw(`now() - interval '${seconds} seconds'`) });

const REFUSED = { code: 'A0020' };
const READ_ONLY = { code: 'A0090' };
const DAILY_LIMIT = { code: 'A0095' };
const NOTHING_TO_RESEND = { code: 'A0097' };
const TOO_SOON = { code: 'A0099' };

const expire = (agencyId: string): Promise<number> => owner()('agencies').where({ id: agencyId }).update({
  plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
});
const renew = (agencyId: string): Promise<number> =>
  owner()('agencies').where({ id: agencyId }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
const whileReadOnly = async (work: () => Promise<void>): Promise<void> => {
  await expire(ids.agencyA);
  try { await work(); } finally { await renew(ids.agencyA); }
};

const limitedAgency = async (limit: number): Promise<{ agencyId: string; admin: string; client: string }> => {
  const admin = await newUser();
  const agencyId = randomUUID();
  extraAgencies.push(agencyId);
  await owner()('agencies').insert({ id: agencyId, name: `Limite ${agencyId}`, owner_user_id: admin.id, daily_email_limit: limit });
  const role = await owner()('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
  await owner()('agency_memberships').insert({ agency_id: agencyId, user_id: admin.id, role_id: role.id });
  const client = randomUUID();
  extraClients.push(client);
  await owner()('clients').insert({ id: client, agency_id: agencyId, name: `Limite ${client}` });
  return { agencyId, admin: admin.id, client };
};

// ---- the welcome e-mail again ------------------------------------------------------------------------------------------

describe('resend_client_portal_access: the welcome e-mail goes again to an access nobody has entered', () => {
  it('writes one event with the actor and changes nothing in the access', async () => {
    const client = await freshClient();
    const added = await addAs(ids.adminA, client, freshEmail());
    await ageEvents(added.access_id);
    const before = await accessById(added.access_id);

    expect(await resendAs(ids.adminA, added.access_id)).toBe(added.access_id);

    expect(await accessById(added.access_id)).toEqual(before);
    const events = await owner()('audit.events').where({ action: 'client_member.resent', target_id: added.access_id }).select('actor_user_id', 'agency_id', 'target_type');
    expect(events).toEqual([{ actor_user_id: ids.adminA, agency_id: ids.agencyA, target_type: 'client_portal_access' }]);
  });

  it('keeps the generation, so the approval links of the access stay valid', async () => {
    const client = await freshClient();
    const added = await addAs(ids.adminA, client, freshEmail());
    await ageEvents(added.access_id);
    await resendAs(ids.adminA, added.access_id);
    expect((await accessById(added.access_id)).generation).toBe(1);
  });

  it('resends to an account that is linked but has not entered the portal of this client', async () => {
    const client = await freshClient();
    const account = await newUser();
    const added = await addAs(ids.adminA, client, account.email);
    await call(account.id, 'select app_private.link_client_portal_accesses()');
    expect(await accessById(added.access_id)).toMatchObject({ user_id: account.id, first_entered_at: null });
    await ageEvents(added.access_id);
    expect(await resendAs(ids.adminA, added.access_id)).toBe(added.access_id);
  });

  it('refuses a person who already entered, and writes nothing', async () => {
    const client = await freshClient();
    const account = await newUser();
    const added = await addAs(ids.adminA, client, account.email);
    await call(account.id, 'select app_private.link_client_portal_accesses()');
    await call(account.id, 'select app_private.mark_client_portal_entered(?::uuid)', client);
    expect((await accessById(added.access_id)).first_entered_at).toBeInstanceOf(Date);
    await ageEvents(added.access_id);
    await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(NOTHING_TO_RESEND);
    expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
  });

  it('still resends to an access that keeps its first entry but lost its account: the list says "ainda não entrou" for it', async () => {
    const client = await freshClient();
    const account = await newUser();
    const oldEmail = account.email;
    await owner()('client_memberships').insert({ client_id: client, user_id: account.id });
    const old = (await owner()('client_portal_accesses').where({ client_id: client, user_id: account.id }).first('id'))!;
    await removeAs(ids.adminA, old.id);
    const newEmail = freshEmail();
    await owner()('auth.user').where({ id: account.id }).update({ email: newEmail });
    await addAs(ids.adminA, client, newEmail);
    // The link lets go of the removed row of the same account, which keeps the date of its first entry.
    expect(Number((await call<{ linked: number }>(account.id, 'select app_private.link_client_portal_accesses() as linked'))[0]!.linked)).toBe(1);
    await addAs(ids.adminA, client, oldEmail);
    expect(await accessById(old.id)).toMatchObject({ status: 'active', user_id: null });
    expect((await accessById(old.id)).first_entered_at).toBeInstanceOf(Date);
    await ageEvents(old.id);

    expect(await resendAs(ids.adminA, old.id)).toBe(old.id);
  });

  it('refuses a removed access, and writes nothing', async () => {
    const client = await freshClient();
    const added = await addAs(ids.adminA, client, freshEmail());
    await removeAs(ids.adminA, added.access_id);
    await ageEvents(added.access_id);
    await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(NOTHING_TO_RESEND);
    expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
  });

  it('answers a client that is archived, an access that does not exist and a malformed one the same way', async () => {
    const archivedAccess = randomUUID();
    await owner()('client_portal_accesses').insert({ id: archivedAccess, client_id: ids.clientArchived, email: freshEmail() });
    await expect(resendAs(ids.adminA, archivedAccess)).rejects.toMatchObject(REFUSED);
    await expect(resendAs(ids.adminA, randomUUID())).rejects.toMatchObject(REFUSED);
    expect(await eventCount('client_member.resent', archivedAccess)).toBe(0);
  });

  describe('who may', () => {
    it('asks cliente.convidar_usuario: a role with only that permission resends, one with only cliente.remover_usuario does not', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(added.access_id);
      const inviter = await w.personWith('cliente.convidar_usuario');
      const remover = await w.personWith('cliente.remover_usuario');
      const canceller = await w.personWith('convite.cancelar');

      for (const refused of [remover, canceller]) {
        await expect(resendAs(refused, added.access_id), refused).rejects.toMatchObject(REFUSED);
      }
      expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
      expect(await resendAs(inviter, added.access_id)).toBe(added.access_id);
    });

    it('does not resend for the admin of another agency, a portal person or someone with no role', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(added.access_id);
      for (const stranger of [ids.adminB, ids.portalA1, ids.crossDual]) {
        await expect(resendAs(stranger, added.access_id), stranger).rejects.toMatchObject(REFUSED);
      }
      expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
    });
  });

  describe('the plan of the agency', () => {
    it('refuses a read-only agency, because a resend widens reach, and writes nothing', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(added.access_id);
      await whileReadOnly(async () => {
        await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(READ_ONLY);
      });
      expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
      expect(await resendAs(ids.adminA, added.access_id)).toBe(added.access_id);
    });

    it('spends one place of the daily limit per resend, in the budget of the welcomes, and refuses the one past it', async () => {
      const { admin, client } = await limitedAgency(2);
      const added = await addAs(admin, client, freshEmail());
      await ageEvents(added.access_id);
      expect(await resendAs(admin, added.access_id)).toBe(added.access_id);
      await ageEvents(added.access_id);
      await expect(resendAs(admin, added.access_id)).rejects.toMatchObject(DAILY_LIMIT);
      expect(await eventCount('client_member.resent', added.access_id)).toBe(1);
      // The new address goes past it too, in the same budget.
      await expect(addAs(admin, client, freshEmail())).rejects.toMatchObject(DAILY_LIMIT);
    });

    it('counts the resend in the number of e-mails of the day', async () => {
      const { agencyId, admin, client } = await limitedAgency(50);
      const today = async (): Promise<number> =>
        Number((await owner().raw<{ rows: Array<{ n: string }> }>('select app_private.agency_emails_today(?::uuid)::text as n', [agencyId])).rows[0]!.n);
      const added = await addAs(admin, client, freshEmail());
      expect(await today()).toBe(1);
      await ageEvents(added.access_id);
      await resendAs(admin, added.access_id);
      expect(await today()).toBe(2);
    });

    it('lets only one of two resends through when one place is left, in two real transactions', async () => {
      const { admin, client } = await limitedAgency(3);
      const first = await addAs(admin, client, freshEmail());
      const second = await addAs(admin, client, freshEmail());
      await ageEvents(first.access_id);
      await ageEvents(second.access_id);
      const results = await Promise.allSettled([resendAs(admin, first.access_id), resendAs(admin, second.access_id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(refused?.reason).toMatchObject(DAILY_LIMIT);
      expect(await eventCount('client_member.resent', first.access_id) + await eventCount('client_member.resent', second.access_id)).toBe(1);
    });
  });

  describe('one resend per minute for the same access (proposal, pending the owner)', () => {
    it('refuses a resend right after the adding, and spends nothing', async () => {
      const { admin, client } = await limitedAgency(2);
      const added = await addAs(admin, client, freshEmail());
      await expect(resendAs(admin, added.access_id)).rejects.toMatchObject(TOO_SOON);
      expect(await eventCount('client_member.resent', added.access_id)).toBe(0);
      // The refusal took no place of the day: one is still free.
      await ageEvents(added.access_id);
      expect(await resendAs(admin, added.access_id)).toBe(added.access_id);
    });

    it('refuses a resend right after another resend, and lets it through once the minute is over', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(added.access_id);
      await resendAs(ids.adminA, added.access_id);
      await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(TOO_SOON);
      await ageEvents(added.access_id, 59);
      await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(TOO_SOON);
      await ageEvents(added.access_id, 61);
      expect(await resendAs(ids.adminA, added.access_id)).toBe(added.access_id);
      expect(await eventCount('client_member.resent', added.access_id)).toBe(2);
    });

    it('refuses a resend right after the address was added back, which is its own event', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await removeAs(ids.adminA, added.access_id);
      await ageEvents(added.access_id);
      const readded = await addAs(ids.adminA, client, (await accessById(added.access_id) as unknown as { email: string }).email);
      expect(readded).toMatchObject({ access_id: added.access_id, outcome: 'reactivated' });
      expect(await eventCount('client_member.readded', added.access_id)).toBe(1);
      await expect(resendAs(ids.adminA, added.access_id)).rejects.toMatchObject(TOO_SOON);
      await ageEvents(added.access_id);
      expect(await resendAs(ids.adminA, added.access_id)).toBe(added.access_id);
    });

    it('reads the minute through the agency first, so it uses events_agency_action_occurred_idx and does not scan audit.events under the lock', async () => {
      const definition = await owner().raw<{ rows: Array<{ source: string }> }>(
        "select pg_get_functiondef('app_private.resend_client_portal_access(uuid)'::regprocedure) as source"
      );
      const source = definition.rows[0]!.source.replace(/\s+/g, ' ');
      expect(source).toContain("from audit.events event where event.agency_id = v_client.agency_id and event.target_type = 'client_portal_access'");
      const index = await owner().raw<{ rows: Array<{ definition: string }> }>(
        "select pg_get_indexdef(indexrelid) as definition from pg_index where indexrelid = 'audit.events_agency_action_occurred_idx'::regclass"
      );
      expect(index.rows[0]!.definition).toContain('(agency_id, action, occurred_at)');
    });

    it('counts per access: the minute of one person does not hold the resend of another', async () => {
      const client = await freshClient();
      const first = await addAs(ids.adminA, client, freshEmail());
      const second = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(second.access_id);
      await expect(resendAs(ids.adminA, first.access_id)).rejects.toMatchObject(TOO_SOON);
      expect(await resendAs(ids.adminA, second.access_id)).toBe(second.access_id);
    });

    it('lets one of two simultaneous resends of the same access through', async () => {
      const client = await freshClient();
      const added = await addAs(ids.adminA, client, freshEmail());
      await ageEvents(added.access_id);
      const results = await Promise.allSettled([resendAs(ids.adminA, added.access_id), resendAs(ids.adminA, added.access_id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((result): result is PromiseRejectedResult => result.status === 'rejected'))?.reason).toMatchObject(TOO_SOON);
      expect(await eventCount('client_member.resent', added.access_id)).toBe(1);
    });
  });

  it('is not callable by the public, and is by the application role only', async () => {
    const grants = await owner().raw<{ rows: Array<{ fn: string; app: boolean; pub: boolean }> }>(`
      select p.proname as fn,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app,
             coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false) as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('resend_client_portal_access', 'convert_client_portal_invitation')
      order by p.proname
    `);
    expect(grants.rows).toEqual([
      { fn: 'convert_client_portal_invitation', app: true, pub: false },
      { fn: 'resend_client_portal_access', app: true, pub: false }
    ]);
  });
});

// ---- the old invitation becomes the access ------------------------------------------------------------------------------

describe('convert_client_portal_invitation: the old portal invitation becomes the access of its address', () => {
  it('gives the access, revokes the invitation and writes both events, in one call', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const old = await invite(client, email);

    const result = await convertAs(ids.adminA, client, old.id);

    expect(result).toMatchObject({ outcome: 'created', unlinked_user_id: null, invitation_revoked: true });
    expect(await accessByEmail(client, email)).toMatchObject({ id: result.access_id, status: 'active', user_id: null });
    expect((await invitationOf(old.id)).revoked_at).toBeInstanceOf(Date);
    expect(await eventCount('client_member.added', result.access_id)).toBe(1);
    expect(await eventCount('invitation.revoked', old.id)).toBe(1);
    const revoked = await owner()('audit.events').where({ action: 'invitation.revoked', target_id: old.id }).first('actor_user_id', 'agency_id', 'target_type');
    expect(revoked).toEqual({ actor_user_id: ids.adminA, agency_id: ids.agencyA, target_type: 'invitation' });
  });

  it('kills the old link: accepting the revoked invitation is refused, and the access it gave stays the one of the conversion', async () => {
    const client = await freshClient();
    const account = await newUser();
    const old = await invite(client, account.email);
    const result = await convertAs(ids.adminA, client, old.id);

    await expect(call(account.id, 'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', old.tokenHash, account.id))
      .rejects.toMatchObject({ code: 'A0001' });
    expect(await countAccesses(client)).toBe(1);
    expect((await accessByEmail(client, account.email))!.id).toBe(result.access_id);
  });

  it('spends one place of the daily limit, exactly as Adicionar pessoa', async () => {
    const { agencyId, admin, client } = await limitedAgency(2);
    const old = await owner()('invitations').insert({
      agency_id: agencyId, purpose: 'client_invite', email: freshEmail(), client_id: client, token_hash: `hash-${randomUUID()}`,
      expires_at: new Date(Date.now() + 86_400_000)
    }).returning('id');
    const today = async (): Promise<number> =>
      Number((await owner().raw<{ rows: Array<{ n: string }> }>('select app_private.agency_emails_today(?::uuid)::text as n', [agencyId])).rows[0]!.n);
    // The invitation counted when it was created; the conversion is the welcome e-mail of the new access.
    expect(await today()).toBe(1);
    await convertAs(admin, client, old[0].id);
    expect(await today()).toBe(2);
    await expect(addAs(admin, client, freshEmail())).rejects.toMatchObject(DAILY_LIMIT);
  });

  it('refuses past the daily limit and leaves the invitation pending and no access', async () => {
    const { agencyId, admin, client } = await limitedAgency(1);
    await addAs(admin, client, freshEmail());
    const email = freshEmail();
    const old = await owner()('invitations').insert({
      agency_id: agencyId, purpose: 'client_invite', email, client_id: client, token_hash: `hash-${randomUUID()}`,
      expires_at: new Date(Date.now() + 86_400_000)
    }).returning('id');
    await expect(convertAs(admin, client, old[0].id)).rejects.toMatchObject(DAILY_LIMIT);
    expect(await invitationOf(old[0].id)).toEqual({ used_at: null, revoked_at: null });
    expect(await accessByEmail(client, email)).toBeUndefined();
  });

  it('refuses a read-only agency and leaves the invitation pending and no access', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const old = await invite(client, email);
    await whileReadOnly(async () => {
      await expect(convertAs(ids.adminA, client, old.id)).rejects.toMatchObject(READ_ONLY);
    });
    expect(await invitationOf(old.id)).toEqual({ used_at: null, revoked_at: null });
    expect(await accessByEmail(client, email)).toBeUndefined();
  });

  it('does not change anything when the address already has an active access: the invitation stays for the agency to cancel', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const added = await addAs(ids.adminA, client, email);
    const old = await invite(client, email);
    const before = await accessById(added.access_id);
    const eventsBefore = await owner()('audit.events').where({ agency_id: ids.agencyA }).count<Array<{ count: string }>>('* as count');

    const result = await convertAs(ids.adminA, client, old.id);

    expect(result).toMatchObject({ access_id: added.access_id, outcome: 'already_active', invitation_revoked: false });
    expect(await invitationOf(old.id)).toEqual({ used_at: null, revoked_at: null });
    expect(await accessById(added.access_id)).toEqual(before);
    expect(await owner()('audit.events').where({ agency_id: ids.agencyA }).count<Array<{ count: string }>>('* as count')).toEqual(eventsBefore);
  });

  it('brings back a removed access of the same address and revokes the invitation', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const added = await addAs(ids.adminA, client, email);
    await removeAs(ids.adminA, added.access_id);
    // Remover revokes the pending invitations of the address, so this one is put there by the owner, as if it had come later.
    const old = await invite(client, email);

    const result = await convertAs(ids.adminA, client, old.id);

    expect(result).toMatchObject({ access_id: added.access_id, outcome: 'reactivated', invitation_revoked: true });
    expect((await accessById(added.access_id)).status).toBe('active');
    expect((await invitationOf(old.id)).revoked_at).toBeInstanceOf(Date);
    expect(await eventCount('client_member.readded', added.access_id)).toBe(1);
  });

  it('refuses an invitation that is not pending, and writes nothing', async () => {
    const client = await freshClient();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['used', { used_at: new Date() }],
      ['revoked', { revoked_at: new Date() }],
      ['expired', { expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 86_400_000) }]
    ];
    for (const [label, extra] of cases) {
      const email = freshEmail();
      const old = await invite(client, email, extra);
      await expect(convertAs(ids.adminA, client, old.id), label).rejects.toMatchObject(NOTHING_TO_RESEND);
      expect(await accessByEmail(client, email), label).toBeUndefined();
    }
  });

  it('answers as an absent one for an invitation that is not a portal invitation of this client', async () => {
    const client = await freshClient();
    const other = await freshClient();
    const email = freshEmail();
    const ofOtherClient = await invite(other, email);
    const collaborator = randomUUID();
    await owner()('invitations').insert({
      id: collaborator, agency_id: ids.agencyA, purpose: 'collaborator_invite', email: freshEmail(), role_id: (await owner()('roles').whereNull('agency_id').where({ key: 'admin' }).first('id')).id,
      token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000)
    });

    await expect(convertAs(ids.adminA, client, ofOtherClient.id)).rejects.toMatchObject(REFUSED);
    await expect(convertAs(ids.adminA, client, collaborator)).rejects.toMatchObject(REFUSED);
    await expect(convertAs(ids.adminA, client, randomUUID())).rejects.toMatchObject(REFUSED);
    expect(await invitationOf(ofOtherClient.id)).toEqual({ used_at: null, revoked_at: null });
    expect(await invitationOf(collaborator)).toEqual({ used_at: null, revoked_at: null });
  });

  it('does not tell another agency anything about an invitation: a foreign admin, pending or not, gets the answer of an absent one', async () => {
    const client = await freshClient();
    const pending = await invite(client, freshEmail());
    const used = await invite(client, freshEmail(), { used_at: new Date() });
    for (const target of [pending.id, used.id]) {
      await expect(convertAs(ids.adminB, client, target)).rejects.toMatchObject(REFUSED);
    }
    expect(await invitationOf(pending.id)).toEqual({ used_at: null, revoked_at: null });
  });

  it('refuses an invitation recorded under another agency than the one of its client, which no route creates', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const strange = await invite(client, email, { agency_id: ids.agencyB });
    await expect(convertAs(ids.adminA, client, strange.id)).rejects.toMatchObject(REFUSED);
    await expect(convertAs(ids.adminB, client, strange.id)).rejects.toMatchObject(REFUSED);
    expect(await invitationOf(strange.id)).toEqual({ used_at: null, revoked_at: null });
    expect(await accessByEmail(client, email)).toBeUndefined();
  });

  it('hands back the account that lost the address, so the route can end its sessions', async () => {
    const client = await freshClient();
    const account = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: account.id });
    const access = (await owner()('client_portal_accesses').where({ client_id: client, user_id: account.id }).first('id', 'email'))!;
    await owner()('auth.user').where({ id: account.id }).update({ email: freshEmail() });
    const old = await invite(client, access.email);

    expect(await convertAs(ids.adminA, client, old.id)).toMatchObject({ access_id: access.id, outcome: 'reactivated', unlinked_user_id: account.id, invitation_revoked: true });
    expect(await accessById(access.id)).toMatchObject({ user_id: null, status: 'active' });
  });

  it('asks cliente.convidar_usuario, which gives the access: cliente.remover_usuario and convite.cancelar are not enough', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const old = await invite(client, email);
    const remover = await w.personWith('cliente.remover_usuario');
    const canceller = await w.personWith('convite.cancelar');
    const resender = await w.personWith('convite.reenviar');
    for (const refused of [remover, canceller, resender]) {
      await expect(convertAs(refused, client, old.id), refused).rejects.toMatchObject(REFUSED);
    }
    expect(await invitationOf(old.id)).toEqual({ used_at: null, revoked_at: null });
    expect(await accessByEmail(client, email)).toBeUndefined();

    const inviter = await w.personWith('cliente.convidar_usuario');
    expect(await convertAs(inviter, client, old.id)).toMatchObject({ outcome: 'created', invitation_revoked: true });
  });

  it('refuses an archived client', async () => {
    const client = await freshClient();
    const old = await invite(client, freshEmail());
    await w.archiveClient(client);
    await expect(convertAs(ids.adminA, client, old.id)).rejects.toMatchObject(REFUSED);
    expect(await invitationOf(old.id)).toEqual({ used_at: null, revoked_at: null });
  });

  it('refuses a used, revoked or expired invitation even when its address already has the access (A0097 comes before already_active)', async () => {
    const client = await freshClient();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['used', { used_at: new Date() }],
      ['revoked', { revoked_at: new Date() }],
      ['expired', { expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 86_400_000) }]
    ];
    for (const [label, extra] of cases) {
      const email = freshEmail();
      await addAs(ids.adminA, client, email);
      const old = await invite(client, email, extra);
      await expect(convertAs(ids.adminA, client, old.id), label).rejects.toMatchObject(NOTHING_TO_RESEND);
    }
  });

  describe('whoever closes the invitation while the conversion waits for its lock wins, and the access just given goes with the rollback', () => {
    const waitUntilBlocked = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await owner().raw<{ rows: unknown[] }>(
          "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%convert_client_portal_invitation%' and pid <> pg_backend_pid()"
        );
        if (blocked.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The conversion never waited for the lock of the invitation.');
    };

    it.each([
      ['accepted', async (account: { id: string }) => ({ used_at: new Date(), accepted_by_user_id: account.id }), 0],
      ['cancelled', async () => ({ revoked_at: new Date() }), 0],
      ['expired', async () => ({}), 2500]
    ] as const)('%s', async (label, change, expiresInMs) => {
      const client = await freshClient();
      const account = await newUser();
      const old = await invite(client, account.email, expiresInMs > 0 ? { expires_at: new Date(Date.now() + expiresInMs) } : {});
      const holder = await owner().transaction();
      try {
        await holder.raw('select id from public.invitations where id = ?::uuid for update', [old.id]);
        const conversion = convertAs(ids.adminA, client, old.id);
        const outcome = conversion.then(() => 'converted', (error: { code?: string }) => error.code);
        await waitUntilBlocked();
        const patch = await change(account);
        if (Object.keys(patch).length > 0) await holder('invitations').where({ id: old.id }).update(patch);
        else await new Promise((resolve) => setTimeout(resolve, expiresInMs + 200));
        await holder.commit();
        expect(await outcome, label).toBe('A0097');
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
      }
      expect(await accessByEmail(client, account.email), label).toBeUndefined();
      expect(await eventCount('invitation.revoked', old.id), label).toBe(0);
    });
  });

  it('lets the invitation be accepted or converted, never both: two real transactions, repeated', async () => {
    for (let round = 0; round < 6; round += 1) {
      const client = await freshClient();
      const account = await newUser();
      const old = await invite(client, account.email);
      const results = await Promise.allSettled([
        convertAs(ids.adminA, client, old.id),
        call(account.id, 'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', old.tokenHash, account.id)
      ]);
      const state = await invitationOf(old.id);
      // A lost deadlock is the one retryable failure; whoever won left one access and an invitation closed once.
      for (const result of results) {
        if (result.status === 'rejected') expect(['A0001', 'A0097', '40P01']).toContain((result.reason as { code: string }).code);
      }
      expect(results.some((result) => result.status === 'fulfilled'), `round ${round}`).toBe(true);
      expect(Boolean(state.used_at) && Boolean(state.revoked_at), `round ${round}`).toBe(false);
      expect(await countAccesses(client), `round ${round}`).toBe(1);
    }
  });

  it('lets the access be removed or the invitation converted without leaving a live invitation behind: two real transactions, repeated', async () => {
    for (let round = 0; round < 6; round += 1) {
      const client = await freshClient();
      const email = freshEmail();
      const added = await addAs(ids.adminA, client, email);
      const old = await invite(client, email);
      const results = await Promise.allSettled([
        convertAs(ids.adminA, client, old.id),
        removeAs(ids.adminA, added.access_id)
      ]);
      for (const result of results) {
        if (result.status === 'rejected') expect(['A0097', '40P01']).toContain((result.reason as { code: string }).code);
      }
      // A removed access never keeps a pending invitation of its address: the invitation is gone either way, or both were rolled back.
      const access = await accessById(added.access_id);
      const state = await invitationOf(old.id);
      if (access.status === 'removed') expect(state.revoked_at, `round ${round}`).not.toBeNull();
    }
  });
});
