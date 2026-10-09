import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #290. A role holding only `convite.cancelar` could run `update invitations set revoked_at =
// null`: the policy checks the permission and nothing checks the direction of the change, so a
// revoked admin invitation became pending again and the original link made the invitee an admin
// with nobody holding `colaborador.atribuir_admin`. Everything here runs as `ageniza_app` with the
// user context the application publishes, and every refusal is checked against the final state of
// the row, never against "it did not throw".
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const ownerUser = randomUUID();
const adminUser = randomUUID();
const cancellerUser = randomUUID();
const resenderUser = randomUUID();
const convidarUser = randomUUID();
const clientInviterUser = randomUUID();
const outsiderUser = randomUUID();
const allUsers = [ownerUser, adminUser, cancellerUser, resenderUser, convidarUser, clientInviterUser, outsiderUser];

const emailOf = (id: string): string => `${id}@example.test`;
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
const futureDate = (): Date => new Date(Date.now() + 86_400_000);

let adminRoleId: string;
let productionRoleId: string;
const customRoleIds: string[] = [];
const createdInvitationIds: string[] = [];
let clientId: string;

type Rows<T> = { readonly rows: readonly T[] };

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

/** A fresh account per invitation: the pending-equivalent unique index forbids two live invitations for one e-mail. */
const makeInvitee = async (): Promise<string> => {
  const id = randomUUID();
  allUsers.push(id);
  await getOwner().knex('auth.user').insert({ id, name: `Invitee ${id}`, email: emailOf(id), emailVerified: true });
  return id;
};

const customRole = async (permissionKey: string): Promise<string> => {
  const id = randomUUID();
  customRoleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyA, key: `only-${permissionKey}-${id.slice(0, 8)}`, name: `Só ${permissionKey}`, is_system: false });
  await getOwner().knex('role_permissions').insert({ role_id: id, permission_key: permissionKey });
  return id;
};

interface InvitationFixture {
  readonly id: string;
  readonly token: string;
}

/** Inserted by the schema owner: it stands for an invitation the Owner legitimately created. */
const insertInvitation = async (input: {
  readonly purpose: 'collaborator_invite' | 'client_invite';
  readonly inviteeId: string;
  readonly roleId?: string;
  readonly revokedAt?: Date | null;
}): Promise<InvitationFixture> => {
  const id = randomUUID();
  const token = `token-${id}`;
  createdInvitationIds.push(id);
  await getOwner().knex('invitations').insert({
    id,
    agency_id: agencyA,
    purpose: input.purpose,
    email: emailOf(input.inviteeId),
    role_id: input.purpose === 'collaborator_invite' ? input.roleId : null,
    client_id: input.purpose === 'client_invite' ? clientId : null,
    token_hash: hashOf(token),
    expires_at: futureDate(),
    revoked_at: input.revokedAt ?? null
  });
  return { id, token };
};

const invitationState = async (id: string): Promise<{ revoked_at: Date | null; used_at: Date | null }> => {
  const row = await getOwner().knex('invitations').where({ id }).first<{ revoked_at: Date | null; used_at: Date | null }>('revoked_at', 'used_at');
  if (row === undefined) throw new Error(`Invitation ${id} not found.`);
  return row;
};

const revoke = (userId: string, invitationId: string): Promise<number> =>
  asUser(userId, (transaction) => transaction('invitations').where({ id: invitationId }).update({ revoked_at: new Date() }));

const accept = (token: string, userId: string): Promise<unknown> =>
  asUser(userId, (transaction) =>
    raw<Rows<{ status: string }>>(transaction, 'select * from app_private.accept_invitation(?, ?, ?, ?, ?)', [hashOf(token), userId, '2026-10-06', '2026-10-06', true])
  );

const membershipRole = async (agencyId: string, userId: string): Promise<string | undefined> => {
  const row = await getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: userId }).first<{ role_id: string }>('role_id');
  return row?.role_id;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const roles = await getOwner().knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'production']).select('id', 'key');
  adminRoleId = roles.find((role) => role.key === 'admin')!.id as string;
  productionRoleId = roles.find((role) => role.key === 'production')!.id as string;

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(allUsers.map((id) => ({ id, name: `User ${id}`, email: emailOf(id), emailVerified: true })));
    await transaction('agencies').insert([
      { id: agencyA, name: `Irreversible A ${agencyA}`, owner_user_id: ownerUser },
      { id: agencyB, name: `Irreversible B ${agencyB}` }
    ]);
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: ownerUser, role_id: adminRoleId },
      { agency_id: agencyA, user_id: adminUser, role_id: adminRoleId }
    ]);
  });
  clientId = randomUUID();
  await getOwner().knex('clients').insert({ id: clientId, agency_id: agencyA, name: `Irreversible Client ${clientId}` });

  const cancellerRole = await customRole('convite.cancelar');
  const resenderRole = await customRole('convite.reenviar');
  const convidarRole = await customRole('colaborador.convidar');
  const clientInviterRole = await customRole('cliente.convidar_usuario');
  await getOwner().knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: cancellerUser, role_id: cancellerRole },
    { agency_id: agencyA, user_id: resenderUser, role_id: resenderRole },
    { agency_id: agencyA, user_id: convidarUser, role_id: convidarRole },
    { agency_id: agencyA, user_id: clientInviterUser, role_id: clientInviterRole },
    { agency_id: agencyB, user_id: outsiderUser, role_id: adminRoleId }
  ]);
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('audit.events').whereIn('agency_id', [agencyA, agencyB]).delete();
      await transaction('invitations').whereIn('id', createdInvitationIds).delete();
      await transaction('legal_acceptances').whereIn('user_id', allUsers).delete();
      await transaction('client_memberships').where({ client_id: clientId }).delete();
      await transaction('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
      await transaction('role_permissions').whereIn('role_id', customRoleIds).delete();
      await transaction('roles').whereIn('id', customRoleIds).delete();
      await transaction('clients').where({ id: clientId }).delete();
      await transaction('agencies').whereIn('id', [agencyA, agencyB]).delete();
      await transaction('auth.user').whereIn('id', allUsers).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('invitation state only moves forward (#290)', () => {
  it('stops the full escalation: revoke an admin invite, try to un-revoke it, try to accept the original link', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: adminRoleId });

    // The legitimate half: a role holding only convite.cancelar can cancel.
    await expect(revoke(cancellerUser, invitation.id)).resolves.toBe(1);
    const revokedAt = (await invitationState(invitation.id)).revoked_at;
    expect(revokedAt).not.toBeNull();

    // The attack: the same role puts it back to pending.
    await expect(
      asUser(cancellerUser, (transaction) => transaction('invitations').where({ id: invitation.id }).update({ revoked_at: null }))
    ).rejects.toMatchObject({ code: '42501' });
    expect((await invitationState(invitation.id)).revoked_at).toEqual(revokedAt);

    // Even if the invitee still holds the original link, the invitation is dead: no membership, no admin.
    await expect(accept(invitation.token, invitee)).rejects.toMatchObject({ code: 'A0001' });
    expect(await membershipRole(agencyA, invitee)).toBeUndefined();
    expect((await invitationState(invitation.id)).used_at).toBeNull();
  });

  it('refuses every way a role can write the column back, from every role that may touch invitations', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId, revokedAt: new Date(Date.now() - 60_000) });
    const original = (await invitationState(invitation.id)).revoked_at;

    for (const actor of [cancellerUser, resenderUser, convidarUser, adminUser, ownerUser]) {
      // null, a fresh timestamp and a far-future one are all a change of a filled column.
      for (const next of [null, new Date(), new Date('2999-01-01T00:00:00Z')]) {
        await expect(
          asUser(actor, (transaction) => transaction('invitations').where({ id: invitation.id }).update({ revoked_at: next })),
          `${actor} -> ${String(next)}`
        ).rejects.toMatchObject({ code: '42501' });
      }
      expect((await invitationState(invitation.id)).revoked_at).toEqual(original);
    }
  });

  // Issue #302 (security review of PR #294, mutation T7). The guard has to be keyed on
  // `current_user`, never on the `app.user_id` GUC: `ageniza_app` can clear the GUC inside the SET
  // expression, and a guard keyed on it would skip the direction check while the bound actor still
  // satisfies the policy. Clearing the GUC inside the statement also proves the refusal comes from
  // the trigger -- its own message -- and not from the policy's "row-level security" one.
  it('keys its guard on current_user, not on the app.user_id GUC, even when the GUC is cleared inside the statement', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId, revokedAt: new Date(Date.now() - 60_000) });
    const original = (await invitationState(invitation.id)).revoked_at;

    const refusal = await asUser(cancellerUser, (transaction) => raw(transaction, `
      update public.invitations
         set revoked_at = (case when pg_catalog.set_config('app.user_id', '', true) is not null then null::timestamptz end)
       where id = ?::uuid
    `, [invitation.id])).catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      code: '42501',
      message: expect.stringContaining('A revoked invitation cannot be changed; create a new one.')
    });
    expect(String((refusal as Error).message)).not.toContain('row-level security');
    expect((await invitationState(invitation.id)).revoked_at).toEqual(original);
  });

  it('refuses the INSERT ... ON CONFLICT DO UPDATE route to the same column', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId, revokedAt: new Date(Date.now() - 60_000) });
    const original = (await invitationState(invitation.id)).revoked_at;

    await expect(asUser(convidarUser, (transaction) =>
      raw(transaction, `
        insert into public.invitations (agency_id, purpose, email, role_id, token_hash, expires_at)
        values (?::uuid, 'collaborator_invite', ?, ?::uuid, ?, now() + interval '1 day')
        on conflict (token_hash) do update set revoked_at = null
      `, [agencyA, emailOf(invitee), productionRoleId, hashOf(`token-${invitation.id}`)])
    )).rejects.toMatchObject({ code: '42501' });
    expect((await invitationState(invitation.id)).revoked_at).toEqual(original);
  });

  it('keeps a revoked portal invite revoked (the client archive revokes it, and nobody may bring it back)', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'client_invite', inviteeId: invitee, revokedAt: new Date(Date.now() - 60_000) });
    const original = (await invitationState(invitation.id)).revoked_at;

    for (const actor of [cancellerUser, clientInviterUser, adminUser]) {
      await expect(
        asUser(actor, (transaction) => transaction('invitations').where({ id: invitation.id }).update({ revoked_at: null }))
      ).rejects.toMatchObject({ code: '42501' });
    }
    expect((await invitationState(invitation.id)).revoked_at).toEqual(original);
    await expect(accept(invitation.token, invitee)).rejects.toMatchObject({ code: 'A0001' });
    expect(await getOwner().knex('client_memberships').where({ client_id: clientId, user_id: invitee }).select('id')).toEqual([]);
  });

  it('keeps used_at final too, even if a grant on it were ever added', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId });
    await accept(invitation.token, invitee);
    const used = (await invitationState(invitation.id)).used_at;
    expect(used).not.toBeNull();

    // As shipped, the column is not writable by ageniza_app at all.
    await expect(
      asUser(convidarUser, (transaction) => transaction('invitations').where({ id: invitation.id }).update({ used_at: null }))
    ).rejects.toThrow(/permission denied/);

    // The trigger is the second wall: grant the column inside a transaction that is always rolled
    // back, then try again as ageniza_app, so the test never leaves a grant behind.
    const rollback = new Error('rollback');
    await expect(getOwner().transaction(async (transaction) => {
      await raw(transaction, 'grant update (used_at) on public.invitations to ageniza_app', []);
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [convidarUser]);
      await raw(transaction, 'set local role ageniza_app', []);
      let refused: unknown;
      for (const next of [null, new Date()]) {
        try {
          await raw(transaction, 'savepoint attempt', []);
          await transaction('invitations').where({ id: invitation.id }).update({ used_at: next });
        } catch (error) {
          refused = error;
          await raw(transaction, 'rollback to savepoint attempt', []);
        }
        expect(refused, `used_at -> ${String(next)}`).toMatchObject({ code: '42501' });
        refused = undefined;
      }
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await invitationState(invitation.id)).used_at).toEqual(used);
  });

  it('leaves the legitimate flows working: cancel, resend (revoke then create another) and accept', async () => {
    const invitee = await makeInvitee();
    // Cancel: pending -> revoked, by the role that only cancels.
    const toCancel = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId });
    await expect(revoke(cancellerUser, toCancel.id)).resolves.toBe(1);
    expect((await invitationState(toCancel.id)).revoked_at).not.toBeNull();
    // Writing the same value back is not a change, so it is not refused either.
    const sameValue = (await invitationState(toCancel.id)).revoked_at;
    await expect(
      asUser(cancellerUser, (transaction) => transaction('invitations').where({ id: toCancel.id }).update({ revoked_at: sameValue }))
    ).resolves.toBe(1);

    // Operations is not the application role: the schema owner can still correct a row by hand.
    await expect(getOwner().knex('invitations').where({ id: toCancel.id }).update({ revoked_at: null })).resolves.toBe(1);
    await expect(getOwner().knex('invitations').where({ id: toCancel.id }).update({ revoked_at: new Date() })).resolves.toBe(1);

    // Resend: the role that only resends revokes the old invitation and creates the replacement.
    const toResend = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId });
    const replacementToken = `token-${randomUUID()}`;
    const replacementId = randomUUID();
    createdInvitationIds.push(replacementId);
    await asUser(resenderUser, async (transaction) => {
      expect(await transaction('invitations').where({ id: toResend.id }).update({ revoked_at: new Date() })).toBe(1);
      await transaction('invitations').insert({
        id: replacementId, agency_id: agencyA, purpose: 'collaborator_invite', email: emailOf(invitee), role_id: productionRoleId,
        token_hash: hashOf(replacementToken), expires_at: futureDate()
      });
    });
    expect((await invitationState(toResend.id)).revoked_at).not.toBeNull();
    expect(await invitationState(replacementId)).toEqual({ revoked_at: null, used_at: null });

    // Accept: the replacement works, the old link does not.
    await expect(accept(toResend.token, invitee)).rejects.toMatchObject({ code: 'A0001' });
    await expect(accept(replacementToken, invitee)).resolves.toBeDefined();
    expect((await invitationState(replacementId)).used_at).not.toBeNull();
    expect(await membershipRole(agencyA, invitee)).toBe(productionRoleId);
  });

  it('does not let a role delete the evidence either: a revoked invitation cannot be removed and re-created', async () => {
    const invitee = await makeInvitee();
    const invitation = await insertInvitation({ purpose: 'collaborator_invite', inviteeId: invitee, roleId: productionRoleId, revokedAt: new Date(Date.now() - 60_000) });
    // Issue #356 revokes DELETE on invitations: refused by the privilege, not by a RLS that filters to zero rows.
    await expect(asUser(cancellerUser, (transaction) => transaction('invitations').where({ id: invitation.id }).delete()))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table invitations') });
    expect(await getOwner().knex('invitations').where({ id: invitation.id }).select('id')).toHaveLength(1);
  });

  it('is a security invoker trigger with a fixed search_path, executable by nobody but its owner', async () => {
    const trigger = await getOwner().knex.raw<Rows<{ tgname: string; def: string }>>(`
      select t.tgname, pg_get_triggerdef(t.oid) as def
      from pg_trigger t
      where t.tgrelid = 'public.invitations'::regclass and not t.tgisinternal and t.tgname = 'invitations_state_forward_only'
    `);
    expect(trigger.rows).toHaveLength(1);
    expect(trigger.rows[0]!.def).toMatch(/BEFORE UPDATE ON public\.invitations FOR EACH ROW/);

    const routine = await getOwner().knex.raw<Rows<{ prosecdef: boolean; config: string; publicExecute: boolean }>>(`
      select p.prosecdef,
             coalesce(array_to_string(p.proconfig, ','), '') as config,
             has_function_privilege('public', p.oid, 'execute') as "publicExecute"
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'invitation_state_is_forward_only'
    `);
    expect(routine.rows).toHaveLength(1);
    expect(routine.rows[0]!.prosecdef).toBe(false);
    expect(routine.rows[0]!.config).toContain('search_path=');
    expect(routine.rows[0]!.publicExecute).toBe(false);
  });
});
